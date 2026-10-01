-- B123: half-day leave requests and approved leave overlays for attendance/payroll.
alter table public.leave_requests add constraint leave_requests_half_day_date_check check (upper(leave_type)<>'HALF_DAY' or start_date=end_date);

CREATE OR REPLACE FUNCTION public.submit_leave_request(p_start_date date, p_end_date date, p_leave_type character varying, p_reason text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor public.users;v_id bigint;v_type varchar;
begin
 select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;if not found or v_actor.staff_id is null then raise exception 'Linked staff profile required';end if;
 v_type:=upper(coalesce(nullif(trim(p_leave_type),''),'LEAVE'));
 if p_start_date is null or p_end_date is null then raise exception 'Choose the leave dates';end if;
 if p_end_date<p_start_date then raise exception 'End date cannot be before start date';end if;
 if v_type='HALF_DAY' and p_start_date<>p_end_date then raise exception 'Half-day leave must be for one date';end if;
 perform 1 from public.staff where id=v_actor.staff_id for update;
 if exists(select 1 from public.leave_requests l where l.staff_id=v_actor.staff_id and l.status in('PENDING','APPROVED')
   and daterange(l.start_date,l.end_date,'[]') && daterange(p_start_date,p_end_date,'[]')) then
   raise exception 'A pending or approved leave request already covers these dates';
 end if;

 insert into public.leave_requests(staff_id,user_id,outlet_id,leave_type,start_date,end_date,reason,status,requested_at) values(v_actor.staff_id,v_actor.id,v_actor.outlet_id,v_type,p_start_date,p_end_date,nullif(trim(p_reason),''),'PENDING',now()) returning id into v_id;return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.review_leave_request(p_request_id bigint, p_status character varying, p_review_note text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor public.users;v_req public.leave_requests;v_admin boolean;
begin
 select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;if not found then raise exception 'Authenticated CafeTracker user required';end if;
 v_admin:=coalesce(v_actor.access_class,'STAFF')='ADMIN';if not v_admin and v_actor.role not in('Manager','Ops Manager') then raise exception 'Manager or Admin access required';end if;
 select * into v_req from public.leave_requests where id=p_request_id for update;if not found then raise exception 'Leave request not found';end if;
 if not v_admin and v_actor.outlet_id<>v_req.outlet_id then raise exception 'You cannot review another outlet request';end if;
 if v_req.status<>'PENDING' then raise exception 'This request has already been reviewed';end if;
 perform 1 from public.staff where id=v_req.staff_id for update;
 if upper(p_status)='APPROVED' and exists(select 1 from public.leave_requests l
   where l.staff_id=v_req.staff_id and l.id<>v_req.id and l.status='APPROVED'
   and daterange(l.start_date,l.end_date,'[]') && daterange(v_req.start_date,v_req.end_date,'[]')) then
   raise exception 'Another approved leave request already covers these dates';
 end if;
 if upper(p_status) not in('APPROVED','REJECTED') then raise exception 'Status must be APPROVED or REJECTED';end if;
 update public.leave_requests set status=upper(p_status),reviewed_by=v_actor.id,reviewed_at=now(),review_note=nullif(trim(p_review_note),'') where id=p_request_id;return true;
end $function$;

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
    case when c.raw_late<=c.grace_mins then 0 else c.raw_late end,
    (case
      when c.attendance_id is not null and c.leave_id is not null and upper(coalesce(c.approved_leave_type,''))<>'HALF_DAY' then 'NEEDS_REVIEW'
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
    (c.attendance_id is not null and (upper(coalesce(c.approved_leave_type,''))='HALF_DAY' or coalesce(c.stored_half_day,false) or (case when c.raw_late<=c.grace_mins then 0 else c.raw_late end)>=c.half_threshold)),
    c.photo_url,
    c.d > (now() at time zone v_tz)::date,
    c.attendance_id is not null and c.leave_id is not null and upper(coalesce(c.approved_leave_type,''))<>'HALF_DAY'
  from calc c
  join public.outlets o on o.id=c.outlet_id
  order by c.d desc,c.name;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_salary_estimate_internal(p_staff_id integer, p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_staff public.staff%rowtype;v_calc_start date;v_days int;v_present numeric:=0;v_half numeric:=0;v_absent numeric:=0;v_leave numeric:=0;v_recorded_days int:=0;v_unrecorded int:=0;v_late_mins int:=0;v_late_hours int:=0;v_off_worked int:=0;v_daily numeric:=0;v_hourly numeric:=0;v_paid_off numeric:=0;v_absent_ded numeric:=0;v_half_ded numeric:=0;v_late_ded numeric:=0;v_holiday numeric:=0;v_advance numeric:=0;v_loan numeric:=0;v_net numeric:=0;
begin
 if p_end<p_start then raise exception 'Invalid salary period';end if;
 select * into v_staff from public.staff where id=p_staff_id;if not found then raise exception 'Staff not found';end if;
 v_calc_start:=greatest(p_start,coalesce(v_staff.joining_date,p_start));
 if v_calc_start>p_end then return jsonb_build_object('period_days',0,'basic_salary',coalesce(v_staff.basic_salary,0),'daily_rate',coalesce(v_staff.basic_salary,0)/30.0,'hourly_rate',coalesce(v_staff.basic_salary,0)/360.0,'present_equivalent_days',0,'half_days',0,'absent_days',0,'leave_days',0,'paid_off_days',0,'unrecorded_days',0,'data_complete',true,'holiday_duty_days',0,'holiday_duty_allowance',0,'late_mins',0,'deductible_late_hours',0,'late_deduction',0,'absent_deduction',0,'half_day_deduction',0,'advance_deduction',0,'loan_deduction',0,'estimated_net',0);end if;
 v_days:=(p_end-v_calc_start)+1;v_daily:=coalesce(v_staff.basic_salary,0)/30.0;v_hourly:=v_daily/12.0;
 with a as(select distinct on(attendance_date) attendance_date,status,(coalesce(half_day,false) or exists(select 1 from public.leave_requests l where l.staff_id=p_staff_id
   and l.status='APPROVED' and upper(l.leave_type)='HALF_DAY' and attendance_date between l.start_date and l.end_date)) half_day,coalesce(late_mins,0) late_mins from public.attendance where staff_id=p_staff_id and attendance_date between v_calc_start and p_end order by attendance_date,created_at asc,id asc)
 select count(*),coalesce(sum(case when status='Absent' then 0 when status='Leave' then 0 when half_day or status='HalfDay' then .5 else 1 end),0),coalesce(sum(case when status not in('Absent','Leave') and (half_day or status='HalfDay') then 1 else 0 end),0),coalesce(sum(case when status='Absent' then 1 else 0 end),0),coalesce(sum(case when status='Leave' then 1 else 0 end),0),coalesce(sum(case when status not in('Absent','Leave') then late_mins else 0 end),0)
 into v_recorded_days,v_present,v_half,v_absent,v_leave,v_late_mins from a;
 v_unrecorded:=greatest(0,v_days-v_recorded_days);v_late_hours:=floor(v_late_mins/60.0);
 v_paid_off:=least(3,v_leave);
 select count(*) into v_off_worked from public.attendance a where a.staff_id=p_staff_id and a.attendance_date between v_calc_start and p_end and a.status not in('Absent','Leave') and exists(select 1 from public.staff_weekly_offs w where w.staff_id=p_staff_id and w.day_of_week=extract(dow from a.attendance_date)::int and w.effective_from<=a.attendance_date and(w.effective_to is null or w.effective_to>=a.attendance_date));
 select coalesce(sum(case when lower(payment_type) in('advance','petty advance','petty_advance') then amount else 0 end),0),coalesce(sum(case when lower(payment_type) in('loan','loan deduction','loan_deduction') then amount else 0 end),0) into v_advance,v_loan from public.staff_payments where staff_id=p_staff_id and business_date between v_calc_start and p_end;
 v_absent_ded:=v_absent*v_daily;v_half_ded:=v_half*(v_daily/2.0);v_late_ded:=v_late_hours*v_hourly;v_holiday:=v_off_worked*v_daily;v_net:=coalesce(v_staff.basic_salary,0)+v_holiday-v_absent_ded-v_half_ded-v_late_ded-v_advance-v_loan;
 return jsonb_build_object('period_days',v_days,'basic_salary',coalesce(v_staff.basic_salary,0),'daily_rate',v_daily,'hourly_rate',v_hourly,'present_equivalent_days',v_present,'half_days',v_half,'absent_days',v_absent,'leave_days',v_leave,'paid_off_days',v_paid_off,'unrecorded_days',v_unrecorded,'data_complete',v_unrecorded=0,'holiday_duty_days',v_off_worked,'holiday_duty_allowance',v_holiday,'late_mins',v_late_mins,'deductible_late_hours',v_late_hours,'late_deduction',v_late_ded,'absent_deduction',v_absent_ded,'half_day_deduction',v_half_ded,'advance_deduction',v_advance,'loan_deduction',v_loan,'estimated_net',v_net);
end $function$;

revoke all on function public.submit_leave_request(date,date,varchar,text), public.review_leave_request(bigint,varchar,text), public.get_attendance_calendar(integer,integer,date,date) from public,anon;
grant execute on function public.submit_leave_request(date,date,varchar,text), public.review_leave_request(bigint,varchar,text), public.get_attendance_calendar(integer,integer,date,date) to authenticated;

