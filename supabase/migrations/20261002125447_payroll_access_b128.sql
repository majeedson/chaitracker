-- Build 128: payroll and access corrections. No historical records are rewritten.
CREATE OR REPLACE FUNCTION private.expected_cash(p_summary_id character varying)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce(ds.opening_cash_actual,0)+coalesce(ds.cash_sale,0)
    -coalesce((select sum(amount) from public.summary_expenses where summary_id=ds.id and mode='Cash'),0)
    -coalesce((select sum(amount) from public.summary_vendor_payouts where summary_id=ds.id and mode='Cash'),0)
    -coalesce((select sum(amount) from public.summary_staff_payouts where summary_id=ds.id and mode='Cash'),0)
    -coalesce((select sum(amount) from public.staff_advance_requests where outlet_id=ds.outlet_id
      and business_date=ds.business_date and status='PAID' and mode='Cash'),0)
  from public.daily_summaries ds where ds.id=p_summary_id
$function$
;

CREATE OR REPLACE FUNCTION public.save_daily_summary(p_summary_id character varying, p_outlet_id integer, p_business_date date, p_user_id uuid, p_user_name character varying, p_role character varying, p_cash_sale numeric DEFAULT 0, p_upi_sale numeric DEFAULT 0, p_swiggy_gross numeric DEFAULT 0, p_swiggy_payout numeric DEFAULT 0, p_zomato_gross numeric DEFAULT 0, p_zomato_payout numeric DEFAULT 0, p_own_digital numeric DEFAULT 0, p_discount numeric DEFAULT 0, p_opening_cash_system numeric DEFAULT 0, p_opening_cash_actual numeric DEFAULT 0, p_physical_cash numeric DEFAULT 0, p_expenses jsonb DEFAULT '[]'::jsonb, p_vendor_payouts jsonb DEFAULT '[]'::jsonb, p_staff_payouts jsonb DEFAULT '[]'::jsonb)
 RETURNS daily_summaries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_summary public.daily_summaries;v_net numeric;v_expected numeric;v_actor public.users;v_admin boolean;v_old_advances jsonb;v_new_advances jsonb;
begin
 perform private.require_module_access('summary');
 select * into v_actor from public.users where id=p_user_id and active=true and auth_user_id=auth.uid();
 if not found then raise exception 'Authenticated CafeTracker user required';end if;
 v_admin:=coalesce(v_actor.access_class,'STAFF')='ADMIN';
 if not v_admin and not private.has_module_access('summary') then raise exception 'Manager or Admin access required';end if;
 if not v_admin and v_actor.outlet_id<>p_outlet_id then raise exception 'You cannot save another outlet summary';end if;
 if not exists(select 1 from public.outlets where id=p_outlet_id) then raise exception 'Outlet not found';end if;
 if exists(select 1 from public.daily_summaries where id=p_summary_id and is_closed=true) then raise exception 'Daily summary is already closed';end if;
 if exists(select 1 from public.daily_summaries where id=p_summary_id and (outlet_id<>p_outlet_id or business_date<>p_business_date)) then raise exception 'Summary identity does not match outlet and business date';end if;

 if jsonb_typeof(coalesce(p_staff_payouts,'[]'::jsonb))<>'array' then raise exception 'Staff payouts must be a list';end if;
 if exists(select 1 from jsonb_to_recordset(coalesce(p_staff_payouts,'[]'::jsonb)) x(staff_id integer,payout_type varchar,amount numeric,mode varchar)
   where x.amount is null or x.amount<=0 or coalesce(x.mode,'Cash') not in('Cash','UPI')
     or x.payout_type is null or x.payout_type not in('Salary','Reimbursement','Other','Advance')
     or not exists(select 1 from public.staff s where s.id=x.staff_id and s.outlet_id=p_outlet_id)) then
   raise exception 'Choose valid staff, payout type, amount and mode';end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.staff_id,x.amount,x.mode),'[]'::jsonb) into v_old_advances from
   (select staff_id,amount,mode from public.summary_staff_payouts where summary_id=p_summary_id and payout_type='Advance') x;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.staff_id,x.amount,x.mode),'[]'::jsonb) into v_new_advances from
   (select staff_id,amount,coalesce(mode,'Cash') mode from jsonb_to_recordset(coalesce(p_staff_payouts,'[]'::jsonb))
     x(staff_id integer,payout_type varchar,amount numeric,mode varchar) where payout_type='Advance') x;
 if v_new_advances is distinct from v_old_advances then
   raise exception 'Advances must use the approved advance payout workflow; legacy advance rows cannot be changed here';end if;
 insert into public.daily_summaries(id,outlet_id,business_date,saved_by,saved_by_name,role,cash_sale,upi_sale,swiggy_gross,swiggy_payout,zomato_gross,zomato_payout,own_digital,discount,net_sale,opening_cash_system,opening_cash_actual,physical_cash,expected_cash,short_excess,summary_status,is_closed)
 values(p_summary_id,p_outlet_id,p_business_date,v_actor.id,v_actor.name,case when v_admin then 'Admin' else v_actor.role end,coalesce(p_cash_sale,0),coalesce(p_upi_sale,0),coalesce(p_swiggy_gross,0),coalesce(p_swiggy_payout,0),coalesce(p_zomato_gross,0),coalesce(p_zomato_payout,0),coalesce(p_own_digital,0),coalesce(p_discount,0),0,coalesce(p_opening_cash_system,0),coalesce(p_opening_cash_actual,0),coalesce(p_physical_cash,0),0,0,'OPEN',false)
 on conflict(id) do update set saved_by=excluded.saved_by,saved_by_name=excluded.saved_by_name,role=excluded.role,cash_sale=excluded.cash_sale,upi_sale=excluded.upi_sale,swiggy_gross=excluded.swiggy_gross,swiggy_payout=excluded.swiggy_payout,zomato_gross=excluded.zomato_gross,zomato_payout=excluded.zomato_payout,own_digital=excluded.own_digital,discount=excluded.discount,opening_cash_system=excluded.opening_cash_system,opening_cash_actual=excluded.opening_cash_actual,physical_cash=excluded.physical_cash,summary_status='OPEN',is_closed=false;
 delete from public.summary_expenses where summary_id=p_summary_id;delete from public.summary_vendor_payouts where summary_id=p_summary_id;delete from public.summary_staff_payouts where summary_id=p_summary_id;
 insert into public.summary_expenses(summary_id,category,amount,mode) select p_summary_id,x.category,x.amount,coalesce(x.mode,'Cash') from jsonb_to_recordset(coalesce(p_expenses,'[]'::jsonb)) x(category varchar,amount numeric,mode varchar);
 insert into public.summary_vendor_payouts(summary_id,vendor_name,amount,mode) select p_summary_id,x.vendor_name,x.amount,coalesce(x.mode,'Cash') from jsonb_to_recordset(coalesce(p_vendor_payouts,'[]'::jsonb)) x(vendor_name varchar,amount numeric,mode varchar);
 insert into public.summary_staff_payouts(summary_id,staff_id,staff_name,payout_type,amount,mode)
 select p_summary_id,x.staff_id,s.name,x.payout_type,x.amount,coalesce(x.mode,'Cash')
 from jsonb_to_recordset(coalesce(p_staff_payouts,'[]'::jsonb)) x(staff_id integer,staff_name varchar,payout_type varchar,amount numeric,mode varchar)
 join public.staff s on s.id=x.staff_id and s.outlet_id=p_outlet_id;
 v_net:=coalesce(p_cash_sale,0)+coalesce(p_upi_sale,0)+coalesce(p_swiggy_payout,0)+coalesce(p_zomato_payout,0)+coalesce(p_own_digital,0)-coalesce(p_discount,0);
 v_expected:=private.expected_cash(p_summary_id);
 update public.daily_summaries set net_sale=v_net,expected_cash=v_expected,short_excess=coalesce(p_physical_cash,0)-v_expected where id=p_summary_id returning * into v_summary;
 insert into public.business_days(outlet_id,business_date,summary_status) values(p_outlet_id,p_business_date,'OPEN') on conflict(outlet_id,business_date) do update set summary_status='OPEN';
 return v_summary;
end $function$
;

drop policy if exists advance_summary_reconciliation on public.staff_advance_requests;
create or replace function public.get_summary_advances(p_outlet_id integer,p_business_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare v_result jsonb;
begin
 if not private.can_use_summary(p_outlet_id) then raise exception 'Summary access denied' using errcode='42501';end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.status,x.id),'[]'::jsonb) into v_result from
  (select id,staff_id,amount,mode,status,business_date from public.staff_advance_requests
   where outlet_id=p_outlet_id and (status='APPROVED' or (status='PAID' and business_date=p_business_date))) x;
 return v_result;
end $function$;
create or replace function public.get_expected_cash(p_summary_id varchar)
returns numeric language plpgsql stable security definer set search_path='' as $function$
declare v_outlet integer;
begin
 select outlet_id into v_outlet from public.daily_summaries where id=p_summary_id;
 if not private.can_use_summary(v_outlet) then raise exception 'Summary access denied' using errcode='42501';end if;
 return private.expected_cash(p_summary_id);
end $function$;
revoke all on function private.expected_cash(varchar) from public,anon,authenticated;
revoke all on function public.get_summary_advances(integer,date),public.get_expected_cash(varchar) from public,anon;
grant execute on function public.get_summary_advances(integer,date),public.get_expected_cash(varchar) to authenticated;
create or replace function private.salary_period_start(p_month date,p_joining date)
returns date language sql immutable set search_path='' as $function$
 select date_trunc('month',p_month)::date+least(coalesce(extract(day from p_joining)::int,1),
   extract(day from (date_trunc('month',p_month)+interval '1 month - 1 day'))::int)-1
$function$;
create or replace function private.salary_period_containing(p_date date,p_joining date)
returns date language sql immutable set search_path='' as $function$
 select private.salary_period_start(case when p_date<private.salary_period_start(p_date,p_joining)
   then (p_date-interval '1 month')::date else p_date end,p_joining)
$function$;
create or replace function private.salary_period_end(p_start date,p_joining date)
returns date language sql immutable set search_path='' as $function$
 select private.salary_period_start((date_trunc('month',p_start)+interval '1 month')::date,p_joining)-1
$function$;
create or replace function private.payroll_late_hours(p_minutes integer)
returns numeric language sql immutable set search_path='' as $function$
 select case when coalesce(p_minutes,0)<=15 then 0 when p_minutes<=30 then .5 else ceil(p_minutes/60.0) end
$function$;
create or replace function public.get_salary_estimate_internal(p_staff_id integer,p_start date,p_end date)
returns jsonb language plpgsql set search_path='' as $function$
declare
 v_staff public.staff;v_start date;v_days integer;v_present numeric;v_half integer;
 v_absent integer;v_leave integer;v_recorded integer;v_unrecorded integer;v_conflicts integer;
 v_minutes integer;v_hours numeric;v_holiday_days numeric;v_daily numeric;v_hourly numeric;
 v_absence numeric;v_half_ded numeric;v_late_ded numeric;v_holiday numeric;v_advance numeric;v_loan numeric;
 v_entries jsonb;
begin
 if p_start is null or p_end is null or p_end<p_start or p_end-p_start>366 then raise exception 'Invalid salary period';end if;
 select * into v_staff from public.staff where id=p_staff_id;if not found then raise exception 'Staff not found';end if;
 v_start:=greatest(p_start,coalesce(v_staff.joining_date,p_start));v_days:=greatest(0,p_end-v_start+1);
 v_daily:=coalesce(v_staff.basic_salary,0)/30.0;v_hourly:=v_daily/12.0;
 with dates as(select generate_series(v_start,p_end,interval '1 day')::date d),
 punches as(select distinct on(attendance_date) * from public.attendance where staff_id=p_staff_id
   and attendance_date between v_start and p_end order by attendance_date,created_at asc,id asc),
 resolved as(
  select d.d,a.id,a.status,a.half_day,coalesce(a.late_mins,0) minutes,
   exists(select 1 from public.leave_requests l where l.staff_id=p_staff_id and l.status='APPROVED'
     and upper(l.leave_type)='HALF_DAY' and d.d between l.start_date and l.end_date) approved_half,
   exists(select 1 from public.leave_requests l where l.staff_id=p_staff_id and l.status='APPROVED'
     and upper(l.leave_type)<>'HALF_DAY' and d.d between l.start_date and l.end_date) approved_full,
   exists(select 1 from public.staff_weekly_offs w where w.staff_id=p_staff_id and w.day_of_week=extract(dow from d.d)::int
     and w.effective_from<=d.d and (w.effective_to is null or w.effective_to>=d.d))
     or coalesce((select h.is_closed from public.get_outlet_hours(v_staff.outlet_id,d.d) h),false)
     or exists(select 1 from public.staff_shifts ss where ss.staff_id=p_staff_id and ss.shift_date=d.d
       and (upper(coalesce(ss.shift_type,''))='OFF' or upper(coalesce(ss.status,''))='OFF')) scheduled_off
  from dates d left join punches a on a.attendance_date=d.d
 ),classified as(
  select *,approved_full and id is not null and status not in('Absent','Leave') conflict,
   case when approved_full and id is not null and status not in('Absent','Leave') then 'CONFLICT'
    when status='Absent' then 'ABSENT' when status='Leave' or approved_full then 'LEAVE'
    when id is not null and (coalesce(half_day,false) or status='HalfDay' or approved_half) then 'HALF'
    when id is not null then 'PRESENT' when scheduled_off and not approved_half then 'LEAVE' else 'MISSING' end kind
  from resolved
 ),chargeable as(select *,case when kind in('PRESENT','HALF') and not approved_half then greatest(0,minutes) else 0 end late from classified)
 select count(*) filter(where kind not in('MISSING','CONFLICT')),
  coalesce(sum(case when kind='PRESENT' then 1 when kind='HALF' then .5 else 0 end),0),
  count(*) filter(where kind='HALF'),count(*) filter(where kind='ABSENT'),count(*) filter(where kind='LEAVE'),
  count(*) filter(where kind='CONFLICT'),coalesce(sum(late),0),coalesce(sum(private.payroll_late_hours(late)),0),
  coalesce(jsonb_agg(jsonb_build_object('date',d,'minutes',late,'hours',private.payroll_late_hours(late)) order by d)
    filter(where late>0),'[]'::jsonb)
 into v_recorded,v_present,v_half,v_absent,v_leave,v_conflicts,v_minutes,v_hours,v_entries from chargeable;
 v_unrecorded:=greatest(0,v_days-v_recorded);
 v_holiday_days:=case when v_days>0 and v_unrecorded=0 then greatest(0,3-v_absent-v_leave) else 0 end;
 v_absence:=case when v_absent+v_leave<=3 then 0 else round(coalesce(v_staff.basic_salary,0)-
   least(coalesce(v_staff.basic_salary,0),v_daily*greatest(0,v_days-v_absent-v_leave)),0) end;
 v_half_ded:=round(v_half*v_daily/2.0,0);v_late_ded:=round(v_hours*v_hourly,0);v_holiday:=round(v_holiday_days*v_daily,0);
 select coalesce(sum(case when lower(payment_type) in('advance','petty advance','petty_advance') then amount else 0 end),0),
  coalesce(sum(case when lower(payment_type) in('loan','loan deduction','loan_deduction') then amount else 0 end),0)
 into v_advance,v_loan from public.staff_payments where staff_id=p_staff_id and business_date between v_start and p_end;
 return jsonb_build_object('period_days',v_days,'basic_salary',case when v_days>0 then coalesce(v_staff.basic_salary,0) else 0 end,
  'daily_rate',v_daily,'hourly_rate',v_hourly,'present_equivalent_days',v_present,'half_days',v_half,
  'absent_days',v_absent,'leave_days',v_leave,'paid_off_days',least(3,v_absent+v_leave),
  'unrecorded_days',v_unrecorded,'needs_review_days',v_conflicts,'data_complete',v_unrecorded=0,
  'holiday_duty_days',v_holiday_days,'holiday_duty_allowance',v_holiday,'late_mins',v_minutes,
  'deductible_late_hours',v_hours,'late_entries',v_entries,'late_deduction',v_late_ded,
  'absent_deduction',v_absence,'half_day_deduction',v_half_ded,'advance_deduction',v_advance,'loan_deduction',v_loan,
  'estimated_net',case when v_days>0 then coalesce(v_staff.basic_salary,0)+v_holiday-v_absence-v_half_ded-v_late_ded-v_advance-v_loan else 0 end);
end $function$;
revoke all on function public.get_salary_estimate_internal(integer,date,date) from public,anon,authenticated;
alter table public.staff_advance_requests add column if not exists repayment_anchor_date date;
create or replace function private.advance_due(p_staff_id integer,p_period_start date,p_period_end date)
returns table(advance_id uuid,due numeric,balance numeric) language sql stable security definer set search_path='' as $function$
 with advances as(
  select a.*,coalesce((select r.period_start from public.salary_records r where r.staff_id=a.staff_id
    and a.business_date between r.period_start and r.period_end order by r.period_start desc limit 1),
    private.salary_period_containing(a.business_date,coalesce(a.repayment_anchor_date,s.joining_date))) first_start
  from public.staff_advance_requests a join public.staff s on s.id=a.staff_id
  where a.staff_id=p_staff_id and a.status='PAID' and a.business_date<=p_period_end
 ),scheduled as(
  select a.*,greatest(1,(extract(year from p_period_start)::int-extract(year from first_start)::int)*12
    +extract(month from p_period_start)::int-extract(month from first_start)::int+1) cycles,
   coalesce((select sum(d.amount) from public.staff_advance_deductions d where d.advance_id=a.id and d.period_start<p_period_start),0) repaid
  from advances a where first_start<=p_period_start or a.business_date between p_period_start and p_period_end
 )
 select id,greatest(0,least(amount,case when cycles>=installments then amount else round(amount/installments,2)*cycles end)-repaid),
  greatest(0,amount-repaid) from scheduled order by paid_at,id
$function$;
create or replace function private.advance_due(p_staff_id integer,p_period_start date)
returns table(advance_id uuid,due numeric,balance numeric) language sql stable security definer set search_path='' as $function$
 select d.* from public.staff s cross join lateral private.advance_due(p_staff_id,p_period_start,private.salary_period_end(p_period_start,s.joining_date)) d where s.id=p_staff_id
$function$;
create or replace function public.get_salary_estimate_v2(p_staff_id integer,p_start date,p_end date)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare v_est jsonb;v_due numeric;v_balance numeric;v_take numeric;
begin
 v_est:=public.get_salary_estimate(p_staff_id,p_start,p_end);
 select coalesce(sum(due),0),coalesce(sum(balance),0) into v_due,v_balance from private.advance_due(p_staff_id,p_start,p_end);
 v_take:=least(v_due,greatest(0,(v_est->>'estimated_net')::numeric));
 return v_est||jsonb_build_object('advance_installment_due',v_due,'advance_installment_deduction',v_take,
  'advance_balance_before_payroll',v_balance,'estimated_net',round((v_est->>'estimated_net')::numeric-v_take,0));
end $function$;
revoke all on function private.salary_period_start(date,date),private.salary_period_containing(date,date),private.salary_period_end(date,date),private.payroll_late_hours(integer),private.advance_due(integer,date),private.advance_due(integer,date,date) from public,anon,authenticated;

-- B118: A payroll belongs to the month in which its period starts.
-- Rolling periods may end in the following month, so overlap is not a reliable selector.
create or replace function public.get_salary_payroll_context(p_staff_id integer,p_month_start date)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_actor public.users;v_current public.salary_records;v_prior public.salary_records;
begin
  select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;
  if not found then raise exception 'Authenticated CafeTracker user required';end if;
  if coalesce(v_actor.access_class,'STAFF')<>'ADMIN' and coalesce(v_actor.staff_id,0)<>p_staff_id then
    raise exception 'You can only view your own salary';
  end if;
  select * into v_current from public.salary_records r where r.staff_id=p_staff_id
    and r.period_start>=date_trunc('month',p_month_start)::date
    and r.period_start<(date_trunc('month',p_month_start)+interval '1 month')::date
  order by r.period_start desc,r.created_at desc limit 1;
  select * into v_prior from public.salary_records r where r.staff_id=p_staff_id
    and r.period_start<date_trunc('month',p_month_start)::date
    and r.payroll_status in ('FINALIZED','PAID')
  order by r.period_start desc,r.created_at desc limit 1;
  return jsonb_build_object('current',case when v_current.id is null then null else to_jsonb(v_current) end,
    'prior',case when v_prior.id is null then null else to_jsonb(v_prior) end);
end $function$;

revoke all on function public.get_salary_payroll_context(integer,date) from public,anon;
grant execute on function public.get_salary_payroll_context(integer,date) to authenticated;

CREATE OR REPLACE FUNCTION public.get_attendance_calendar(p_outlet_id integer, p_staff_id integer DEFAULT NULL::integer, p_start_date date DEFAULT CURRENT_DATE, p_end_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(attendance_date date, staff_id integer, staff_name character varying, outlet_id integer, outlet_name character varying, shift_start time without time zone, punch_time time without time zone, late_mins integer, status character varying, half_day boolean, photo_url text, is_future boolean, needs_review boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor public.users;
  v_tz text;
begin
  select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;
  if not found then raise exception 'Authenticated CafeTracker user required'; end if;
  if v_actor.role <> 'Owner' and v_actor.outlet_id <> p_outlet_id then raise exception 'Outlet access denied'; end if;
  if v_actor.role not in ('Owner','Manager','Ops Manager') then
    if v_actor.staff_id is null then raise exception 'Staff profile not linked'; end if;
    if p_staff_id is null or p_staff_id <> v_actor.staff_id then raise exception 'Attendance access denied'; end if;
  end if;
  if p_end_date < p_start_date or p_end_date-p_start_date > 62 then raise exception 'Invalid attendance date range'; end if;

  select coalesce(o.timezone,'Asia/Kolkata') into v_tz from public.outlets o where o.id=p_outlet_id;

  return query
  with dates as (
    select generate_series(p_start_date,p_end_date,interval '1 day')::date d
  ),
  people as (
    select s.id,s.name,s.outlet_id,s.joining_date,s.employment_end_date,
           coalesce(u.role,'Staff') role
    from public.staff s
    left join public.users u on u.staff_id=s.id and u.active=true
    where s.outlet_id=p_outlet_id
      and (p_staff_id is null or s.id=p_staff_id)
      and s.active=true
  ),
  grid as (
    select d.d,p.*
    from dates d cross join people p
    where (p.joining_date is null or d.d>=p.joining_date)
      and (p.employment_end_date is null or d.d<=p.employment_end_date)
  ),
  resolved as (
    select g.*,
      a.id attendance_id,a.punch_time,a.photo_url,a.half_day stored_half_day,a.status stored_status,
      lr.id leave_id,lr.leave_type approved_leave_type,
      ss.shift_type,ss.status shift_status,
      coalesce(
        ss.start_time,
        make_time(
          greatest(0,least(23,coalesce(o.shift_start_hour,11) + case when g.role='Manager' then coalesce(o.manager_shift_offset_minutes,120)/60 else 0 end)),
          case when g.role='Manager' then (coalesce(o.shift_start_minute,0)+coalesce(o.manager_shift_offset_minutes,120)%60)%60 else coalesce(o.shift_start_minute,0) end,
          0
        )
      ) effective_shift,
      coalesce(o.attendance_grace_minutes,15) grace_mins,
      coalesce(o.half_day_late_minutes,240) half_threshold,
      coalesce(h.close_time,o.default_close_time,o.attendance_absent_cutoff,time '22:00') effective_close,
      coalesce(h.is_closed,false) outlet_closed,
      exists(
        select 1 from public.staff_weekly_offs wo
        where wo.staff_id=g.id
          and wo.day_of_week=extract(dow from g.d)::smallint
          and wo.effective_from<=g.d
          and (wo.effective_to is null or wo.effective_to>=g.d)
      ) weekly_off
    from grid g
    join public.outlets o on o.id=g.outlet_id
    left join public.attendance a on a.staff_id=g.id and a.attendance_date=g.d
    left join public.leave_requests lr on lr.staff_id=g.id and lr.status='APPROVED' and g.d between lr.start_date and lr.end_date
    left join public.staff_shifts ss on ss.staff_id=g.id and ss.shift_date=g.d
    left join lateral public.get_outlet_hours(g.outlet_id,g.d) h on true
  ),
  calc as (
    select r.*,
      case when r.punch_time is null then 0
           else greatest(0,round(extract(epoch from (r.punch_time-r.effective_shift))/60)::int) end raw_late
    from resolved r
  )
  select
    c.d,c.id,c.name,c.outlet_id,o.name,c.effective_shift,c.punch_time,
    case when upper(coalesce(c.approved_leave_type,''))='HALF_DAY' or c.raw_late<=c.grace_mins then 0 else c.raw_late end,
    (case
      when c.attendance_id is not null and c.stored_status not in('Absent','Leave') and c.leave_id is not null and upper(coalesce(c.approved_leave_type,''))<>'HALF_DAY' then 'NEEDS_REVIEW'
      when c.stored_status='Leave' then 'LEAVE'
      when c.stored_status='Absent' then case when c.leave_id is not null and upper(coalesce(c.approved_leave_type,''))<>'HALF_DAY' then 'LEAVE' else 'ABSENT' end
      when c.attendance_id is not null and upper(coalesce(c.approved_leave_type,''))='HALF_DAY' then 'HALF_DAY'
      when c.attendance_id is not null and (coalesce(c.stored_half_day,false) or (case when c.raw_late<=c.grace_mins then 0 else c.raw_late end)>=c.half_threshold) then 'HALF_DAY'
      when c.attendance_id is not null and (case when c.raw_late<=c.grace_mins then 0 else c.raw_late end)>0 then 'LATE'
      when c.attendance_id is not null then 'PRESENT'
      when c.leave_id is not null and upper(coalesce(c.approved_leave_type,''))='HALF_DAY' then 'HALF_DAY_LEAVE'
      when c.leave_id is not null then 'LEAVE'
      when c.outlet_closed or c.weekly_off or upper(coalesce(c.shift_type,''))='OFF' or upper(coalesce(c.shift_status,''))='OFF' then 'WEEKLY_OFF'
      when c.d > (now() at time zone v_tz)::date then 'UPCOMING'
      when c.d = (now() at time zone v_tz)::date and (now() at time zone v_tz)::time < c.effective_close then 'NOT_CHECKED_IN'
      else 'ABSENT'
    end)::varchar,
    (c.attendance_id is not null and c.stored_status not in('Absent','Leave') and (upper(coalesce(c.approved_leave_type,''))='HALF_DAY' or coalesce(c.stored_half_day,false) or (case when c.raw_late<=c.grace_mins then 0 else c.raw_late end)>=c.half_threshold)),
    c.photo_url,
    c.d > (now() at time zone v_tz)::date,
    c.attendance_id is not null and c.stored_status not in('Absent','Leave') and c.leave_id is not null and upper(coalesce(c.approved_leave_type,''))<>'HALF_DAY'
  from calc c
  join public.outlets o on o.id=c.outlet_id
  order by c.d desc,c.name;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.pay_staff_advance(p_id uuid, p_mode text)
 RETURNS staff_advance_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    business_date=v_day,first_period=(select private.salary_period_containing(v_day,s.joining_date) from public.staff s where s.id=v_row.staff_id),repayment_anchor_date=(select coalesce(s.joining_date,date_trunc('month',v_day)::date) from public.staff s where s.id=v_row.staff_id) where id=p_id returning * into v_row;
  if v_summary.id is not null then
    update public.daily_summaries set expected_cash=private.expected_cash(v_summary.id),
      short_excess=physical_cash-private.expected_cash(v_summary.id) where id=v_summary.id;
  end if;
  return v_row;
end $function$
;

-- B121: let the owner explicitly revise an overlapping unpaid payroll while retaining its record ID and audit history.
create or replace function public.save_salary_payroll(
  p_staff_id integer,
  p_period_start date,
  p_period_end date,
  p_pay_date date,
  p_details jsonb,
  p_action text,
  p_user_id uuid,
  p_payment_method text default null,
  p_payment_reference text default null
) returns public.salary_records
language plpgsql security definer set search_path = '' as $function$
declare
  v_actor public.users;
  v_staff public.staff;
  v_row public.salary_records;
  v_replace public.salary_records;
  v_existing public.salary_records;
  v_half_days numeric;
  v_estimate jsonb;
  v_payroll_outlet integer;
  v_replace_id varchar;
  v_old_status text;
  v_new_status text;
  v_period_days integer;
  v_basic numeric;
  v_holiday numeric;
  v_holiday_days numeric;
  v_present numeric;
  v_absent numeric;
  v_absent_deduction numeric;
  v_half_day_deduction numeric;
  v_late_mins integer;
  v_late_hours numeric;
  v_late_penalty numeric;
  v_late_waived boolean;
  v_manual_advance numeric;
  v_scheduled_advance numeric;
  v_ot numeric;
  v_loan_balance numeric;
  v_loan_deduction numeric;
  v_extra_earnings numeric;
  v_extra_deductions numeric;
  v_net_before_advance numeric;
  v_left numeric;
  v_due record;
  v_take numeric;
  v_schedule_posted numeric := 0;
  v_net numeric;
  v_late_final numeric;
  v_id varchar;
begin
  select * into v_actor from public.users
  where auth_user_id=auth.uid() and active=true and id=p_user_id;
  if not found or coalesce(v_actor.access_class,'')<>'ADMIN' then
    raise exception 'Owner access required';
  end if;
  select * into v_staff from public.staff where id=p_staff_id for update;
  if not found then raise exception 'Staff not found'; end if;
  if p_period_start is null or p_period_end is null or p_period_end<p_period_start then
    raise exception 'Enter a valid pay period';
  end if;
  if p_pay_date is null then raise exception 'Pay date is required'; end if;
  if p_action is null or p_action not in ('SAVE_DRAFT','FINALIZE','MARK_PAID') then raise exception 'Invalid payroll action'; end if;
  if jsonb_typeof(coalesce(p_details,'{}'::jsonb))<>'object' then raise exception 'Payroll details must be an object'; end if;
  if p_payment_method is not null and p_payment_method not in ('Cash','UPI','Bank','Other') then raise exception 'Invalid payment method'; end if;
  if length(coalesce(p_payment_reference,''))>120 then raise exception 'Payment reference is too long'; end if;

  v_period_days:=(p_period_end-p_period_start)+1;
  v_basic:=coalesce((p_details->>'basic_salary')::numeric,0);
  v_holiday:=coalesce((p_details->>'holiday_pay')::numeric,0);
  v_holiday_days:=coalesce((p_details->>'holiday_days')::numeric,0);
  v_present:=coalesce((p_details->>'present_days')::numeric,0);
  v_absent:=coalesce((p_details->>'absent_days')::numeric,0);
  v_absent_deduction:=coalesce((p_details->>'absent_deduction')::numeric,0);
  v_half_days:=coalesce((p_details->>'half_days')::numeric,0);
  v_half_day_deduction:=coalesce((p_details->>'half_day_deduction')::numeric,0);
  v_late_mins:=greatest(0,coalesce((p_details->>'late_mins')::integer,0));
  v_late_hours:=coalesce((p_details->>'late_hours')::numeric,0);
  v_late_penalty:=coalesce((p_details->>'late_penalty')::numeric,0);
  v_late_waived:=coalesce((p_details->>'late_penalty_waived')::boolean,false);
  v_manual_advance:=coalesce((p_details->>'advance_deduction')::numeric,0);
  v_scheduled_advance:=coalesce((p_details->>'advance_installment_deduction')::numeric,0);
  v_ot:=coalesce((p_details->>'ot_credit')::numeric,0);
  v_loan_balance:=coalesce((p_details->>'loan_prev_balance')::numeric,0);
  v_loan_deduction:=coalesce((p_details->>'loan_deduct_this_month')::numeric,0);
  if p_details ? 'extra_earnings' and jsonb_typeof(p_details->'extra_earnings')<>'array' then raise exception 'Extra earnings must be a list'; end if;
  if p_details ? 'extra_deductions' and jsonb_typeof(p_details->'extra_deductions')<>'array' then raise exception 'Extra deductions must be a list'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_details->'extra_earnings','[]'::jsonb)) x
      where coalesce(x->>'label','')='' or coalesce((x->>'amount')::numeric,-1)<0)
     or exists(select 1 from jsonb_array_elements(coalesce(p_details->'extra_deductions','[]'::jsonb)) x
      where coalesce(x->>'label','')='' or coalesce((x->>'amount')::numeric,-1)<0) then
    raise exception 'Each payroll adjustment needs a description and non-negative amount';
  end if;
  select coalesce(sum((x->>'amount')::numeric),0) into v_extra_earnings
    from jsonb_array_elements(coalesce(p_details->'extra_earnings','[]'::jsonb)) x;
  select coalesce(sum((x->>'amount')::numeric),0) into v_extra_deductions
    from jsonb_array_elements(coalesce(p_details->'extra_deductions','[]'::jsonb)) x;
  if v_basic<0 or v_holiday<0 or v_holiday_days<0 or v_present<0 or v_absent<0
     or v_absent_deduction<0 or v_half_day_deduction<0 or v_late_hours<0 or v_late_penalty<0
     or v_manual_advance<0 or v_scheduled_advance<0 or v_ot<0
     or v_loan_balance<0 or v_loan_deduction<0 or v_extra_earnings<0 or v_extra_deductions<0 then
    raise exception 'Payroll amounts cannot be negative';
  end if;
  if v_loan_deduction>v_loan_balance then raise exception 'Loan deduction exceeds the previous balance'; end if;


  if v_half_days<0 or v_half_days>v_present then raise exception 'Half days cannot exceed present days';end if;
  if p_action='FINALIZE' and abs(v_present+v_absent-v_period_days)>0.001 then raise exception 'Present plus absent days must equal period days';end if;
  if not coalesce((p_details->>'absence_deduction_manual')::boolean,false) then
    v_absent_deduction:=case when v_absent<=3 then 0 else round(v_basic-least(v_basic,v_basic/30.0*greatest(0,v_period_days-v_absent)),0) end;
  end if;
  if not coalesce((p_details->>'holiday_days_manual')::boolean,false) then
    v_holiday_days:=case when abs(v_present+v_absent-v_period_days)<=0.001 then greatest(0,3-v_absent) else 0 end;
  end if;
  if not coalesce((p_details->>'holiday_pay_manual')::boolean,false) then v_holiday:=round(v_holiday_days*v_basic/30.0,0);end if;
  if not coalesce((p_details->>'half_day_deduction_manual')::boolean,false) then v_half_day_deduction:=round(v_half_days*v_basic/60.0,0);end if;
  if not coalesce((p_details->>'late_penalty_manual')::boolean,false) then
    if not coalesce((p_details->>'late_hours_manual')::boolean,false) then
      v_estimate:=public.get_salary_estimate(p_staff_id,p_period_start,p_period_end);
      v_late_hours:=coalesce((v_estimate->>'deductible_late_hours')::numeric,0);v_late_mins:=coalesce((v_estimate->>'late_mins')::integer,0);
    end if;
    v_late_penalty:=round(v_late_hours*v_basic/360.0,0);
  end if;
  v_replace_id:=nullif(p_details->>'replace_record_id','');
  if v_replace_id is not null then
    if p_action='MARK_PAID' then raise exception 'Cannot change dates while recording a payment'; end if;
    select * into v_replace from public.salary_records
      where id=v_replace_id and staff_id=p_staff_id for update;
    if not found then raise exception 'Payroll to revise was not found'; end if;
    if v_replace.payroll_status='PAID' or v_replace.payroll_details='{}'::jsonb then
      raise exception 'Paid or legacy payroll cannot be revised';
    end if;
    if v_replace.period_start=p_period_start or
       not (daterange(v_replace.period_start,v_replace.period_end,'[]') && daterange(p_period_start,p_period_end,'[]')) then
      raise exception 'Select the overlapping payroll to revise';
    end if;
    if exists(select 1 from public.staff_advance_deductions where salary_record_id=v_replace.id)
       or exists(select 1 from public.extra_time_payments where salary_record_id=v_replace.id) then
      raise exception 'This payroll has posted advances or transfers; reconcile those before changing its period';
    end if;
    v_old_status:=v_replace.payroll_status;
  else
    select * into v_existing from public.salary_records where staff_id=p_staff_id and period_start=p_period_start for update;
    v_old_status:=v_existing.payroll_status;
    if v_existing.id is not null and v_existing.period_end<>p_period_end and
      (exists(select 1 from public.staff_advance_deductions where salary_record_id=v_existing.id)
       or exists(select 1 from public.extra_time_payments where salary_record_id=v_existing.id)) then
      raise exception 'This payroll has posted advances or transfers; its dates cannot be changed';end if;
  end if;
  if v_old_status='PAID' and p_action<>'MARK_PAID' then raise exception 'Paid payroll is locked; use a separate adjustment'; end if;
  if p_action='MARK_PAID' and v_old_status is distinct from 'FINALIZED' then raise exception 'Finalize payroll before marking it paid'; end if;
  if p_action='MARK_PAID' and p_payment_method is null then raise exception 'Choose a payment method'; end if;
  if p_action='SAVE_DRAFT' and v_old_status='FINALIZED' then raise exception 'This payroll is already finalized'; end if;
  if exists(select 1 from public.salary_records r where r.staff_id=p_staff_id
      and r.period_start<>p_period_start and (v_replace_id is null or r.id<>v_replace_id)
      and daterange(r.period_start,r.period_end,'[]') && daterange(p_period_start,p_period_end,'[]')) then
    raise exception 'This pay period overlaps another payroll period for this staff member';
  end if;
  v_payroll_outlet:=coalesce(v_existing.outlet_id,v_replace.outlet_id,v_staff.outlet_id);
  v_new_status:=case p_action when 'SAVE_DRAFT' then 'DRAFT' when 'FINALIZE' then 'FINALIZED' else 'PAID' end;
  if p_action='MARK_PAID' then
    if v_existing.period_end is distinct from p_period_end or v_existing.pay_date is distinct from p_pay_date then raise exception 'Save finalized payroll changes before recording payment';end if;
    update public.salary_records set payroll_status='PAID',payment_method=p_payment_method,
      payment_reference=nullif(btrim(coalesce(p_payment_reference,'')),''),paid_at=now(),
      saved_by=v_actor.id,saved_by_name=v_actor.name,created_at=now()
      where id=v_existing.id
      returning * into v_row;
    insert into public.salary_payroll_audit(salary_record_id,actor_user_id,action,prior_status,new_status,payroll_details)
      values(v_row.id,v_actor.id,p_action,v_old_status,v_new_status,coalesce(v_row.payroll_details,'{}'::jsonb));
    return v_row;
  end if;


  if exists(select 1 from public.extra_time_payments ep join public.salary_records old on old.id=ep.salary_record_id
      join lateral jsonb_array_elements(coalesce(old.payroll_details->'extra_earnings','[]'::jsonb)) previous on (previous->>'transfer_id')::bigint=ep.id
      join lateral jsonb_array_elements(coalesce(p_details->'extra_earnings','[]'::jsonb)) next on (next->>'transfer_id')::bigint=ep.id
      where ep.salary_record_id=coalesce(v_existing.id,v_replace.id) and (previous->>'amount')::numeric<>(next->>'amount')::numeric) then
      raise exception 'Posted transfer amounts are locked; use a separate payroll adjustment';end if;
  v_late_final:=case when v_late_waived then 0 else v_late_penalty end;
  v_net_before_advance:=v_basic+v_holiday+v_ot+v_extra_earnings-v_absent_deduction-v_half_day_deduction-v_late_final
    -v_manual_advance-v_loan_deduction-v_extra_deductions;
  v_net:=v_net_before_advance;
  if p_action='FINALIZE' then
    if v_net_before_advance<0 then raise exception 'Deductions exceed earnings; adjust the payroll before finalizing'; end if;
    if exists(select 1 from public.salary_records where staff_id=p_staff_id and period_start>p_period_start
      and (v_replace_id is null or id<>v_replace_id) and payroll_status<>'DRAFT') then
      raise exception 'A later payroll exists; reconcile it before finalizing this period';
    end if;
    delete from public.staff_advance_deductions d using public.staff_advance_requests a
      where d.advance_id=a.id and a.staff_id=p_staff_id and d.period_start=p_period_start;
    v_left:=least(v_scheduled_advance,greatest(0,v_net_before_advance));
    for v_due in select * from private.advance_due(p_staff_id,p_period_start,p_period_end) where due>0 loop
      v_take:=least(v_due.due,v_due.balance,v_left);
      if v_take>0 then
        v_schedule_posted:=v_schedule_posted+v_take;v_left:=v_left-v_take;
      end if;
    end loop;
    if abs(v_schedule_posted-v_scheduled_advance)>0.01 then
      raise exception 'Scheduled advance deduction exceeds the installment due or payable balance';
    end if;
  v_net:=round(v_net_before_advance-v_schedule_posted,0);
  else
    v_net:=round(v_net-v_scheduled_advance,0);
  end if;

  p_details:=coalesce(p_details,'{}'::jsonb)||jsonb_build_object(
    'period_start',p_period_start,'period_end',p_period_end,'pay_date',p_pay_date,
    'calculated_net_salary',v_net,'basic_salary',v_basic,'holiday_days',v_holiday_days,'holiday_pay',v_holiday,
    'absent_deduction',v_absent_deduction,'half_days',v_half_days,'half_day_deduction',v_half_day_deduction,
    'late_mins',v_late_mins,'late_hours',v_late_hours,'late_penalty',v_late_penalty,
    'advance_installment_deduction',case when p_action='FINALIZE' then v_schedule_posted else v_scheduled_advance end,
    'loan_prev_balance',v_loan_balance,'loan_deduct_this_month',v_loan_deduction,
    'loan_remaining',case when coalesce((p_details->>'loan_remaining_manual')::boolean,false)
      then coalesce((p_details->>'loan_remaining')::numeric,0) else greatest(0,v_loan_balance-v_loan_deduction) end);
  if v_replace_id is not null then
    update public.salary_records set period_start=p_period_start where id=v_replace_id;
  end if;
  v_id:='SAL-'||v_payroll_outlet||'-'||p_staff_id||'-'||to_char(p_period_start,'YYYYMMDD');
  insert into public.salary_records(
    id,outlet_id,staff_id,period_start,period_end,pay_date,period_days,basic_salary,
    holiday_pay,holiday_days,present_days,absent_days,absent_deduction,late_mins,
    late_hours_edited,late_penalty,late_penalty_waived,petty_advance,ot_credit,
    loan_prev_balance,loan_deduct_this_month,loan_remaining,net_salary,saved_by,
    saved_by_name,created_at,payroll_status,payroll_details,payment_method,payment_reference,paid_at
  ) values (
    v_id,v_payroll_outlet,p_staff_id,p_period_start,p_period_end,p_pay_date,v_period_days,v_basic,
    v_holiday,v_holiday_days,v_present,v_absent,v_absent_deduction,v_late_mins,
    v_late_hours,v_late_final,v_late_waived,v_manual_advance+case when p_action='FINALIZE' then v_schedule_posted else v_scheduled_advance end,v_ot,
    v_loan_balance,v_loan_deduction,greatest(0,v_loan_balance-v_loan_deduction),v_net,v_actor.id,
    v_actor.name,now(),v_new_status,coalesce(p_details,'{}'::jsonb),null,null,null
  ) on conflict(outlet_id,staff_id,period_start) do update set
    period_end=excluded.period_end,pay_date=excluded.pay_date,period_days=excluded.period_days,
    basic_salary=excluded.basic_salary,holiday_pay=excluded.holiday_pay,holiday_days=excluded.holiday_days,
    present_days=excluded.present_days,absent_days=excluded.absent_days,absent_deduction=excluded.absent_deduction,
    late_mins=excluded.late_mins,late_hours_edited=excluded.late_hours_edited,late_penalty=excluded.late_penalty,
    late_penalty_waived=excluded.late_penalty_waived,petty_advance=excluded.petty_advance,ot_credit=excluded.ot_credit,
    loan_prev_balance=excluded.loan_prev_balance,loan_deduct_this_month=excluded.loan_deduct_this_month,
    loan_remaining=excluded.loan_remaining,net_salary=excluded.net_salary,saved_by=excluded.saved_by,
    saved_by_name=excluded.saved_by_name,created_at=now(),payroll_status=excluded.payroll_status,
    payroll_details=excluded.payroll_details,payment_method=null,payment_reference=null,paid_at=null
  returning * into v_row;
  if p_action='FINALIZE' then
    v_left:=v_schedule_posted;
    for v_due in select * from private.advance_due(p_staff_id,p_period_start,p_period_end) where due>0 loop
      v_take:=least(v_due.due,v_due.balance,v_left);
      if v_take>0 then
        insert into public.staff_advance_deductions(advance_id,period_start,amount,salary_record_id)
          values(v_due.advance_id,p_period_start,v_take,v_row.id);
        v_left:=v_left-v_take;
      end if;
    end loop;

    if exists(select 1 from public.extra_time_payments ep where ep.salary_record_id=v_row.id
      and (not exists(select 1 from jsonb_array_elements_text(coalesce(p_details->'included_transfer_ids','[]'::jsonb)) x where x.value::bigint=ep.id)
        or not exists(select 1 from jsonb_array_elements(coalesce(p_details->'extra_earnings','[]'::jsonb)) x where (x->>'transfer_id')::bigint=ep.id))) then
      raise exception 'Posted transfer earnings must remain included in this payroll';end if;
    if exists(select 1 from jsonb_array_elements_text(coalesce(p_details->'included_transfer_ids','[]'::jsonb)) t
      where (select count(*) from jsonb_array_elements(coalesce(p_details->'extra_earnings','[]'::jsonb)) x where (x->>'transfer_id')::bigint=t.value::bigint)<>1) then
      raise exception 'Each selected transfer needs exactly one earning entry';end if;
    if p_details ? 'included_transfer_ids' then
      if jsonb_typeof(p_details->'included_transfer_ids')<>'array' then raise exception 'Transfer selection must be a list'; end if;
      update public.extra_time_payments ep set status='PAID',salary_record_id=v_row.id,
        amount=(select (x->>'amount')::numeric from jsonb_array_elements(p_details->'extra_earnings') x where (x->>'transfer_id')::bigint=ep.id)
      where ep.id in (select value::bigint from jsonb_array_elements_text(p_details->'included_transfer_ids'))
        and ep.status='READY'
        and exists (
          select 1 from public.users u
          join public.extra_time_dispatches d on d.prepared_by=u.id
          join public.extra_time_requests r on r.id=d.request_id
          where u.staff_id=p_staff_id and d.id=ep.dispatch_id
            and (r.requested_at at time zone 'Asia/Kolkata')::date between p_period_start and p_period_end
        );
      if (select count(*) from jsonb_array_elements_text(p_details->'included_transfer_ids')) <>
         (select count(*) from public.extra_time_payments ep where ep.salary_record_id=v_row.id and ep.id in
           (select value::bigint from jsonb_array_elements_text(p_details->'included_transfer_ids'))) then
        raise exception 'One or more transfer payments are unavailable or already included in another payroll';
      end if;
    end if;
  end if;
  insert into public.salary_payroll_audit(salary_record_id,actor_user_id,action,prior_status,new_status,payroll_details)
    values(v_row.id,v_actor.id,p_action,v_old_status,v_new_status,coalesce(p_details,'{}'::jsonb));
  return v_row;
end $function$;

revoke all on function public.save_salary_payroll(integer,date,date,date,jsonb,text,uuid,text,text),public.get_salary_estimate_v2(integer,date,date) from public,anon;
grant execute on function public.save_salary_payroll(integer,date,date,date,jsonb,text,uuid,text,text),public.get_salary_estimate_v2(integer,date,date) to authenticated;
create or replace function public.get_salary_transfer_payments(p_staff_id integer,p_start date,p_end date,p_after_id bigint default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare v_actor public.users;v_rows jsonb;
begin
 select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;
 if not found or (coalesce(v_actor.access_class,'STAFF')<>'ADMIN' and coalesce(v_actor.staff_id,0)<>p_staff_id) then
   raise exception 'You can only view your own salary' using errcode='42501';end if;
 if p_start is null or p_end is null or p_end<p_start or p_end-p_start>366 then raise exception 'Invalid salary period';end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) into v_rows from(
  select ep.id,ep.category,ep.basis_qty,ep.basis_unit,ep.rate,ep.amount,ep.status,ep.salary_record_id,
    jsonb_build_object('extra_time_requests',jsonb_build_object('request_group',r.request_group,'requested_at',r.requested_at)) extra_time_dispatches
  from public.extra_time_payments ep join public.users u on u.id=ep.staff_user_id
  join public.extra_time_dispatches d on d.id=ep.dispatch_id join public.extra_time_requests r on r.id=d.request_id
  where u.staff_id=p_staff_id and ep.status in('READY','PAID') and ep.id>coalesce(p_after_id,0)
    and (r.requested_at at time zone 'Asia/Kolkata')::date between p_start and p_end
  order by ep.id limit 300
 ) x;
 return v_rows;
end $function$;
revoke all on function public.get_salary_transfer_payments(integer,date,date,bigint) from public,anon;
grant execute on function public.get_salary_transfer_payments(integer,date,date,bigint) to authenticated;
create or replace function public.owner_save_staff_profile(p_staff_id integer,p_expected jsonb,p_changes jsonb)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare v_staff public.staff;v_user public.users;v_snapshot jsonb;v_status text;v_result jsonb;
begin
 if not private.is_admin() then raise exception 'Owner access required' using errcode='42501';end if;
 select * into v_staff from public.staff where id=p_staff_id for update;
 select * into v_user from public.users where staff_id=p_staff_id for update;
 if v_staff.id is null or v_user.id is null then raise exception 'Staff profile not found';end if;
 v_snapshot:=jsonb_build_object('name',v_staff.name,'outlet_id',v_staff.outlet_id,'basic_salary',v_staff.basic_salary,
  'joining_date',v_staff.joining_date,'notes',v_staff.notes,'role',v_user.role,'permissions',coalesce(v_user.permissions,'{}'::jsonb),
  'employment_status',v_staff.employment_status,'status_effective_from',v_staff.status_effective_from,'status_note',v_staff.status_note);
 if p_expected is distinct from v_snapshot then raise exception 'This profile changed since you opened it. Reopen it before saving';end if;
 v_status:=upper(p_changes->>'employment_status');
 if v_status is null or v_status not in('ACTIVE','VACATION','LEAVE','INACTIVE','LEFT') then raise exception 'Choose a valid employment status';end if;
 v_result:=public.owner_update_staff(p_staff_id,p_changes->>'name',(p_changes->>'outlet_id')::integer,p_changes->>'role',
   (p_changes->>'basic_salary')::numeric,(p_changes->>'joining_date')::date,v_status not in('INACTIVE','LEFT'),p_changes->'permissions',p_changes->>'notes');
 if v_status is distinct from v_staff.employment_status or (p_changes->>'status_effective_from')::date is distinct from v_staff.status_effective_from
   or nullif(trim(coalesce(p_changes->>'status_note','')),'') is distinct from v_staff.status_note then
   perform public.owner_set_staff_status(p_staff_id,v_status,(p_changes->>'status_effective_from')::date,p_changes->>'status_note');end if;
 return v_result;
end $function$;
revoke all on function public.owner_save_staff_profile(integer,jsonb,jsonb) from public,anon;
grant execute on function public.owner_save_staff_profile(integer,jsonb,jsonb) to authenticated;
revoke execute on function public.owner_update_staff(integer,text,integer,text,numeric,date,boolean,jsonb,text) from public,anon,authenticated;
revoke execute on function public.finalize_salary_record_v2(integer,date,date,date,uuid) from public,anon,authenticated;
create or replace function public.get_app_release()
returns jsonb language sql immutable set search_path='' as $function$
 select jsonb_build_object('schema_build',128)
$function$;
revoke all on function public.get_app_release() from public;
grant execute on function public.get_app_release() to anon,authenticated;
notify pgrst,'reload schema';
