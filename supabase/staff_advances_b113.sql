-- B113: staff advances have separate approval, disbursement, and payroll posting.
create table public.staff_advance_requests (
  id uuid primary key default gen_random_uuid(),
  staff_id integer not null references public.staff(id),
  outlet_id integer not null references public.outlets(id),
  amount numeric(12,2) not null check (amount > 0),
  installments integer not null check (installments between 1 and 12),
  note text not null default '',
  status text not null default 'REQUESTED' check (status in ('REQUESTED','APPROVED','REJECTED','PAID')),
  requested_by uuid not null references public.users(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references public.users(id),
  decided_at timestamptz,
  decision_note text,
  paid_by uuid references public.users(id),
  paid_at timestamptz,
  business_date date,
  mode text check (mode in ('Cash','UPI')),
  first_period date,
  constraint advance_paid_fields check (
    (status = 'PAID' and paid_by is not null and paid_at is not null and business_date is not null and mode is not null and first_period is not null)
    or (status <> 'PAID' and paid_by is null and paid_at is null and business_date is null and mode is null and first_period is null)
  )
);
create index staff_advances_staff on public.staff_advance_requests(staff_id,status,first_period);
create index staff_advances_daily on public.staff_advance_requests(outlet_id,business_date) where status='PAID';

create table public.staff_advance_deductions (
  advance_id uuid not null references public.staff_advance_requests(id),
  period_start date not null,
  amount numeric(12,2) not null check (amount > 0),
  salary_record_id varchar not null references public.salary_records(id),
  posted_at timestamptz not null default now(),
  primary key (advance_id,period_start)
);
create index staff_advance_deductions_salary on public.staff_advance_deductions(salary_record_id);

alter table public.staff_advance_requests enable row level security;
alter table public.staff_advance_deductions enable row level security;
grant select on public.staff_advance_requests,public.staff_advance_deductions to authenticated;
create policy advance_requests_visible on public.staff_advance_requests for select to authenticated
  using ((select private.is_admin()) or staff_id=(select private.actor_staff_id())
    or ((select private.is_manager()) and outlet_id=(select private.actor_outlet())));
create policy advance_deductions_visible on public.staff_advance_deductions for select to authenticated
  using (exists (select 1 from public.staff_advance_requests a where a.id=advance_id));
-- No Data API insert/update/delete grants or policies: all transitions use guarded RPCs.

create function public.request_staff_advance(p_amount numeric,p_installments integer,p_note text default '')
returns public.staff_advance_requests language plpgsql security definer set search_path='' as $$
declare v_actor public.users;v_staff public.staff;v_row public.staff_advance_requests;
begin
  select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;
  if not found or v_actor.staff_id is null then raise exception 'Linked staff account required';end if;
  select * into v_staff from public.staff where id=v_actor.staff_id and active=true;
  if not found then raise exception 'Active staff record required';end if;
  if p_amount is null or p_amount<=0 or p_amount>=10000000000 or p_amount<>round(p_amount,2) then raise exception 'Enter a valid amount';end if;
  if p_installments is null or p_installments not between 1 and 12 then raise exception 'Choose 1 to 12 installments';end if;
  if length(coalesce(p_note,''))>500 then raise exception 'Note is too long';end if;
  insert into public.staff_advance_requests(staff_id,outlet_id,amount,installments,note,requested_by)
  values(v_staff.id,v_staff.outlet_id,p_amount,p_installments,coalesce(p_note,''),v_actor.id) returning * into v_row;
  return v_row;
end $$;

create function public.decide_staff_advance(p_id uuid,p_approve boolean,p_note text default '')
returns public.staff_advance_requests language plpgsql security definer set search_path='' as $$
declare v_actor public.users;v_row public.staff_advance_requests;v_owner boolean;
begin
  select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;
  if not found then raise exception 'Authenticated user required';end if;
  select * into v_row from public.staff_advance_requests where id=p_id for update;
  if not found or v_row.status<>'REQUESTED' then raise exception 'Request is not pending';end if;
  if p_approve is null then raise exception 'Decision is required';end if;
  v_owner:=coalesce(v_actor.access_class,'')='ADMIN';
  if v_actor.staff_id=v_row.staff_id then raise exception 'You cannot approve your own advance';end if;
  if not v_owner and (v_actor.role not in ('Manager','Ops Manager') or v_actor.outlet_id<>v_row.outlet_id or v_row.amount>500)
    then raise exception 'Owner approval required';end if;
  if length(coalesce(p_note,''))>500 then raise exception 'Note is too long';end if;
  update public.staff_advance_requests set status=case when p_approve then 'APPROVED' else 'REJECTED' end,
    decided_by=v_actor.id,decided_at=now(),decision_note=coalesce(p_note,'') where id=p_id returning * into v_row;
  return v_row;
end $$;

create function public.pay_staff_advance(p_id uuid,p_mode text)
returns public.staff_advance_requests language plpgsql security definer set search_path='' as $$
declare v_actor public.users;v_row public.staff_advance_requests;v_day date;v_summary public.daily_summaries;
begin
  select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;
  if not found then raise exception 'Authenticated user required';end if;
  select * into v_row from public.staff_advance_requests where id=p_id for update;
  if not found or v_row.status<>'APPROVED' then raise exception 'Advance must be approved and unpaid';end if;
  if coalesce(v_actor.access_class,'')<>'ADMIN' and (v_actor.role not in ('Manager','Ops Manager') or v_actor.outlet_id<>v_row.outlet_id)
    then raise exception 'Manager or owner of this café required';end if;
  if v_actor.staff_id=v_row.staff_id then raise exception 'You cannot record your own payout';end if;
  if p_mode not in ('Cash','UPI') or p_mode is null then raise exception 'Choose Cash or UPI';end if;
  v_day:=public.get_effective_business_day(v_row.outlet_id,now());
  select * into v_summary from public.daily_summaries where outlet_id=v_row.outlet_id and business_date=v_day for update;
  if found and v_summary.is_closed then raise exception 'Daily Summary is closed; reopen it before paying';end if;
  update public.staff_advance_requests set status='PAID',paid_by=v_actor.id,paid_at=now(),mode=p_mode,
    business_date=v_day,first_period=date_trunc('month',v_day)::date where id=p_id returning * into v_row;
  if v_summary.id is not null then
    update public.daily_summaries set expected_cash=public.get_expected_cash(v_summary.id),
      short_excess=physical_cash-public.get_expected_cash(v_summary.id) where id=v_summary.id;
  end if;
  return v_row;
end $$;

-- The disbursement is a staff cash movement, never a sales expense.
create or replace function public.get_expected_cash(p_summary_id varchar) returns numeric
language sql stable set search_path='' as $$
  select coalesce(ds.opening_cash_actual,0)+coalesce(ds.cash_sale,0)
    -coalesce((select sum(amount) from public.summary_expenses where summary_id=ds.id and mode='Cash'),0)
    -coalesce((select sum(amount) from public.summary_vendor_payouts where summary_id=ds.id and mode='Cash'),0)
    -coalesce((select sum(amount) from public.summary_staff_payouts where summary_id=ds.id and mode='Cash'),0)
    -coalesce((select sum(amount) from public.staff_advance_requests where outlet_id=ds.outlet_id
      and business_date=ds.business_date and status='PAID' and mode='Cash'),0)
  from public.daily_summaries ds where ds.id=p_summary_id
$$;

-- Scheduled-to-date minus amounts posted in earlier payroll periods. This also
-- carries missed installments forward and leaves the current period re-finalizable.
create function private.advance_due(p_staff_id integer,p_period_start date)
returns table(advance_id uuid,due numeric,balance numeric) language sql stable security definer set search_path='' as $$
  select a.id,
    greatest(0,least(a.amount,
      case when p_period_start<a.first_period then 0
           when ((extract(year from age(p_period_start,a.first_period))::int*12
                 +extract(month from age(p_period_start,a.first_period))::int)+1)>=a.installments then a.amount
           else round(a.amount/a.installments,2)*
             ((extract(year from age(p_period_start,a.first_period))::int*12
              +extract(month from age(p_period_start,a.first_period))::int)+1) end)
      -coalesce((select sum(d.amount) from public.staff_advance_deductions d
        where d.advance_id=a.id and d.period_start<p_period_start),0)) as due,
    greatest(0,a.amount-coalesce((select sum(d.amount) from public.staff_advance_deductions d
      where d.advance_id=a.id and d.period_start<p_period_start),0)) as balance
  from public.staff_advance_requests a where a.staff_id=p_staff_id and a.status='PAID'
    and a.first_period<=p_period_start
  order by a.paid_at,a.id
$$;
revoke all on function private.advance_due(integer,date) from public,anon,authenticated;

create function public.get_salary_estimate_v2(p_staff_id integer,p_start date,p_end date)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_est jsonb;v_due numeric;v_balance numeric;v_take numeric;
begin
  -- Existing RPC performs the own-record/owner authorization check.
  v_est:=public.get_salary_estimate(p_staff_id,p_start,p_end);
  select coalesce(sum(due),0),coalesce(sum(balance),0) into v_due,v_balance
    from private.advance_due(p_staff_id,date_trunc('month',p_start)::date);
  v_take:=least(v_due,greatest(0,(v_est->>'estimated_net')::numeric));
  return v_est||jsonb_build_object('advance_installment_due',v_due,'advance_installment_deduction',v_take,
    'advance_balance_before_payroll',v_balance,'estimated_net',(v_est->>'estimated_net')::numeric-v_take);
end $$;

create function public.finalize_salary_record_v2(p_staff_id integer,p_period_start date,p_period_end date,p_pay_date date,p_user_id uuid)
returns public.salary_records language plpgsql security definer set search_path='' as $$
declare v_actor public.users;v_staff public.staff;v_row public.salary_records;v_due record;v_left numeric;v_take numeric;v_total numeric:=0;v_est jsonb;
begin
  select * into v_actor from public.users where auth_user_id=auth.uid() and active=true and id=p_user_id;
  if not found or coalesce(v_actor.access_class,'')<>'ADMIN' then raise exception 'Owner access required';end if;
  -- Serializes overlapping payroll runs for this staff member.
  select * into v_staff from public.staff where id=p_staff_id for update;
  if not found then raise exception 'Staff not found';end if;
  if p_period_start<>date_trunc('month',p_period_start)::date or p_period_end<p_period_start
    then raise exception 'Invalid payroll period';end if;
  if p_period_end<>(date_trunc('month',p_period_start)+interval '1 month - 1 day')::date
    or p_period_end>=public.get_effective_business_day(v_staff.outlet_id,now())
    then raise exception 'Payroll can only be finalized after a complete month';end if;
  if exists(select 1 from public.salary_records where staff_id=p_staff_id and period_start>p_period_start)
    then raise exception 'A later payroll has already been finalized; reconcile it before revising an older period';end if;
  delete from public.staff_advance_deductions where period_start=p_period_start and advance_id in
    (select id from public.staff_advance_requests where staff_id=p_staff_id);
  v_row:=public.finalize_salary_record(p_staff_id,p_period_start,p_period_end,p_pay_date,p_user_id);
  v_left:=greatest(0,v_row.net_salary);
  for v_due in select * from private.advance_due(p_staff_id,p_period_start) where due>0 loop
    v_take:=least(v_due.due,v_due.balance,v_left);
    if v_take>0 then
      insert into public.staff_advance_deductions(advance_id,period_start,amount,salary_record_id)
        values(v_due.advance_id,p_period_start,v_take,v_row.id);
      v_total:=v_total+v_take;v_left:=v_left-v_take;
    end if;
  end loop;
  update public.salary_records set petty_advance=petty_advance+v_total,
    net_salary=net_salary-v_total where id=v_row.id returning * into v_row;
  return v_row;
end $$;

revoke all on function public.request_staff_advance(numeric,integer,text),
  public.decide_staff_advance(uuid,boolean,text),public.pay_staff_advance(uuid,text),
  public.get_salary_estimate_v2(integer,date,date),
  public.finalize_salary_record_v2(integer,date,date,date,uuid) from public,anon;
grant execute on function public.request_staff_advance(numeric,integer,text),
  public.decide_staff_advance(uuid,boolean,text),public.pay_staff_advance(uuid,text),
  public.get_salary_estimate_v2(integer,date,date),
  public.finalize_salary_record_v2(integer,date,date,date,uuid) to authenticated;
