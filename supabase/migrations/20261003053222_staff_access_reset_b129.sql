-- B129: separate admin PIN/profile reset, atomic onboarding and detached old sessions.
alter table public.users add column if not exists setup_revision uuid not null default gen_random_uuid();

create or replace function public.admin_reset_staff_access(p_staff_id integer,p_reset_type text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.users;v_user public.users;v_files jsonb:='[]'::jsonb;
begin
 select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;
 if v_actor.id is null or v_actor.access_class<>'ADMIN' then raise exception 'Admin access required' using errcode='42501';end if;
 if p_reset_type is null or p_reset_type not in('PIN','PROFILE') then raise exception 'Choose PIN or PROFILE reset';end if;
 perform 1 from public.staff where id=p_staff_id for update;
 select * into v_user from public.users where staff_id=p_staff_id for update;
 if v_user.id is null then raise exception 'Staff account not found';end if;
 if v_user.access_class<>'STAFF' or v_user.is_super_user then raise exception 'Only employee accounts can be reset';end if;
 if p_reset_type='PROFILE' then
  select coalesce(jsonb_agg(jsonb_build_object('bucket_id',bucket_id,'name',name)),'[]'::jsonb) into v_files
   from storage.objects where bucket_id in('employee-documents','employee-photos') and split_part(name,'/',1)=v_user.id::text;
  delete from public.employee_profiles where user_id=v_user.id;
 end if;
 update public.users set auth_user_id=null,pin_hash=null,pin_set_at=null,last_login_at=null,
  pin_setup_hash=case when p_reset_type='PIN' then encode(extensions.digest('1234','sha256'),'hex') end,
  pin_setup_expires_at=case when p_reset_type='PIN' then now()+interval '24 hours' end,
  failed_login_attempts=0,locked_until=null,setup_revision=gen_random_uuid() where id=v_user.id;
 insert into public.pin_reset_audit(target_user_id,reset_by,reset_type) values(v_user.id,v_actor.id,p_reset_type);
 return jsonb_build_object('user_id',v_user.id,'reset_type',p_reset_type,'files',v_files);
end $$;
revoke all on function public.admin_reset_staff_access(integer,text) from public,anon;
grant execute on function public.admin_reset_staff_access(integer,text) to authenticated;

-- Retire old reset entry points that exposed duplicate-account and setup bypass failures.
revoke all on function public.superuser_reset_staff_pin_setup(integer) from public,anon,authenticated;
revoke all on function public.owner_reset_staff_pin_setup(integer) from public,anon,authenticated;

create or replace function public.complete_staff_onboarding(p_user_id uuid,p_revision uuid,p_auth_id uuid,p_profile jsonb,p_setup_code text)
returns void language plpgsql security definer set search_path='' as $$
declare v_user public.users;
begin
 select * into v_user from public.users where id=p_user_id for update;
 if v_user.id is null or not v_user.active or v_user.access_class<>'STAFF' or v_user.auth_user_id is not null
  or v_user.pin_hash is not null or v_user.setup_revision is distinct from p_revision then
  raise exception 'Account setup changed. Reload the sign-in screen and try again';end if;
 if v_user.pin_setup_hash is not null then
  if v_user.pin_setup_expires_at is null or v_user.pin_setup_expires_at<now() or p_setup_code is null
   or encode(extensions.digest(p_setup_code,'sha256'),'hex') is distinct from v_user.pin_setup_hash then
   raise exception 'Temporary PIN incorrect or expired. Ask an administrator for another reset';end if;
 end if;
 if p_profile is null then
  if v_user.pin_setup_hash is null or not exists(select 1 from public.employee_profiles where user_id=p_user_id and onboarding_status='complete') then
   raise exception 'Complete your staff profile before creating a PIN';end if;
 else
  if exists(select 1 from unnest(array['full_legal_name','date_of_birth','father_name','nationality','mobile_phone','home_address',
   'emergency_contact_name','emergency_contact_relation','emergency_contact_phone','identity_type','identity_number','identity_document_path','profile_photo_path']) k
   where nullif(trim(p_profile->>k),'') is null) then raise exception 'Complete all onboarding details';end if;
  if split_part(p_profile->>'identity_document_path','/',1)<>p_user_id::text or split_part(p_profile->>'profile_photo_path','/',1)<>p_user_id::text then
   raise exception 'Invalid employee document path';end if;
  insert into public.employee_profiles(user_id,full_legal_name,date_of_birth,father_name,nationality,mobile_phone,home_address,
   emergency_contact_name,emergency_contact_relation,emergency_contact_phone,identity_type,identity_number,identity_document_path,profile_photo_path,
   onboarding_status,onboarding_started_at,onboarding_completed_at,details_confirmed_at,updated_at)
  values(p_user_id,p_profile->>'full_legal_name',(p_profile->>'date_of_birth')::date,p_profile->>'father_name',p_profile->>'nationality',
   p_profile->>'mobile_phone',p_profile->>'home_address',p_profile->>'emergency_contact_name',p_profile->>'emergency_contact_relation',
   p_profile->>'emergency_contact_phone',p_profile->>'identity_type',p_profile->>'identity_number',p_profile->>'identity_document_path',
   p_profile->>'profile_photo_path','complete',now(),now(),now(),now())
  on conflict(user_id) do update set full_legal_name=excluded.full_legal_name,date_of_birth=excluded.date_of_birth,father_name=excluded.father_name,
   nationality=excluded.nationality,mobile_phone=excluded.mobile_phone,home_address=excluded.home_address,emergency_contact_name=excluded.emergency_contact_name,
   emergency_contact_relation=excluded.emergency_contact_relation,emergency_contact_phone=excluded.emergency_contact_phone,
   identity_type=excluded.identity_type,identity_number=excluded.identity_number,identity_document_path=excluded.identity_document_path,
   profile_photo_path=excluded.profile_photo_path,onboarding_status='complete',onboarding_started_at=now(),onboarding_completed_at=now(),details_confirmed_at=now(),updated_at=now();
 end if;
 update public.users set auth_user_id=p_auth_id,pin_hash=null,pin_set_at=now(),pin_setup_hash=null,pin_setup_expires_at=null,
  failed_login_attempts=0,locked_until=null,setup_revision=gen_random_uuid() where id=p_user_id;
end $$;
revoke all on function public.complete_staff_onboarding(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.complete_staff_onboarding(uuid,uuid,uuid,jsonb,text) to service_role;

create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('schema_build',129)
$$;
revoke all on function public.get_app_release() from public;
grant execute on function public.get_app_release() to anon,authenticated;

create or replace view public.login_directory as
 select u.id,u.name,u.role,u.outlet_id,o.name as outlet_name,u.can_switch_outlet,u.active,
  u.auth_user_id is not null as auth_enrolled,u.pin_set_at is not null as pin_set,o.theme_key,o.theme_color,
  coalesce(ep.onboarding_status,'invited') as onboarding_status,u.access_class,u.is_super_user,u.staff_id,
  (u.pin_setup_hash is not null and u.pin_set_at is null) as pin_reset_pending
 from public.users u left join public.outlets o on o.id=u.outlet_id left join public.employee_profiles ep on ep.user_id=u.id;

notify pgrst,'reload schema';
