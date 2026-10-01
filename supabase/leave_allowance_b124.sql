-- B124: preview each joining-day salary month's three-day allowance.
create or replace function public.get_leave_allowance(
  p_start_date date,p_end_date date,p_leave_type varchar default 'LEAVE'
) returns jsonb language plpgsql security definer set search_path='' as $function$
declare
  v_actor public.users;v_staff public.staff;v_day integer;v_month date;
  v_start date;v_next_month date;v_next_start date;v_end date;
  v_taken integer;v_pending integer;v_added integer;v_requested numeric;
  v_periods jsonb:='[]'::jsonb;v_half boolean:=upper(coalesce(p_leave_type,'LEAVE'))='HALF_DAY';
begin
  select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;
  if not found or v_actor.staff_id is null then raise exception 'Linked staff profile required';end if;
  select * into v_staff from public.staff where id=v_actor.staff_id;
  if not found then raise exception 'Staff not found';end if;
  if p_start_date is null or p_end_date is null or p_end_date<p_start_date or p_end_date-p_start_date>366 then
    raise exception 'Choose a valid leave date range of up to one year';
  end if;
  if v_half and p_start_date<>p_end_date then raise exception 'Half-day leave must be for one date';end if;
  v_day:=coalesce(extract(day from v_staff.joining_date)::integer,1);
  v_month:=date_trunc('month',p_start_date)::date;
  v_start:=v_month+least(v_day,extract(day from (v_month+interval '1 month - 1 day'))::integer)-1;
  if p_start_date<v_start then v_month:=(v_month-interval '1 month')::date;end if;
  loop
    v_start:=v_month+least(v_day,extract(day from (v_month+interval '1 month - 1 day'))::integer)-1;
    exit when v_start>p_end_date;
    v_next_month:=(v_month+interval '1 month')::date;
    v_next_start:=v_next_month+least(v_day,extract(day from (v_next_month+interval '1 month - 1 day'))::integer)-1;
    v_end:=v_next_start-1;
    with days as(select generate_series(v_start,v_end,interval '1 day')::date d),
    booked as(
      select d,
        exists(select 1 from public.attendance a where a.staff_id=v_staff.id and a.attendance_date=d and a.status in('Absent','Leave'))
        or exists(select 1 from public.leave_requests l where l.staff_id=v_staff.id and l.status='APPROVED'
          and upper(l.leave_type)<>'HALF_DAY' and d between l.start_date and l.end_date) taken,
        exists(select 1 from public.leave_requests l where l.staff_id=v_staff.id and l.status='PENDING'
          and upper(l.leave_type)<>'HALF_DAY' and d between l.start_date and l.end_date) pending
      from days
    )
    select count(*) filter(where taken),count(*) filter(where pending and not taken),
      count(*) filter(where not v_half and d between p_start_date and p_end_date and not taken and not pending)
    into v_taken,v_pending,v_added from booked;
    v_requested:=case when v_half then .5 else least(p_end_date,v_end)-greatest(p_start_date,v_start)+1 end;
    v_periods:=v_periods||jsonb_build_array(jsonb_build_object(
      'period_start',v_start,'period_end',v_end,'used_days',v_taken,'pending_days',v_pending,
      'available_days',greatest(0,3-v_taken-v_pending),'requested_days',v_requested,
      'projected_days_off',v_taken+v_pending+v_added,'exceeds_allowance',not v_half and v_taken+v_pending+v_added>3
    ));
    v_month:=v_next_month;
  end loop;
  return jsonb_build_object('days_requested',case when v_half then .5 else p_end_date-p_start_date+1 end,'periods',v_periods);
end $function$;
revoke all on function public.get_leave_allowance(date,date,varchar) from public,anon;
grant execute on function public.get_leave_allowance(date,date,varchar) to authenticated;
