-- Keep source records private and preserve the complete source-row provenance.
create table private.attendance_sheet_imports(
 batch_id uuid not null,spreadsheet_id text not null,source_row integer not null,
 staff_id integer not null references public.staff(id),attendance_id integer references public.attendance(id),
 source_values jsonb not null,record_values jsonb not null,photo_metadata jsonb,
 disposition text,imported_at timestamptz not null default now(),primary key(batch_id,source_row));
alter table private.attendance_sheet_imports enable row level security;
revoke all on private.attendance_sheet_imports from public,anon,authenticated;
create index attendance_sheet_imports_record_idx on private.attendance_sheet_imports(attendance_id);

-- Admin history views include inactive/archived employees and actual historical outlets.
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
      and (s.active=true or (v_actor.access_class='ADMIN' and p_staff_id=s.id))
  ),
  grid as (
    select d.d,p.*
    from dates d cross join people p
    where ((p.joining_date is null or d.d>=p.joining_date)
      and (p.employment_end_date is null or d.d<=p.employment_end_date))
      or exists(select 1 from public.attendance recorded where recorded.staff_id=p.id and recorded.attendance_date=d.d)
  ),
  resolved as (
    select g.*,a.outlet_id recorded_outlet_id,
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
    c.d,c.id,c.name,coalesce(c.recorded_outlet_id,c.outlet_id),o.name,c.effective_shift,c.punch_time,
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
  join public.outlets o on o.id=coalesce(c.recorded_outlet_id,c.outlet_id)
  order by c.d desc,c.name;
end;
$function$;
notify pgrst,'reload schema';
