-- B137: read-only, administrator-only business dashboard. Existing ledgers are not changed.
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
  ), staff_totals as (
    select s.summary_id,
      sum(s.amount) filter(where lower(btrim(coalesce(s.payout_type,''))) not in('advance','petty advance','loan')) as staff_costs,
      sum(s.amount) filter(where lower(btrim(coalesce(s.payout_type,''))) in('advance','petty advance','loan')) as advances
    from public.summary_staff_payouts s join summaries d on d.id=s.summary_id group by s.summary_id
  ), payroll as (
    select p.id,p.outlet_id,p.staff_id,p.net_salary as amount,
      public.get_effective_business_day(p.outlet_id,p.paid_at) as business_date,
      row_number() over(partition by p.outlet_id,p.staff_id,public.get_effective_business_day(p.outlet_id,p.paid_at),p.net_salary order by p.paid_at,p.id) as payment_number
    from public.salary_records p join scope o on o.id=p.outlet_id
    where p.payroll_status='PAID' and p.paid_at is not null
      and public.get_effective_business_day(p.outlet_id,p.paid_at)>=(select history_start from bounds)
      and public.get_effective_business_day(p.outlet_id,p.paid_at)<o.business_day
  ), extra_payroll as (
    -- Match repeated equal payments one-to-one; do not count the summary and payroll copy twice.
    select p.* from payroll p where p.payment_number>(select count(*) from public.summary_staff_payouts s join summaries d on d.id=s.summary_id
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
    union all select d.outlet_id,d.business_date,coalesce(s.payout_type,'Staff payment'),'Staff',s.amount from public.summary_staff_payouts s join summaries d on d.id=s.summary_id where lower(btrim(coalesce(s.payout_type,''))) not in('advance','petty advance','loan')
    union all select p.outlet_id,p.business_date,'Paid payroll','Staff',p.amount from extra_payroll p
  )
  select jsonb_build_object(
    'business_day',(select business_day from bounds),'history_start',(select history_start from bounds),'generated_at',now(),
    'outlets',coalesce((select jsonb_agg(to_jsonb(o) order by o.id) from scope o),'[]'::jsonb),
    'days',coalesce((select jsonb_agg(to_jsonb(d) order by d.business_date,d.outlet_id) from days d),'[]'::jsonb),
    'costs',coalesce((select jsonb_agg(to_jsonb(c) order by c.business_date,c.kind,c.label) from costs c),'[]'::jsonb),
    'payroll_not_marked_paid',coalesce((select sum(p.net_salary) from public.salary_records p join scope o on o.id=p.outlet_id where p.payroll_status='FINALIZED'),0),
    'payroll_records_not_marked_paid',(select count(*) from public.salary_records p join scope o on o.id=p.outlet_id where p.payroll_status='FINALIZED')
  ) into v_result;
  return v_result;
end $function$;
revoke all on function private.business_dashboard(integer) from public,anon;
grant execute on function private.business_dashboard(integer) to authenticated;
create or replace function public.get_business_dashboard(p_outlet_id integer default null)
returns jsonb language sql stable security invoker set search_path='' as $$ select private.business_dashboard(p_outlet_id) $$;
revoke all on function public.get_business_dashboard(integer) from public,anon;
grant execute on function public.get_business_dashboard(integer) to authenticated;
create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $$ select jsonb_build_object('schema_build',137) $$;
notify pgrst,'reload schema';
