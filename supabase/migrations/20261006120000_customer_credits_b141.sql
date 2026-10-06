-- Customer receivables are separate from supplier payables.
create table private.credit_customers(
 id uuid primary key,outlet_id integer not null references public.outlets(id),
 name text not null check(length(btrim(name)) between 2 and 100),
 phone text not null check(length(phone)<=32 and phone ~ '^[+0-9 ()-]+$'),
 phone_digits text generated always as (regexp_replace(phone,'[^0-9]','','g')) stored,
 created_business_date date not null,created_by uuid not null references public.users(id),created_at timestamptz not null default now(),
 unique(outlet_id,phone_digits),unique(outlet_id,id),check(length(phone_digits) between 7 and 15));
create table private.customer_credit_months(
 outlet_id integer not null references public.outlets(id),period_month date not null,
 status text not null check(status in('CLOSED','REOPENED')),note text not null,
 closed_by uuid references public.users(id),closed_at timestamptz,primary key(outlet_id,period_month),
 check(period_month=date_trunc('month',period_month)::date));
create table private.customer_credit_balances(
 outlet_id integer not null,period_month date not null,customer_id uuid not null,
 balance numeric(14,2) not null check(balance>=0),primary key(outlet_id,period_month,customer_id),
 foreign key(outlet_id,customer_id) references private.credit_customers(outlet_id,id),
 foreign key(outlet_id,period_month) references private.customer_credit_months(outlet_id,period_month));
create table private.customer_credit_movements(
 id uuid primary key,outlet_id integer not null references public.outlets(id),customer_id uuid not null,
 business_date date not null,kind text not null check(kind in('ADD_CREDIT','RECEIVE_CUSTOMER')),
 amount numeric(14,2) not null check(amount>0),effect numeric(14,2) not null,note text not null,
 created_by uuid not null references public.users(id),created_at timestamptz not null default now(),
 voided_at timestamptz,voided_by uuid references public.users(id),void_reason text,
 foreign key(outlet_id,customer_id) references private.credit_customers(outlet_id,id));
create index customer_credit_movements_account_idx on private.customer_credit_movements(outlet_id,customer_id,business_date);
create table private.customer_credit_audit(
 request_id uuid primary key,outlet_id integer not null references public.outlets(id),actor_id uuid not null references public.users(id),
 action text not null,payload jsonb not null,before_record jsonb,result jsonb not null,created_at timestamptz not null default now());
create index customer_credit_audit_outlet_idx on private.customer_credit_audit(outlet_id,created_at);
alter table private.credit_customers enable row level security;
alter table private.customer_credit_months enable row level security;
alter table private.customer_credit_balances enable row level security;
alter table private.customer_credit_movements enable row level security;
alter table private.customer_credit_audit enable row level security;
revoke all on private.credit_customers,private.customer_credit_months,private.customer_credit_balances,private.customer_credit_movements,private.customer_credit_audit from public,anon,authenticated;

-- Reject excess collections, including backdated entries and corrections.
create function private.check_customer_credit_balance(p_outlet integer,p_customer uuid)
returns void language plpgsql set search_path='' as $$
declare baseline numeric:=0; closed_month date;
begin
 select b.balance,b.period_month into baseline,closed_month from private.customer_credit_balances b
 join private.customer_credit_months c using(outlet_id,period_month)
 where b.outlet_id=p_outlet and b.customer_id=p_customer and c.status='CLOSED'
 order by b.period_month desc limit 1;
 baseline:=coalesce(baseline,0);
 if exists(select 1 from (
  select baseline+sum(effect) over(order by business_date rows unbounded preceding) as balance
  from (select business_date,sum(effect) effect from private.customer_credit_movements
   where outlet_id=p_outlet and customer_id=p_customer and voided_at is null
   and (closed_month is null or business_date>=closed_month+interval '1 month') group by business_date) d) x
  where balance<0) then raise exception 'Payment exceeds customer credit balance; check the date and amount'; end if;
end $$;
revoke all on function private.check_customer_credit_balance(integer,uuid) from public,anon,authenticated;

create function private.get_customer_credits(p_outlet_id integer default null,p_month date default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare today date; selected date;
begin
 if auth.uid() is null or not coalesce(private.is_admin(),false) then raise exception 'Admin access required'; end if;
 if p_outlet_id is not null and not exists(select 1 from public.outlets where id=p_outlet_id) then raise exception 'Outlet not found'; end if;
 select coalesce(max(public.get_effective_business_day(o.id,now())),current_date) into today from public.outlets o where p_outlet_id is null or o.id=p_outlet_id;
 selected:=coalesce(p_month,date_trunc('month',today)::date);
 if selected<>date_trunc('month',selected)::date or selected>date_trunc('month',today)::date then raise exception 'Invalid reporting month'; end if;
 return (with scoped as(select id,name,least(public.get_effective_business_day(id,now()),(selected+interval '1 month - 1 day')::date) as as_of from public.outlets where p_outlet_id is null or id=p_outlet_id),
 accounts as(select o.id outlet_id,o.name outlet_name,v.id customer_id,v.name customer_name,v.phone,o.as_of,
  b.period_month confirmed_month,b.balance confirmed_balance,
  m.effect movements,coalesce(b.balance,0)+m.effect balance
 from scoped o join private.credit_customers v on v.outlet_id=o.id and v.created_business_date<=o.as_of
 left join lateral(select cb.period_month,cb.balance from private.customer_credit_balances cb join private.customer_credit_months cm using(outlet_id,period_month)
  where cb.outlet_id=o.id and cb.customer_id=v.id and cm.status='CLOSED' and (cb.period_month+interval '1 month - 1 day')::date<=o.as_of order by cb.period_month desc limit 1) b on true
 cross join lateral(select coalesce(sum(effect),0) effect from private.customer_credit_movements
  where outlet_id=o.id and customer_id=v.id and voided_at is null and business_date<=o.as_of
   and (b.period_month is null or business_date>=b.period_month+interval '1 month')) m)
 select jsonb_build_object('business_day',today,'month',selected,
  'revision',case when p_outlet_id is not null then (select count(*) from private.customer_credit_audit where outlet_id=p_outlet_id) end,
  'outlets',(select coalesce(jsonb_agg(to_jsonb(o) order by o.name),'[]'::jsonb) from scoped o),
  'customers',(select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'phone',v.phone) order by v.name),'[]'::jsonb) from private.credit_customers v join scoped o on o.id=v.outlet_id and v.created_business_date<=o.as_of),
  'accounts',(select coalesce(jsonb_agg(to_jsonb(a) order by a.customer_name,a.outlet_name),'[]'::jsonb) from accounts a),
  'month_states',(select coalesce(jsonb_agg(to_jsonb(c) order by c.period_month desc),'[]'::jsonb) from private.customer_credit_months c join scoped o on o.id=c.outlet_id),
  'movements',(select coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('customer_name',v.name,'phone',v.phone,'outlet_name',o.name) order by m.business_date desc,m.created_at desc),'[]'::jsonb) from private.customer_credit_movements m join scoped o on o.id=m.outlet_id join private.credit_customers v on v.id=m.customer_id where m.business_date>=selected and m.business_date<=o.as_of)));
end $$;

create function private.manage_customer_credits(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; outlet integer; req uuid; today date; month_day date; last_closed date; movement_day date;
 customer uuid; amount numeric; effect numeric; kind text; v_note text; before_data jsonb; result_data jsonb; prior private.customer_credit_audit; entry private.customer_credit_movements;
begin
 if auth.uid() is null or not coalesce(private.is_admin(),false) then raise exception 'Admin access required'; end if;
 actor:=private.actor_id();outlet:=(p_payload->>'outlet_id')::integer;req:=(p_payload->>'request_id')::uuid;v_note:=btrim(coalesce(p_payload->>'note',''));
 if outlet is null or req is null or length(v_note)<3 then raise exception 'Café, request ID and a note are required'; end if;
 perform 1 from public.outlets where id=outlet for update;if not found then raise exception 'Outlet not found'; end if;
 select * into prior from private.customer_credit_audit where request_id=req;
 if found then
  if prior.outlet_id<>outlet or prior.actor_id<>actor or prior.action<>p_action or prior.payload<>p_payload then raise exception 'Request ID already used'; end if;
  return prior.result;
 end if;
 if (p_payload->>'expected_revision')::bigint is distinct from (select count(*) from private.customer_credit_audit where outlet_id=outlet) then raise exception 'Credits changed; refresh before saving'; end if;
 today:=public.get_effective_business_day(outlet,now());
 select max(period_month) into last_closed from private.customer_credit_months where outlet_id=outlet and status='CLOSED';
 if p_action in('CUSTOMER','EDIT_CUSTOMER') then
  if length(btrim(coalesce(p_payload->>'name','')))<2 or length(btrim(p_payload->>'name'))>100
   or length(coalesce(p_payload->>'phone',''))>32 or coalesce(p_payload->>'phone','') !~ '^[+0-9 ()-]+$'
   or length(regexp_replace(coalesce(p_payload->>'phone',''),'[^0-9]','','g')) not between 7 and 15 then raise exception 'Enter a customer name and valid phone number'; end if;
  if p_action='CUSTOMER' then
   amount:=round(coalesce((p_payload->>'amount')::numeric,0),2);
   if amount<0 or amount>=1000000000000 then raise exception 'Invalid opening credit'; end if;
   insert into private.credit_customers(id,outlet_id,name,phone,created_business_date,created_by)
    values(req,outlet,btrim(p_payload->>'name'),btrim(p_payload->>'phone'),today,actor);
   customer:=req;
   if amount>0 then
    insert into private.customer_credit_movements(id,outlet_id,customer_id,business_date,kind,amount,effect,note,created_by)
     values(req,outlet,customer,today,'ADD_CREDIT',amount,amount,v_note,actor);
   end if;
  else
   customer:=(p_payload->>'customer_id')::uuid;
   select to_jsonb(c) into before_data from private.credit_customers c where c.id=customer and c.outlet_id=outlet for update;
   if not found then raise exception 'Customer not found in this café'; end if;
   update private.credit_customers set name=btrim(p_payload->>'name'),phone=btrim(p_payload->>'phone') where id=customer;
  end if;
  result_data:=jsonb_build_object('customer_id',customer,'action',p_action);
 elsif p_action='MOVEMENT' then
  customer:=(p_payload->>'customer_id')::uuid;movement_day:=(p_payload->>'business_date')::date;amount:=round((p_payload->>'amount')::numeric,2);kind:=p_payload->>'kind';
  if customer is null or not exists(select 1 from private.credit_customers where id=customer and outlet_id=outlet) then raise exception 'Customer not found'; end if;
  if movement_day is null or movement_day>today or movement_day<(select created_business_date from private.credit_customers where id=customer) or (last_closed is not null and movement_day<last_closed+interval '1 month') then raise exception 'Movement date is future or in a closed period'; end if;
  if amount is null or amount<=0 or amount>=1000000000000 or kind not in('ADD_CREDIT','RECEIVE_CUSTOMER') or kind is null then raise exception 'Invalid movement amount or type'; end if;
  effect:=case when kind='RECEIVE_CUSTOMER' then -amount else amount end;
  insert into private.customer_credit_movements(id,outlet_id,customer_id,business_date,kind,amount,effect,note,created_by) values(req,outlet,customer,movement_day,kind,amount,effect,v_note,actor);
  perform private.check_customer_credit_balance(outlet,customer);
  result_data:=jsonb_build_object('movement_id',req,'action','MOVEMENT');
 elsif p_action='VOID' then
  select * into entry from private.customer_credit_movements where id=(p_payload->>'movement_id')::uuid and outlet_id=outlet for update;
  if not found or entry.voided_at is not null then raise exception 'Movement unavailable or already voided'; end if;
  if last_closed is not null and entry.business_date<last_closed+interval '1 month' then raise exception 'Reopen the closed period before correcting this movement'; end if;
  before_data:=to_jsonb(entry);update private.customer_credit_movements set voided_at=now(),voided_by=actor,void_reason=v_note where id=entry.id;
  perform private.check_customer_credit_balance(outlet,entry.customer_id);
  result_data:=jsonb_build_object('movement_id',entry.id,'action','VOID');
 elsif p_action in('CLOSE','REOPEN') then
  month_day:=(p_payload->>'month')::date;
  if month_day is null or month_day<>date_trunc('month',month_day)::date or month_day>=date_trunc('month',today)::date then raise exception 'Choose a completed calendar month'; end if;
  select jsonb_build_object('state',to_jsonb(c),'balances',(select jsonb_agg(to_jsonb(b) order by b.customer_id) from private.customer_credit_balances b where b.outlet_id=outlet and b.period_month=month_day)) into before_data from private.customer_credit_months c where c.outlet_id=outlet and c.period_month=month_day;
  if p_action='REOPEN' then
   if last_closed is distinct from month_day then raise exception 'Only the latest closed month can be reopened'; end if;
   update private.customer_credit_months set status='REOPENED',note=v_note||' | Reopened: '||private.customer_credit_months.note where outlet_id=outlet and period_month=month_day;
  else
   if last_closed is not null and month_day<=last_closed then raise exception 'Month already closed or older than the latest closing'; end if;
   if jsonb_typeof(p_payload->'balances') is distinct from 'array' then raise exception 'Confirmed customer balances required'; end if;
   if (select count(*) from jsonb_to_recordset(p_payload->'balances') x(customer_id uuid,balance numeric))<>(select count(*) from private.credit_customers where outlet_id=outlet and created_business_date<month_day+interval '1 month')
    or exists(select 1 from jsonb_to_recordset(p_payload->'balances') x(customer_id uuid,balance numeric) where x.balance is null or x.balance<0 or x.balance>=1000000000000 or not exists(select 1 from private.credit_customers v where v.id=x.customer_id and v.outlet_id=outlet and v.created_business_date<month_day+interval '1 month'))
    or exists(select customer_id from jsonb_to_recordset(p_payload->'balances') x(customer_id uuid,balance numeric) group by customer_id having count(*)>1) then raise exception 'Confirm every customer exactly once; enter zero for settled customers'; end if;
   insert into private.customer_credit_months(outlet_id,period_month,status,note,closed_by,closed_at) values(outlet,month_day,'CLOSED',v_note,actor,now())
    on conflict(outlet_id,period_month) do update set status='CLOSED',note=excluded.note,closed_by=excluded.closed_by,closed_at=excluded.closed_at;
   delete from private.customer_credit_balances where outlet_id=outlet and period_month=month_day;
   insert into private.customer_credit_balances(outlet_id,period_month,customer_id,balance) select outlet,month_day,x.customer_id,round(x.balance,2) from jsonb_to_recordset(p_payload->'balances') x(customer_id uuid,balance numeric);
  end if;
  for customer in select id from private.credit_customers where outlet_id=outlet loop perform private.check_customer_credit_balance(outlet,customer); end loop;
  result_data:=jsonb_build_object('action',p_action,'month',month_day);
 else raise exception 'Unknown credit action';
 end if;
 insert into private.customer_credit_audit(request_id,outlet_id,actor_id,action,payload,before_record,result) values(req,outlet,actor,p_action,p_payload,before_data,result_data);
 return result_data;
end $$;
revoke all on function private.get_customer_credits(integer,date),private.manage_customer_credits(text,jsonb) from public,anon;
grant execute on function private.get_customer_credits(integer,date),private.manage_customer_credits(text,jsonb) to authenticated;
create function public.get_customer_credits(p_outlet_id integer default null,p_month date default null) returns jsonb language sql stable security invoker set search_path='' as $$select private.get_customer_credits(p_outlet_id,p_month)$$;
create function public.manage_customer_credits(p_action text,p_payload jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.manage_customer_credits(p_action,p_payload)$$;
revoke all on function public.get_customer_credits(integer,date),public.manage_customer_credits(text,jsonb) from public,anon;
grant execute on function public.get_customer_credits(integer,date),public.manage_customer_credits(text,jsonb) to authenticated;
create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $$select jsonb_build_object('schema_build',141)$$;
grant execute on function public.get_app_release() to anon,authenticated;
