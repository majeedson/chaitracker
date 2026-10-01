-- B125: private onboarding-photo avatars, self/admin edits and café-day check-in status.
create or replace function private.employee_photo_access(p_name text,p_edit boolean default false)
returns boolean language sql stable security definer set search_path='' as $function$
  select exists(
    select 1 from public.users actor join public.users target on target.id::text=split_part(p_name,'/',1)
    where actor.auth_user_id=auth.uid() and actor.active
      and (coalesce(actor.access_class,'STAFF')='ADMIN' or actor.id=target.id
        or (not p_edit and actor.role in('Manager','Ops Manager') and actor.outlet_id=target.outlet_id))
  )
$function$;
revoke all on function private.employee_photo_access(text,boolean) from public,anon;
grant execute on function private.employee_photo_access(text,boolean) to authenticated;

create policy employee_photos_scoped_read on storage.objects for select to authenticated
  using(bucket_id='employee-photos' and private.employee_photo_access(name,false));
create policy employee_photos_scoped_upload on storage.objects for insert to authenticated
  with check(bucket_id='employee-photos' and private.employee_photo_access(name,true)
    and name ~ '^[0-9a-f-]+/profile-[0-9a-f-]+\.(jpg|jpeg|png|webp)$');
create policy employee_photos_scoped_cleanup on storage.objects for delete to authenticated
  using(bucket_id='employee-photos' and private.employee_photo_access(name,true));
update storage.buckets set file_size_limit=5242880,
  allowed_mime_types=array['image/jpeg','image/png','image/webp'] where id='employee-photos';

create or replace function public.get_staff_avatar_data(p_staff_ids integer[] default null)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare v_actor public.users;v_result jsonb;
begin
  select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;
  if not found then raise exception 'Authenticated CafeTracker user required';end if;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_result from (
    select s.id staff_id,s.name,u.id user_id,ep.profile_photo_path photo_path,
      public.get_effective_business_day(s.outlet_id,now()) business_date,
      exists(select 1 from public.attendance a where a.staff_id=s.id and a.punch_time is not null
        and a.attendance_date=public.get_effective_business_day(s.outlet_id,now())
        and a.status not in('Absent','Leave')) checked_in
    from public.staff s
    left join lateral(select id from public.users where staff_id=s.id order by active desc,id limit 1) u on true
    left join public.employee_profiles ep on ep.user_id=u.id
    where (p_staff_ids is null or s.id=any(p_staff_ids))
      and (coalesce(v_actor.access_class,'STAFF')='ADMIN' or s.id=v_actor.staff_id
        or (v_actor.role in('Manager','Ops Manager') and s.outlet_id=v_actor.outlet_id))
  ) x;
  return v_result;
end $function$;

create or replace function public.set_employee_profile_photo(p_staff_id integer,p_path text)
returns boolean language plpgsql security definer set search_path='' as $function$
declare v_actor public.users;v_target public.users;
begin
  select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;
  if not found then raise exception 'Authenticated CafeTracker user required';end if;
  if coalesce(v_actor.access_class,'STAFF')<>'ADMIN' and v_actor.staff_id is distinct from p_staff_id then
    raise exception 'You can only change your own profile picture';
  end if;
  select * into v_target from public.users where staff_id=p_staff_id order by active desc,id limit 1;
  if not found then raise exception 'Staff login profile not found';end if;
  if p_path is null or split_part(p_path,'/',1)<>v_target.id::text
    or p_path !~ '^[0-9a-f-]+/profile-[0-9a-f-]+\.(jpg|jpeg|png|webp)$'
    or not exists(select 1 from storage.objects where bucket_id='employee-photos' and name=p_path) then
    raise exception 'Upload a profile picture for this staff member first';
  end if;
  insert into public.employee_profiles(user_id,profile_photo_path,updated_at)
    values(v_target.id,p_path,now()) on conflict(user_id) do update
    set profile_photo_path=excluded.profile_photo_path,updated_at=now();
  return true;
end $function$;
revoke all on function public.get_staff_avatar_data(integer[]),public.set_employee_profile_photo(integer,text) from public,anon;
grant execute on function public.get_staff_avatar_data(integer[]),public.set_employee_profile_photo(integer,text) to authenticated;
