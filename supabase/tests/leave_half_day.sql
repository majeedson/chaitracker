-- Integration probe. All request/attendance changes roll back in the inner block.
do $probe$
declare
  v_user public.users;v_admin public.users;v_date date;v_id bigint;v_result jsonb;v_before jsonb;
  v_calendar record;v_message text;v_missing date;
begin
  select u.* into v_user from public.users u join public.staff s on s.id=u.staff_id
  where u.active and u.auth_user_id is not null and u.access_class<>'ADMIN'
    and s.active and s.employment_end_date is null and u.outlet_id=s.outlet_id
    and exists(select 1 from public.attendance a where a.staff_id=s.id and a.status not in('Absent','Leave','HalfDay')
      and not coalesce(a.half_day,false) and not exists(select 1 from public.leave_requests l
        where l.staff_id=s.id and l.status in('APPROVED','PENDING') and a.attendance_date between l.start_date and l.end_date))
  order by u.id limit 1;
  if v_user.id is null then raise exception 'No eligible attendance fixture';end if;
  select * into v_admin from public.users where active and access_class='ADMIN' and role='Owner' and auth_user_id is not null limit 1;
  select a.attendance_date into v_date from public.attendance a where a.staff_id=v_user.staff_id
    and a.status not in('Absent','Leave','HalfDay') and not coalesce(a.half_day,false)
    and not exists(select 1 from public.leave_requests l where l.staff_id=v_user.staff_id and l.status in('APPROVED','PENDING')
      and a.attendance_date between l.start_date and l.end_date) order by a.attendance_date desc limit 1;
  begin
    perform set_config('request.jwt.claim.sub',v_user.auth_user_id::text,true);
    v_before:=public.get_salary_estimate(v_user.staff_id,v_date,v_date);
    v_id:=public.submit_leave_request(v_date,v_date,'HALF_DAY','Half-day integration probe');
    v_result:=public.get_salary_estimate(v_user.staff_id,v_date,v_date);
    if v_result->>'half_days'<>v_before->>'half_days' then raise exception 'Pending request changed payroll';end if;
    perform set_config('request.jwt.claim.sub',v_admin.auth_user_id::text,true);
    perform public.review_leave_request(v_id,'APPROVED',null);
    select * into v_calendar from public.get_attendance_calendar(v_user.outlet_id,v_user.staff_id,v_date,v_date) limit 1;
    if v_calendar.status<>'HALF_DAY' or not v_calendar.half_day or v_calendar.needs_review then
      raise exception 'Approved half-day attendance was not resolved';
    end if;
    v_result:=public.get_salary_estimate(v_user.staff_id,v_date,v_date);
    if (v_result->>'half_days')::numeric<>1 or (v_result->>'present_equivalent_days')::numeric<>.5 then
      raise exception 'Approved half-day payroll counts are wrong';
    end if;
    update public.attendance set half_day=true where staff_id=v_user.staff_id and attendance_date=v_date;
    v_result:=public.get_salary_estimate(v_user.staff_id,v_date,v_date);
    if (v_result->>'half_days')::numeric<>1 then raise exception 'Half-day was counted twice';end if;
    perform set_config('request.jwt.claim.sub',v_user.auth_user_id::text,true);
    begin
      perform public.submit_leave_request(v_date,v_date+1,'HALF_DAY','Invalid half-day range');
      raise exception 'Half-day date validation failed';
    exception when raise_exception then
      get stacked diagnostics v_message=message_text;
      if v_message<>'Half-day leave must be for one date' then raise;end if;
    end;
    v_missing:=current_date+400;
    v_id:=public.submit_leave_request(v_missing,v_missing,'HALF_DAY','Missing check-in probe');
    perform set_config('request.jwt.claim.sub',v_admin.auth_user_id::text,true);
    perform public.review_leave_request(v_id,'APPROVED',null);
    v_result:=public.get_salary_estimate(v_user.staff_id,v_missing,v_missing);
    if (v_result->>'half_days')::numeric<>0 or (v_result->>'unrecorded_days')::numeric<>1 then
      raise exception 'Unrecorded work was counted as present';
    end if;
    perform set_config('request.jwt.claim.sub',v_user.auth_user_id::text,true);
    v_result:=public.get_leave_allowance(v_missing,v_missing,'HALF_DAY');
    if (v_result->>'days_requested')::numeric<>.5 or (v_result->'periods'->0->>'exceeds_allowance')::boolean then
      raise exception 'Half-day preview changed full-day allowance';
    end if;
    v_result:=public.get_leave_allowance(v_missing+1,v_missing+4,'LEAVE');
    if (v_result->>'days_requested')::numeric<>4 or not exists(
      select 1 from jsonb_array_elements(v_result->'periods') p where (p->>'exceeds_allowance')::boolean
    ) then raise exception 'Four-day warning was not shown';end if;
    raise exception 'rollback_leave_probe';
  exception when raise_exception then
    if sqlerrm<>'rollback_leave_probe' then raise;end if;
  end;
end $probe$;
