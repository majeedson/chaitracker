-- Owner-confirmed historical salaries. Private provenance and before/after snapshots.
create table private.salary_sheet_imports(
 batch_id uuid not null,spreadsheet_id text not null,source_row integer not null,
 salary_record_id varchar not null,source_values jsonb not null,disposition text not null,
 before_record jsonb,after_record jsonb,imported_at timestamptz not null default now(),
 primary key(batch_id,source_row)
);
alter table private.salary_sheet_imports enable row level security;
revoke all on private.salary_sheet_imports from public,anon,authenticated;
create function private.import_salary_sheet(p_batch uuid,p_spreadsheet text,p_plan jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare item jsonb;v_record public.salary_records;v_current jsonb;v_after jsonb;
 v_changed integer:=0;v_selected integer:=0;v_inserted integer:=0;link jsonb;
begin
 if jsonb_typeof(p_plan)<>'array' or jsonb_array_length(p_plan)=0 then raise exception 'Salary plan required';end if;
 if exists(select 1 from private.salary_sheet_imports where batch_id=p_batch) then
  if exists(select 1 from jsonb_array_elements(p_plan) p where not exists(select 1 from private.salary_sheet_imports a
    where a.batch_id=p_batch and a.spreadsheet_id=p_spreadsheet and a.source_row=(p->>'source_row')::integer and a.source_values=p->'source_values'))
    or (select count(*) from private.salary_sheet_imports where batch_id=p_batch)<>jsonb_array_length(p_plan) then raise exception 'Batch payload changed';end if;
  return jsonb_build_object('already_imported',true);
 end if;
 lock table public.salary_records,public.summary_staff_payouts,public.daily_summaries in share row exclusive mode;
 if (select count(*) from jsonb_array_elements(p_plan))<>(select count(distinct p->>'source_row') from jsonb_array_elements(p_plan) p) then raise exception 'Repeated source row';end if;
 if exists(select 1 from jsonb_array_elements(p_plan) p where p->'record'<>'null'::jsonb group by p->>'salary_record_id' having count(*)>1) then raise exception 'Repeated target salary';end if;
 -- Check the inspected snapshot before the first write; fail atomically if another editor changed it.
 for item in select value from jsonb_array_elements(p_plan) loop
  if item->'record'='null'::jsonb then continue;end if;
  select to_jsonb(s) into v_current from public.salary_records s where s.id=item->>'salary_record_id';
  if coalesce(v_current,'null'::jsonb) is distinct from item->'before_record' then raise exception 'Salary changed since inspection: %',item->>'salary_record_id';end if;
  select * into v_record from jsonb_populate_record(null::public.salary_records,item->'record');
  if v_record.id<>item->>'salary_record_id' or v_record.net_salary is null or v_record.net_salary<0
    or not exists(select 1 from public.staff where id=v_record.staff_id)
    or not exists(select 1 from public.outlets where id=v_record.outlet_id) then raise exception 'Invalid salary record';end if;
  if item->>'disposition'<>'superseded_duplicate' then
   if v_record.payroll_status<>'PAID' or v_record.paid_at is null or v_record.legacy_salary_id<>item->'source_values'->>'SalaryID'
    or v_record.net_salary<>(item->'source_values'->>'NetSalary')::numeric
    or v_record.petty_advance<>(item->'source_values'->>'PettyAdvance')::numeric
    or v_record.payroll_details->'salary_sheet_import'->'owner_confirmed_paid'<>'true'::jsonb
    or v_record.payroll_details->'salary_sheet_import'->>'spreadsheet_id'<>p_spreadsheet
    or (v_record.payroll_details->'salary_sheet_import'->>'source_row')::integer<>(item->>'source_row')::integer then raise exception 'Salary source mismatch';end if;
   if exists(select 1 from public.salary_records s where s.outlet_id=v_record.outlet_id and s.staff_id=v_record.staff_id
     and date_trunc('month',s.period_start)=date_trunc('month',v_record.period_start) and s.legacy_salary_id is null
     and s.payroll_status<>'DRAFT' and s.id<>v_record.id) then raise exception 'Native payroll already exists for this salary month';end if;
   for link in select value from jsonb_array_elements(v_record.payroll_details->'salary_sheet_import'->'summary_salary_links') loop
    if not exists(select 1 from public.summary_staff_payouts p join public.daily_summaries d on d.id=p.summary_id
     where p.id=(link->>'id')::bigint and p.summary_id=link->>'summary_id' and p.amount=(link->>'amount')::numeric
      and d.business_date=(link->>'business_date')::date and d.outlet_id=v_record.outlet_id and p.staff_id=v_record.staff_id and p.payout_type='Salary') then raise exception 'Summary salary changed since inspection';end if;
   end loop;
  elsif v_record.payroll_details->'salary_sheet_import'->'superseded'<>'true'::jsonb then raise exception 'Invalid duplicate disposition';end if;
 end loop;
 for item in select value from jsonb_array_elements(p_plan) loop
  v_after:=null;
  if item->'record'<>'null'::jsonb then
   select * into v_record from jsonb_populate_record(null::public.salary_records,item->'record');
   insert into public.salary_records select v_record.* on conflict(id) do update set
    outlet_id=excluded.outlet_id,staff_id=excluded.staff_id,period_start=excluded.period_start,period_end=excluded.period_end,
    basic_salary=excluded.basic_salary,present_days=excluded.present_days,absent_days=excluded.absent_days,absent_deduction=excluded.absent_deduction,
    late_penalty=excluded.late_penalty,petty_advance=excluded.petty_advance,ot_credit=excluded.ot_credit,net_salary=excluded.net_salary,
    created_at=excluded.created_at,pay_date=excluded.pay_date,period_days=excluded.period_days,holiday_pay=excluded.holiday_pay,
    holiday_days=excluded.holiday_days,late_mins=excluded.late_mins,late_penalty_waived=excluded.late_penalty_waived,
    loan_prev_balance=excluded.loan_prev_balance,loan_deduct_this_month=excluded.loan_deduct_this_month,loan_remaining=excluded.loan_remaining,
    saved_by=excluded.saved_by,saved_by_name=excluded.saved_by_name,late_hours_edited=excluded.late_hours_edited,
    legacy_salary_id=excluded.legacy_salary_id,payroll_status=excluded.payroll_status,payroll_details=excluded.payroll_details,
    payment_method=excluded.payment_method,payment_reference=excluded.payment_reference,paid_at=excluded.paid_at;
   select to_jsonb(s) into v_after from public.salary_records s where s.id=v_record.id;
   if v_after is distinct from to_jsonb(v_record) then raise exception 'Salary readback mismatch';end if;
   v_changed:=v_changed+1;
   if item->>'disposition'<>'superseded_duplicate' then v_selected:=v_selected+1;end if;
   if item->>'disposition'='inserted_paid' then v_inserted:=v_inserted+1;end if;
  end if;
  insert into private.salary_sheet_imports(batch_id,spreadsheet_id,source_row,salary_record_id,source_values,disposition,before_record,after_record)
   values(p_batch,p_spreadsheet,(item->>'source_row')::integer,item->>'salary_record_id',item->'source_values',item->>'disposition',nullif(item->'before_record','null'::jsonb),v_after);
 end loop;
 return jsonb_build_object('source_rows',jsonb_array_length(p_plan),'paid_records',v_selected,'inserted',v_inserted,'changed',v_changed);
end $fn$;
revoke all on function private.import_salary_sheet(uuid,text,jsonb) from public,anon,authenticated;

-- B142: payroll is the canonical source for owner-confirmed monthly salaries.
create or replace function private.business_dashboard(p_outlet_id integer default null)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare v_result jsonb;
begin
  if auth.uid() is null or not private.is_admin() then
    raise exception 'Admin access required' using errcode='42501';
  end if;
  if p_outlet_id is not null and not exists(select 1 from public.outlets where id=p_outlet_id) then
    raise exception 'Outlet not found';
  end if;
  with scope as (
    select o.id,o.name,o.theme_color,o.timezone,public.get_effective_business_day(o.id,now()) as business_day,
      (select min(d.business_date) from public.daily_summaries d where d.outlet_id=o.id) as first_summary,
      least((select min(d.business_date) from public.daily_summaries d where d.outlet_id=o.id),
        (select min(public.get_effective_business_day(o.id,p.paid_at)) from public.salary_records p where p.outlet_id=o.id and p.payroll_status='PAID' and p.paid_at is not null and coalesce(p.payroll_details->'salary_sheet_import'->'superseded','false'::jsonb)<>'true'::jsonb)) as first_activity,
      (select max(d.business_date) from public.daily_summaries d where d.outlet_id=o.id and d.business_date<public.get_effective_business_day(o.id,now())) as latest_summary
    from public.outlets o where p_outlet_id is null or o.id=p_outlet_id
  ), bounds as (
    select (date_trunc('month',min(business_day))-interval '12 months')::date as history_start,
      min(business_day) as business_day from scope
  ), summaries as (
    select d.* from public.daily_summaries d join scope o on o.id=d.outlet_id
    where d.business_date>=(select history_start from bounds) and d.business_date<o.business_day
  ), expense_totals as (
    select e.summary_id,
      sum(e.amount) filter(where coalesce(lower(btrim(e.category)),'') !~ '^(pigmy|pigmi)( |$)') as operating_expenses,
      sum(e.amount) filter(where coalesce(lower(btrim(e.category)),'') ~ '^(pigmy|pigmi)( |$)') as savings
    from public.summary_expenses e join summaries d on d.id=e.summary_id group by e.summary_id
  ), vendor_totals as (
    select v.summary_id,sum(v.amount) as vendor_payments from public.summary_vendor_payouts v join summaries d on d.id=v.summary_id group by v.summary_id
  ), linked_summary_salaries as (
    select (link->>'id')::bigint as payout_id
    from public.salary_records p join scope o on o.id=p.outlet_id
    cross join lateral jsonb_array_elements(coalesce(p.payroll_details->'salary_sheet_import'->'summary_salary_links','[]'::jsonb)) link
    join public.summary_staff_payouts s on s.id=(link->>'id')::bigint and s.staff_id=p.staff_id
    join public.daily_summaries d on d.id=s.summary_id and d.outlet_id=p.outlet_id
    where p.payroll_status='PAID' and p.paid_at is not null
      and p.payroll_details->'salary_sheet_import'->'owner_confirmed_paid'='true'::jsonb
      and coalesce(p.payroll_details->'salary_sheet_import'->'superseded','false'::jsonb)<>'true'::jsonb
      and s.payout_type='Salary' and s.amount=(link->>'amount')::numeric
      and d.business_date=(link->>'business_date')::date and s.summary_id=link->>'summary_id'
  ), effective_summary_staff as (
    select s.* from public.summary_staff_payouts s join summaries d on d.id=s.summary_id
    where not exists(select 1 from linked_summary_salaries l where l.payout_id=s.id)
  ), staff_totals as (
    select s.summary_id,
      sum(s.amount) filter(where lower(btrim(coalesce(s.payout_type,''))) not in('advance','petty advance','loan')) as staff_costs,
      sum(s.amount) filter(where lower(btrim(coalesce(s.payout_type,''))) in('advance','petty advance','loan')) as advances
    from effective_summary_staff s group by s.summary_id
  ), payroll as (
    select p.id,p.outlet_id,p.staff_id,p.net_salary as amount,
      public.get_effective_business_day(p.outlet_id,p.paid_at) as business_date,
      row_number() over(partition by p.outlet_id,p.staff_id,public.get_effective_business_day(p.outlet_id,p.paid_at),p.net_salary order by p.paid_at,p.id) as payment_number
    from public.salary_records p join scope o on o.id=p.outlet_id
    where p.payroll_status='PAID' and p.paid_at is not null
      and coalesce(p.payroll_details->'salary_sheet_import'->'superseded','false'::jsonb)<>'true'::jsonb
      and public.get_effective_business_day(p.outlet_id,p.paid_at)>=(select history_start from bounds)
      and public.get_effective_business_day(p.outlet_id,p.paid_at)<o.business_day
  ), extra_payroll as (
    -- Match repeated equal payments one-to-one; do not count the summary and payroll copy twice.
    select p.* from payroll p where p.payment_number>(select count(*) from effective_summary_staff s join summaries d on d.id=s.summary_id
      where d.outlet_id=p.outlet_id and d.business_date=p.business_date and s.staff_id=p.staff_id
        and lower(btrim(s.payout_type))='salary' and s.amount=p.amount)
  ), paid_advances as (
    select a.outlet_id,a.staff_id,a.amount,coalesce(a.business_date,public.get_effective_business_day(a.outlet_id,a.paid_at)) as business_date,
      row_number() over(partition by a.outlet_id,a.staff_id,coalesce(a.business_date,public.get_effective_business_day(a.outlet_id,a.paid_at)),a.amount order by a.paid_at,a.id) as payment_number
    from public.staff_advance_requests a join scope o on o.id=a.outlet_id
    where a.status='PAID' and coalesce(a.business_date,public.get_effective_business_day(a.outlet_id,a.paid_at))>=(select history_start from bounds)
      and coalesce(a.business_date,public.get_effective_business_day(a.outlet_id,a.paid_at))<o.business_day
  ), extra_advances as (
    select a.* from paid_advances a where a.payment_number>(select count(*) from public.summary_staff_payouts s join summaries d on d.id=s.summary_id
      where d.outlet_id=a.outlet_id and d.business_date=a.business_date and s.staff_id=a.staff_id
        and lower(btrim(s.payout_type)) in('advance','petty advance','loan') and s.amount=a.amount)
  ), events as (
    select d.outlet_id,d.business_date,true as has_summary,(d.is_closed or d.summary_status='CLOSED') as is_closed,
      coalesce(d.cash_sale,0)+coalesce(d.upi_sale,0)+coalesce(d.own_digital,0)+coalesce(d.swiggy_gross,0)+coalesce(d.zomato_gross,0) as gross_sales,
      coalesce(d.net_sale,0) as net_sales,coalesce(d.discount,0) as discounts,
      coalesce(d.swiggy_gross,0)+coalesce(d.zomato_gross,0) as online_gross,
      coalesce(d.swiggy_payout,0)+coalesce(d.zomato_payout,0) as online_net,
      coalesce(d.cash_sale,0) as cash_sales,coalesce(d.upi_sale,0)+coalesce(d.own_digital,0) as direct_digital,
      coalesce(e.operating_expenses,0) as operating_expenses,coalesce(v.vendor_payments,0) as vendor_payments,
      coalesce(s.staff_costs,0) as staff_costs,coalesce(e.savings,0) as savings,coalesce(s.advances,0) as advances,
      greatest(0,-coalesce(d.short_excess,0)) as cash_shortage,greatest(0,coalesce(d.short_excess,0)) as cash_excess,
      coalesce(d.physical_cash,0) as physical_cash
    from summaries d left join expense_totals e on e.summary_id=d.id left join vendor_totals v on v.summary_id=d.id left join staff_totals s on s.summary_id=d.id
    union all select p.outlet_id,p.business_date,false,false,0,0,0,0,0,0,0,0,0,p.amount,0,0,0,0,0 from extra_payroll p
    union all select a.outlet_id,a.business_date,false,false,0,0,0,0,0,0,0,0,0,0,0,a.amount,0,0,0 from extra_advances a
  ), days as (
    select outlet_id,business_date,bool_or(has_summary) as has_summary,bool_or(is_closed) as is_closed,
      sum(gross_sales) as gross_sales,sum(net_sales) as net_sales,sum(discounts) as discounts,
      sum(online_gross) as online_gross,sum(online_net) as online_net,sum(cash_sales) as cash_sales,sum(direct_digital) as direct_digital,
      sum(operating_expenses) as operating_expenses,sum(vendor_payments) as vendor_payments,sum(staff_costs) as staff_costs,
      sum(savings) as savings,sum(advances) as advances,sum(cash_shortage) as cash_shortage,sum(cash_excess) as cash_excess,sum(physical_cash) as physical_cash
    from events group by outlet_id,business_date
  ), costs as (
    select d.outlet_id,d.business_date,e.category as label,'Expense' as kind,e.amount from public.summary_expenses e join summaries d on d.id=e.summary_id where coalesce(lower(btrim(e.category)),'') !~ '^(pigmy|pigmi)( |$)'
    union all select d.outlet_id,d.business_date,v.vendor_name,'Vendor',v.amount from public.summary_vendor_payouts v join summaries d on d.id=v.summary_id
    union all select d.outlet_id,d.business_date,coalesce(s.payout_type,'Staff payment'),'Staff',s.amount from effective_summary_staff s join summaries d on d.id=s.summary_id where lower(btrim(coalesce(s.payout_type,''))) not in('advance','petty advance','loan')
    union all select p.outlet_id,p.business_date,'Paid payroll','Staff',p.amount from extra_payroll p
  )
  select jsonb_build_object(
    'business_day',(select business_day from bounds),'history_start',(select history_start from bounds),'generated_at',now(),
    'outlets',coalesce((select jsonb_agg(to_jsonb(o) order by o.id) from scope o),'[]'::jsonb),
    'days',coalesce((select jsonb_agg(to_jsonb(d) order by d.business_date,d.outlet_id) from days d),'[]'::jsonb),
    'costs',coalesce((select jsonb_agg(to_jsonb(c) order by c.business_date,c.kind,c.label) from costs c),'[]'::jsonb),
    'payroll_not_marked_paid',coalesce((select sum(p.net_salary) from public.salary_records p join scope o on o.id=p.outlet_id where p.payroll_status='FINALIZED' and coalesce(p.payroll_details->'salary_sheet_import'->'superseded','false'::jsonb)<>'true'::jsonb),0),
    'payroll_records_not_marked_paid',(select count(*) from public.salary_records p join scope o on o.id=p.outlet_id where p.payroll_status='FINALIZED' and coalesce(p.payroll_details->'salary_sheet_import'->'superseded','false'::jsonb)<>'true'::jsonb)
  ) into v_result;
  return v_result;
end $function$;
revoke all on function private.business_dashboard(integer) from public,anon;
grant execute on function private.business_dashboard(integer) to authenticated;
create or replace function public.get_business_dashboard(p_outlet_id integer default null)
returns jsonb language sql stable security invoker set search_path='' as $$ select private.business_dashboard(p_outlet_id) $$;
revoke all on function public.get_business_dashboard(integer) from public,anon;
grant execute on function public.get_business_dashboard(integer) to authenticated;
create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $$ select jsonb_build_object('schema_build',142) $$;
notify pgrst,'reload schema';
