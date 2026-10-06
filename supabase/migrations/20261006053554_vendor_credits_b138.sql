-- Supplier balances are confirmed manually each month; purchases are not assumed complete.
create table private.vendor_credit_months(
 outlet_id integer not null references public.outlets(id),period_month date not null,
 status text not null check(status in('CLOSED','REOPENED')),note text not null,
 closed_by uuid references public.users(id),closed_at timestamptz,primary key(outlet_id,period_month),
 check(period_month=date_trunc('month',period_month)::date));
create table private.vendor_credit_balances(
 outlet_id integer not null,period_month date not null,vendor_id integer not null references public.vendors(id),
 balance numeric(14,2) not null,primary key(outlet_id,period_month,vendor_id),
 foreign key(outlet_id,period_month) references private.vendor_credit_months(outlet_id,period_month));
create table private.vendor_credit_movements(
 id uuid primary key,outlet_id integer not null references public.outlets(id),vendor_id integer not null references public.vendors(id),
 business_date date not null,kind text not null check(kind in('PAY_VENDOR','RECEIVE_VENDOR','ADD_PAYABLE','ADD_RECEIVABLE')),
 amount numeric(14,2) not null check(amount>0),effect numeric(14,2) not null,note text not null,
 created_by uuid not null references public.users(id),created_at timestamptz not null default now(),voided_at timestamptz,voided_by uuid references public.users(id),void_reason text);
create index vendor_credit_movements_account_idx on private.vendor_credit_movements(outlet_id,vendor_id,business_date);
create table private.vendor_credit_audit(
 request_id uuid primary key,outlet_id integer not null references public.outlets(id),actor_id uuid not null references public.users(id),
 action text not null,payload jsonb not null,before_record jsonb,result jsonb not null,created_at timestamptz not null default now());
create index vendor_credit_audit_outlet_idx on private.vendor_credit_audit(outlet_id,created_at);
alter table private.vendor_credit_months enable row level security;
alter table private.vendor_credit_balances enable row level security;
alter table private.vendor_credit_movements enable row level security;
alter table private.vendor_credit_audit enable row level security;
revoke all on private.vendor_credit_months,private.vendor_credit_balances,private.vendor_credit_movements,private.vendor_credit_audit from public,anon,authenticated;

create function private.get_vendor_credits(p_outlet_id integer default null,p_month date default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare today date; selected date;
begin
 if auth.uid() is null or not coalesce(private.is_admin(),false) then raise exception 'Admin access required'; end if;
 if p_outlet_id is not null and not exists(select 1 from public.outlets where id=p_outlet_id) then raise exception 'Outlet not found'; end if;
 select coalesce(max(public.get_effective_business_day(o.id,now())),current_date) into today from public.outlets o where p_outlet_id is null or o.id=p_outlet_id;
 selected:=coalesce(p_month,date_trunc('month',today)::date);
 if selected<>date_trunc('month',selected)::date or selected>date_trunc('month',today)::date then raise exception 'Invalid reporting month'; end if;
 return (with scoped as(select id,name,least(public.get_effective_business_day(id,now()),(selected+interval '1 month - 1 day')::date) as as_of from public.outlets where p_outlet_id is null or id=p_outlet_id),
 accounts as(select o.id as outlet_id,o.name as outlet_name,v.id as vendor_id,v.name as vendor_name,o.as_of,
  b.period_month as confirmed_month,b.balance as confirmed_balance,
  (select coalesce(sum(m.effect),0) from private.vendor_credit_movements m where m.outlet_id=o.id and m.vendor_id=v.id and m.voided_at is null and m.business_date>(b.period_month+interval '1 month - 1 day')::date and m.business_date<=o.as_of) as movements,
  case when b.period_month is not null then b.balance+(select coalesce(sum(m.effect),0) from private.vendor_credit_movements m where m.outlet_id=o.id and m.vendor_id=v.id and m.voided_at is null and m.business_date>(b.period_month+interval '1 month - 1 day')::date and m.business_date<=o.as_of) end as balance
 from scoped o cross join public.vendors v left join lateral(
  select cb.period_month,cb.balance from private.vendor_credit_balances cb join private.vendor_credit_months cm using(outlet_id,period_month)
  where cb.outlet_id=o.id and cb.vendor_id=v.id and cm.status='CLOSED' and (cb.period_month+interval '1 month - 1 day')::date<=o.as_of order by cb.period_month desc limit 1) b on true)
 select jsonb_build_object('business_day',today,'month',selected,
  'revision',case when p_outlet_id is not null then (select count(*) from private.vendor_credit_audit where outlet_id=p_outlet_id) end,
  'outlets',(select coalesce(jsonb_agg(to_jsonb(o) order by o.name),'[]'::jsonb) from scoped o),
  'vendors',(select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'name',v.name) order by v.name),'[]'::jsonb) from public.vendors v),
  'accounts',(select coalesce(jsonb_agg(to_jsonb(a) order by a.vendor_name,a.outlet_name),'[]'::jsonb) from accounts a),
  'month_states',(select coalesce(jsonb_agg(to_jsonb(c) order by c.period_month desc),'[]'::jsonb) from private.vendor_credit_months c join scoped o on o.id=c.outlet_id),
  'movements',(select coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('vendor_name',v.name,'outlet_name',o.name) order by m.business_date desc,m.created_at desc),'[]'::jsonb) from private.vendor_credit_movements m join scoped o on o.id=m.outlet_id join public.vendors v on v.id=m.vendor_id where m.business_date>=selected and m.business_date<=o.as_of)));
end $$;

create function private.manage_vendor_credits(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; outlet integer; req uuid; today date; month_day date; last_closed date; movement_day date;
 vendor integer; amount numeric; effect numeric; kind text; v_note text; before_data jsonb; result_data jsonb; prior private.vendor_credit_audit; entry private.vendor_credit_movements;
begin
 if auth.uid() is null or not coalesce(private.is_admin(),false) then raise exception 'Admin access required'; end if;
 actor:=private.actor_id();outlet:=(p_payload->>'outlet_id')::integer;req:=(p_payload->>'request_id')::uuid;v_note:=btrim(coalesce(p_payload->>'note',''));
 if outlet is null or req is null or length(v_note)<3 then raise exception 'Café, request ID and a note are required'; end if;
 perform 1 from public.outlets where id=outlet for update;if not found then raise exception 'Outlet not found'; end if;
 select * into prior from private.vendor_credit_audit where request_id=req;
 if found then
  if prior.outlet_id<>outlet or prior.actor_id<>actor or prior.action<>p_action or prior.payload<>p_payload then raise exception 'Request ID already used'; end if;
  return prior.result;
 end if;
 if (p_payload->>'expected_revision')::bigint is distinct from (select count(*) from private.vendor_credit_audit where outlet_id=outlet) then raise exception 'Credits changed; refresh before saving'; end if;
 today:=public.get_effective_business_day(outlet,now());
 select max(period_month) into last_closed from private.vendor_credit_months where outlet_id=outlet and status='CLOSED';
 if p_action='MOVEMENT' then
  vendor:=(p_payload->>'vendor_id')::integer;movement_day:=(p_payload->>'business_date')::date;amount:=round((p_payload->>'amount')::numeric,2);kind:=p_payload->>'kind';
  if vendor is null or not exists(select 1 from public.vendors where id=vendor) then raise exception 'Vendor not found'; end if;
  if movement_day is null or movement_day>today or (last_closed is not null and movement_day<last_closed+interval '1 month') then raise exception 'Movement date is future or in a closed period'; end if;
  if amount is null or amount<=0 or amount>=1000000000000 or kind not in('PAY_VENDOR','RECEIVE_VENDOR','ADD_PAYABLE','ADD_RECEIVABLE') or kind is null then raise exception 'Invalid movement amount or type'; end if;
  effect:=case when kind in('PAY_VENDOR','ADD_RECEIVABLE') then -amount else amount end;
  insert into private.vendor_credit_movements(id,outlet_id,vendor_id,business_date,kind,amount,effect,note,created_by) values(req,outlet,vendor,movement_day,kind,amount,effect,v_note,actor);
  result_data:=jsonb_build_object('movement_id',req,'action','MOVEMENT');
 elsif p_action='VOID' then
  select * into entry from private.vendor_credit_movements where id=(p_payload->>'movement_id')::uuid and outlet_id=outlet for update;
  if not found or entry.voided_at is not null then raise exception 'Movement unavailable or already voided'; end if;
  if last_closed is not null and entry.business_date<last_closed+interval '1 month' then raise exception 'Reopen the closed period before correcting this movement'; end if;
  before_data:=to_jsonb(entry);update private.vendor_credit_movements set voided_at=now(),voided_by=actor,void_reason=v_note where id=entry.id;
  result_data:=jsonb_build_object('movement_id',entry.id,'action','VOID');
 elsif p_action in('CLOSE','REOPEN') then
  month_day:=(p_payload->>'month')::date;
  if month_day is null or month_day<>date_trunc('month',month_day)::date or month_day>=date_trunc('month',today)::date then raise exception 'Choose a completed calendar month'; end if;
  select jsonb_build_object('state',to_jsonb(c),'balances',(select jsonb_agg(to_jsonb(b) order by b.vendor_id) from private.vendor_credit_balances b where b.outlet_id=outlet and b.period_month=month_day)) into before_data from private.vendor_credit_months c where c.outlet_id=outlet and c.period_month=month_day;
  if p_action='REOPEN' then
   if last_closed is distinct from month_day then raise exception 'Only the latest closed month can be reopened'; end if;
   update private.vendor_credit_months set status='REOPENED',note=v_note||' | Reopened: '||private.vendor_credit_months.note where outlet_id=outlet and period_month=month_day;
  else
   if last_closed is not null and month_day<=last_closed then raise exception 'Month already closed or older than the latest closing'; end if;
   if jsonb_typeof(p_payload->'balances') is distinct from 'array' then raise exception 'Confirmed vendor balances required'; end if;
   if (select count(*) from jsonb_to_recordset(p_payload->'balances') x(vendor_id integer,balance numeric))<>(select count(*) from public.vendors)
    or exists(select 1 from jsonb_to_recordset(p_payload->'balances') x(vendor_id integer,balance numeric) where x.balance is null or abs(x.balance)>=1000000000000 or not exists(select 1 from public.vendors v where v.id=x.vendor_id))
    or exists(select vendor_id from jsonb_to_recordset(p_payload->'balances') x(vendor_id integer,balance numeric) group by vendor_id having count(*)>1) then raise exception 'Confirm every vendor exactly once; enter zero for settled vendors'; end if;
   insert into private.vendor_credit_months(outlet_id,period_month,status,note,closed_by,closed_at) values(outlet,month_day,'CLOSED',v_note,actor,now())
    on conflict(outlet_id,period_month) do update set status='CLOSED',note=excluded.note,closed_by=excluded.closed_by,closed_at=excluded.closed_at;
   delete from private.vendor_credit_balances where outlet_id=outlet and period_month=month_day;
   insert into private.vendor_credit_balances(outlet_id,period_month,vendor_id,balance) select outlet,month_day,x.vendor_id,round(x.balance,2) from jsonb_to_recordset(p_payload->'balances') x(vendor_id integer,balance numeric);
  end if;
  result_data:=jsonb_build_object('action',p_action,'month',month_day);
 else raise exception 'Unknown credit action';
 end if;
 insert into private.vendor_credit_audit(request_id,outlet_id,actor_id,action,payload,before_record,result) values(req,outlet,actor,p_action,p_payload,before_data,result_data);
 return result_data;
end $$;
revoke all on function private.get_vendor_credits(integer,date),private.manage_vendor_credits(text,jsonb) from public,anon;
grant execute on function private.get_vendor_credits(integer,date),private.manage_vendor_credits(text,jsonb) to authenticated;
create function public.get_vendor_credits(p_outlet_id integer default null,p_month date default null) returns jsonb language sql stable security invoker set search_path='' as $$select private.get_vendor_credits(p_outlet_id,p_month)$$;
create function public.manage_vendor_credits(p_action text,p_payload jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.manage_vendor_credits(p_action,p_payload)$$;
revoke all on function public.get_vendor_credits(integer,date),public.manage_vendor_credits(text,jsonb) from public,anon;
grant execute on function public.get_vendor_credits(integer,date),public.manage_vendor_credits(text,jsonb) to authenticated;
create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $$select jsonb_build_object('schema_build',138)$$;
grant execute on function public.get_app_release() to anon,authenticated;
