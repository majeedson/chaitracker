-- B134: dated staff shifts, photo check-in for all employees, safe corrections.
create table public.staff_shift_settings(
 id bigint generated always as identity primary key,staff_id integer not null references public.staff(id),
 effective_from date not null,start_time time,changed_by uuid not null references public.users(id),
 created_at timestamptz not null default now(),unique(staff_id,effective_from));
alter table public.staff_shift_settings enable row level security;
grant select on public.staff_shift_settings to authenticated;
create policy staff_shift_settings_read on public.staff_shift_settings for select to authenticated using(
 exists(select 1 from public.users where auth_user_id=auth.uid() and active=true and deleted_at is null and (access_class='ADMIN' or staff_id=staff_shift_settings.staff_id)));
create or replace function private.resolve_staff_shift(p_staff_id integer,p_date date)
returns time language sql stable security definer set search_path='' as $$
 select coalesce((select start_time from public.staff_shifts where staff_id=p_staff_id and shift_date=p_date),
 (select start_time from public.staff_shift_settings where staff_id=p_staff_id and effective_from<=p_date order by effective_from desc limit 1),
 make_time(((coalesce(o.shift_start_hour,11)*60+coalesce(o.shift_start_minute,0)+case when u.role in('Manager','Ops Manager') then coalesce(o.manager_shift_offset_minutes,120) else 0 end)/60)%24,
 (coalesce(o.shift_start_minute,0)+case when u.role in('Manager','Ops Manager') then coalesce(o.manager_shift_offset_minutes,120) else 0 end)%60,0))
 from public.staff s join public.outlets o on o.id=s.outlet_id left join public.users u on u.staff_id=s.id where s.id=p_staff_id
$$;
revoke all on function private.resolve_staff_shift(integer,date) from public,anon,authenticated;
create or replace function public.get_staff_shift_settings(p_staff_id integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_actor public.users;v_date date;v_time time;v_history jsonb;
begin
 select * into v_actor from public.users where auth_user_id=auth.uid() and active and deleted_at is null;
 if v_actor.id is null or (v_actor.access_class<>'ADMIN' and v_actor.staff_id is distinct from p_staff_id) then raise exception 'Shift access denied' using errcode='42501';end if;
 select public.get_effective_business_day(outlet_id,now()) into v_date from public.staff where id=p_staff_id;
 if v_date is null then raise exception 'Employee not found';end if;
 v_time:=private.resolve_staff_shift(p_staff_id,v_date);
 select coalesce(jsonb_agg(jsonb_build_object('effective_from',effective_from,'start_time',start_time) order by effective_from desc),'[]'::jsonb) into v_history from public.staff_shift_settings where staff_id=p_staff_id;
 return jsonb_build_object('business_date',v_date,'effective_start',v_time,'history',v_history);
end $$;
create or replace function public.admin_save_staff_shift(p_staff_id integer,p_start_time time,p_effective_from date)
returns void language plpgsql security definer set search_path='' as $$
declare v_actor public.users;v_outlet integer;v_day date;
begin
 select * into v_actor from public.users where auth_user_id=auth.uid() and active and deleted_at is null;
 if v_actor.id is null or v_actor.access_class<>'ADMIN' then raise exception 'Admin access required' using errcode='42501';end if;
 select outlet_id into v_outlet from public.staff where id=p_staff_id for update;
 if v_outlet is null or exists(select 1 from public.users where staff_id=p_staff_id and deleted_at is not null) then raise exception 'Active employment record required';end if;
 v_day:=public.get_effective_business_day(v_outlet,now());
 if p_effective_from is null or p_effective_from<v_day then raise exception 'Shift changes must take effect today or later; historical attendance is preserved';end if;
 insert into public.staff_shift_settings(staff_id,effective_from,start_time,changed_by) values(p_staff_id,p_effective_from,p_start_time,v_actor.id)
 on conflict(staff_id,effective_from) do update set start_time=excluded.start_time,changed_by=excluded.changed_by,created_at=now();
 insert into public.admin_access_audit(action,target_user_id,target_name,performed_by,details)
 select 'SET_STAFF_SHIFT',id,name,v_actor.id,jsonb_build_object('start_time',p_start_time,'effective_from',p_effective_from) from public.users where staff_id=p_staff_id;
end $$;
revoke all on function public.get_staff_shift_settings(integer),public.admin_save_staff_shift(integer,time,date) from public,anon;
grant execute on function public.get_staff_shift_settings(integer),public.admin_save_staff_shift(integer,time,date) to authenticated;
create or replace function private.has_photo_checkin(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.users u join public.staff s on s.id=u.staff_id join public.attendance a on a.staff_id=s.id
 join storage.objects f on f.bucket_id='attendance-photos' and f.name=a.photo_url
 where u.id=p_user_id and u.active and u.deleted_at is null and s.active and a.punch_time is not null
 and a.attendance_date=public.get_effective_business_day(u.outlet_id,now()))
$$;
revoke all on function private.has_photo_checkin(uuid) from public,anon,authenticated;
create or replace function public.get_photo_checkin_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_user public.users;v_day date;
begin
 select * into v_user from public.users where auth_user_id=auth.uid() and active and deleted_at is null;
 if v_user.id is null then raise exception 'Authenticated account required' using errcode='42501';end if;
 if v_user.access_class='ADMIN' then return jsonb_build_object('required',false,'checked_in',true);end if;
 v_day:=public.get_effective_business_day(v_user.outlet_id,now());
 return jsonb_build_object('required',true,'checked_in',private.has_photo_checkin(v_user.id),'business_date',v_day,
 'shift_start',private.resolve_staff_shift(v_user.staff_id,v_day),
 'punch_time',(select punch_time from public.attendance where staff_id=v_user.staff_id and attendance_date=v_day));
end $$;
revoke all on function public.get_photo_checkin_status() from public,anon;
grant execute on function public.get_photo_checkin_status() to authenticated;
create or replace function public.record_staff_photo_checkin(p_user_id uuid,p_photo_path text)
returns public.attendance language plpgsql security definer set search_path='' as $$
declare v_user public.users;v_staff public.staff;v_day date;v_shift time;v_punch time;v_raw integer;v_late integer;v_outlet public.outlets;v_row public.attendance;
begin
 select * into v_user from public.users where id=p_user_id for update;
 if v_user.id is null or not v_user.active or v_user.deleted_at is not null or v_user.access_class='ADMIN' then raise exception 'Active employee required';end if;
 select * into v_staff from public.staff where id=v_user.staff_id;
 if v_staff.id is null or not v_staff.active or v_staff.outlet_id is distinct from v_user.outlet_id then raise exception 'Active staff link required';end if;
 select * into v_outlet from public.outlets where id=v_user.outlet_id;
 v_day:=public.get_effective_business_day(v_user.outlet_id,now());v_punch:=(now() at time zone coalesce(v_outlet.timezone,'Asia/Kolkata'))::time;
 if p_photo_path is null or p_photo_path not like v_staff.id::text||'/'||v_day::text||'/%' or not exists(select 1 from storage.objects where bucket_id='attendance-photos' and name=p_photo_path) then raise exception 'Stored check-in photo required';end if;
 if exists(select 1 from public.attendance where staff_id=v_staff.id and attendance_date=v_day) then raise exception 'Attendance already recorded; contact an admin if it needs correction';end if;
 v_shift:=private.resolve_staff_shift(v_staff.id,v_day);
 v_raw:=greatest(0,floor(extract(epoch from ((((now() at time zone coalesce(v_outlet.timezone,'Asia/Kolkata'))::date+v_punch)-(v_day+v_shift))))/60)::integer);
 v_late:=case when v_raw<=coalesce(v_outlet.attendance_grace_minutes,15) then 0 else v_raw end;
 insert into public.attendance(attendance_date,outlet_id,staff_id,shift_start,punch_time,late_mins,half_day,status,photo_url)
 values(v_day,v_user.outlet_id,v_staff.id,v_shift,v_punch,v_late,v_late>=coalesce(v_outlet.half_day_late_minutes,240),
 case when v_late>=coalesce(v_outlet.half_day_late_minutes,240) then 'HalfDay' else 'Present' end,p_photo_path) returning * into v_row;
 return v_row;
end $$;
revoke all on function public.record_staff_photo_checkin(uuid,text) from public,anon,authenticated;
grant execute on function public.record_staff_photo_checkin(uuid,text) to service_role;
alter table public.attendance_corrections add column original_punch_time time;
alter table public.attendance_corrections add column original_photo_url text;

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
      a.id attendance_id,a.punch_time,a.photo_url,a.half_day stored_half_day,a.status stored_status,a.late_mins stored_late,
      lr.id leave_id,lr.leave_type approved_leave_type,
      ss.shift_type,ss.status shift_status,
      coalesce(a.shift_start,private.resolve_staff_shift(g.id,g.d)) effective_shift,
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
           else coalesce(r.stored_late,greatest(0,round(extract(epoch from (r.punch_time-r.effective_shift))/60)::int)) end raw_late
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
$function$;

CREATE OR REPLACE FUNCTION public.correct_attendance(p_attendance_id integer, p_punch_time time without time zone, p_reason text)
 RETURNS attendance
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor public.users;
  v_att public.attendance;
  v_staff_role varchar;
  v_grace integer;
  v_half integer;
  v_raw integer;
begin
  select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;
  if not found or (v_actor.access_class<>'ADMIN' and v_actor.role not in ('Manager','Ops Manager')) then raise exception 'Manager or Owner access required'; end if;
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'Correction reason is required'; end if;

  if p_punch_time is null then raise exception 'Check-in time is required';end if;
  select * into v_att from public.attendance where id=p_attendance_id for update;
  if not found then raise exception 'Attendance record not found'; end if;
  if v_actor.access_class<>'ADMIN' then
    if v_att.staff_id=v_actor.staff_id then raise exception 'Managers cannot correct their own attendance; ask an admin';end if;
    if not exists(select 1 from storage.objects where bucket_id='attendance-photos' and name=v_att.photo_url) then raise exception 'Photo check-in required before manager correction';end if;
    if v_actor.outlet_id<>v_att.outlet_id then raise exception 'Outlet access denied'; end if;
    if v_att.attendance_date < ((now() at time zone coalesce((select timezone from public.outlets where id=v_att.outlet_id),'Asia/Kolkata'))::date - 1)
      then raise exception 'Manager can correct only today or yesterday. Owner access required.'; end if;
  end if;

  select coalesce(u.role,'Staff') into v_staff_role from public.staff s left join public.users u on u.staff_id=s.id and u.active=true where s.id=v_att.staff_id limit 1;
  select coalesce(attendance_grace_minutes,15),coalesce(half_day_late_minutes,240) into v_grace,v_half from public.outlets where id=v_att.outlet_id;
  v_raw:=greatest(0,round(extract(epoch from (p_punch_time-v_att.shift_start))/60)::int);

  insert into public.attendance_corrections(attendance_id,staff_id,outlet_id,attendance_date,requested_punch_time,reason,status,requested_by,reviewed_by,reviewed_at,review_note,original_punch_time,original_photo_url)
  values(v_att.id,v_att.staff_id,v_att.outlet_id,v_att.attendance_date,
    ((v_att.attendance_date+p_punch_time) at time zone coalesce((select timezone from public.outlets where id=v_att.outlet_id),'Asia/Kolkata')),
    trim(p_reason),'APPROVED',v_actor.id,v_actor.id,now(),'Direct manager/owner correction',v_att.punch_time,v_att.photo_url);

  update public.attendance
  set punch_time=p_punch_time,
      late_mins=case when v_raw<=v_grace then 0 else v_raw end,
      half_day=(case when v_raw<=v_grace then 0 else v_raw end)>=v_half,
      status=case when (case when v_raw<=v_grace then 0 else v_raw end)>=v_half then 'HALF_DAY'
                  when (case when v_raw<=v_grace then 0 else v_raw end)>0 then 'LATE'
                  else 'ON_TIME' end
  where id=p_attendance_id returning * into v_att;
  return v_att;
end;
$function$;

CREATE OR REPLACE FUNCTION private.has_module_access(p_module text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select case
    when u.access_class='ADMIN' then true
    when not private.has_photo_checkin(u.id) then false
    when p_module not in('orders','purchase','extra-time','delta','summary') then false
    when jsonb_typeof(u.permissions->'module_access'->p_module)='boolean'
      then (u.permissions->'module_access'->>p_module)::boolean
    else p_module in('orders','purchase','extra-time')
      or (p_module='summary' and u.role in('Manager','Ops Manager'))
    end from public.users u where u.auth_user_id=auth.uid() and u.active limit 1),false)
$function$;

create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $$ select jsonb_build_object('schema_build',134) $$;
notify pgrst,'reload schema';
