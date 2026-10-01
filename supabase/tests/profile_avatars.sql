-- All attendance and profile changes roll back in the inner probe block.
do $probe$
declare
  v_user public.users;v_other public.users;v_path text;v_day date;v_result jsonb;v_message text;
begin
  select u.* into v_user from public.users u join public.employee_profiles ep on ep.user_id=u.id
    join storage.objects o on o.name=ep.profile_photo_path and o.bucket_id='employee-photos'
    where u.active and u.auth_user_id is not null and u.staff_id is not null and u.access_class<>'ADMIN'
    order by u.id limit 1;
  if v_user.id is null then raise exception 'No linked onboarding-photo fixture';end if;
  select * into v_other from public.users where active and staff_id is not null and id<>v_user.id limit 1;
  select profile_photo_path into v_path from public.employee_profiles where user_id=v_user.id;
  begin
    perform set_config('request.jwt.claim.sub',v_user.auth_user_id::text,true);
    if not private.employee_photo_access(v_path,false) or not private.employee_photo_access(v_path,true) then
      raise exception 'Own photo access failed';
    end if;
    if private.employee_photo_access(v_other.id::text||'/profile-test.jpg',true) then
      raise exception 'Cross-staff photo edit was allowed';
    end if;
    v_result:=public.get_staff_avatar_data(array[v_user.staff_id]);
    if jsonb_array_length(v_result)<>1 or v_result->0->>'photo_path'<>v_path then
      raise exception 'Onboarding selfie was not reused';
    end if;
    perform public.set_employee_profile_photo(v_user.staff_id,v_path);
    begin
      perform public.set_employee_profile_photo(v_other.staff_id,v_path);
      raise exception 'Cross-staff update allowed';
    exception when raise_exception then
      get stacked diagnostics v_message=message_text;
      if v_message<>'You can only change your own profile picture' then raise;end if;
    end;
    v_day:=public.get_effective_business_day(v_user.outlet_id,now());
    delete from public.attendance where staff_id=v_user.staff_id and attendance_date=v_day;
    v_result:=public.get_staff_avatar_data(array[v_user.staff_id]);
    if (v_result->0->>'checked_in')::boolean then raise exception 'Missing attendance was green';end if;
    insert into public.attendance(staff_id,outlet_id,attendance_date,shift_start,punch_time,status)
      values(v_user.staff_id,v_user.outlet_id,v_day,'09:00','09:00','Present');
    v_result:=public.get_staff_avatar_data(array[v_user.staff_id]);
    if not (v_result->0->>'checked_in')::boolean then raise exception 'Check-in was not green';end if;
    update public.attendance set status='Absent' where staff_id=v_user.staff_id and attendance_date=v_day;
    v_result:=public.get_staff_avatar_data(array[v_user.staff_id]);
    if (v_result->0->>'checked_in')::boolean then raise exception 'Absence was green';end if;
    raise exception 'rollback_avatar_probe';
  exception when raise_exception then
    get stacked diagnostics v_message=message_text;
    if v_message<>'rollback_avatar_probe' then raise;end if;
  end;
end $probe$;
