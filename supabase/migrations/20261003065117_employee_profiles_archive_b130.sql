-- B130: authorized full onboarding views and history-preserving account deletion.
alter table public.users add column if not exists deleted_at timestamptz;
alter table public.users add column if not exists deleted_by uuid references public.users(id);
alter table public.users add column if not exists deletion_auth_user_id uuid;

create or replace function public.get_employee_profile_data(p_staff_id integer default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_actor public.users;v_target public.users;v_result jsonb;
begin
 select * into v_actor from public.users where auth_user_id=auth.uid() and active=true and deleted_at is null;
 if v_actor.id is null then raise exception 'Authenticated user required' using errcode='42501';end if;
 if v_actor.access_class<>'ADMIN' and coalesce(p_staff_id,v_actor.staff_id) is distinct from v_actor.staff_id then
  raise exception 'You can only view your own onboarding details' using errcode='42501';end if;
 select * into v_target from public.users where staff_id=coalesce(p_staff_id,v_actor.staff_id) order by active desc,id limit 1;
 if v_target.id is null then raise exception 'Employee account not found';end if;
 select jsonb_build_object('staff_id',s.id,'user_id',v_target.id,'name',s.name,'outlet_name',o.name,'role',v_target.role,
  'joining_date',s.joining_date,'employment_end_date',s.employment_end_date,'employment_status',s.employment_status,
  'deleted_at',v_target.deleted_at,'onboarding_status',coalesce(ep.onboarding_status,'invited'),
  'full_legal_name',ep.full_legal_name,'date_of_birth',ep.date_of_birth,'father_name',ep.father_name,'nationality',ep.nationality,
  'mobile_phone',ep.mobile_phone,'home_address',ep.home_address,'emergency_contact_name',ep.emergency_contact_name,
  'emergency_contact_relation',ep.emergency_contact_relation,'emergency_contact_phone',ep.emergency_contact_phone,
  'identity_type',ep.identity_type,'identity_number',ep.identity_number,'identity_document_path',ep.identity_document_path,
  'profile_photo_path',ep.profile_photo_path,'onboarding_started_at',ep.onboarding_started_at,'onboarding_completed_at',ep.onboarding_completed_at,
  'details_confirmed_at',ep.details_confirmed_at) into v_result
 from public.staff s left join public.outlets o on o.id=s.outlet_id left join public.employee_profiles ep on ep.user_id=v_target.id
 where s.id=v_target.staff_id;
 return v_result;
end $$;
revoke all on function public.get_employee_profile_data(integer) from public,anon;
grant execute on function public.get_employee_profile_data(integer) to authenticated;

create or replace function private.employee_identity_access(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.users a join public.users t on t.id::text=split_part(p_name,'/',1)
 where a.auth_user_id=auth.uid() and a.active=true and a.deleted_at is null and t.deleted_at is null
 and (a.access_class='ADMIN' or a.id=t.id))
$$;
revoke all on function private.employee_identity_access(text) from public,anon;
grant execute on function private.employee_identity_access(text) to authenticated;
create policy employee_identity_private_read on storage.objects for select to authenticated
 using(bucket_id='employee-documents' and private.employee_identity_access(name));
-- A valid but detached old JWT must not retain the previous broad attendance-photo access.
alter policy attendance_photos_authenticated_read on storage.objects to authenticated
 using(bucket_id='attendance-photos' and exists(select 1 from public.users where auth_user_id=auth.uid() and active=true and deleted_at is null));

create or replace function public.superuser_user_deletion_impact(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_actor public.users;v_target public.users;v_result jsonb;
begin
 select * into v_actor from public.users where auth_user_id=auth.uid() and active=true and deleted_at is null;
 if v_actor.id is null or not v_actor.is_super_user then raise exception 'Super User access required' using errcode='42501';end if;
 select * into v_target from public.users where id=p_user_id;
 if v_target.id is null then raise exception 'User not found';end if;
 if v_target.id=v_actor.id or v_target.is_super_user then raise exception 'You cannot delete yourself or a Super User';end if;
 select jsonb_build_object('user_id',v_target.id,'name',v_target.name,'staff_id',v_target.staff_id,'deleted_at',v_target.deleted_at,
  'joining_date',s.joining_date,'employment_end_date',s.employment_end_date,
  'attendance_records',(select count(*) from public.attendance where staff_id=v_target.staff_id),
  'salary_records',(select count(*) from public.salary_records where staff_id=v_target.staff_id),
  'unpaid_salary',coalesce((select sum(net_salary) from public.salary_records where staff_id=v_target.staff_id and payroll_status='FINALIZED'),0),
  'draft_payrolls',(select count(*) from public.salary_records where staff_id=v_target.staff_id and payroll_status='DRAFT'),
  'pending_advances',(select count(*) from public.staff_advance_requests where staff_id=v_target.staff_id and status in('REQUESTED','APPROVED')),
  'pending_leave',(select count(*) from public.leave_requests where staff_id=v_target.staff_id and status='PENDING'),
  'unfinished_transfers',(select count(*) from public.extra_time_requests r where r.status in('REQUESTED','DISPATCHED') and
    (r.requested_by=v_target.id or exists(select 1 from public.extra_time_dispatches d where d.request_id=r.id and (d.prepared_by=v_target.id or d.dispatched_by=v_target.id)))),
  'transfer_earnings_due',coalesce((select sum(amount) from public.extra_time_payments where staff_user_id=v_target.id and status='READY'),0),
  'advance_balance',coalesce((select sum(greatest(0,r.amount-coalesce((select sum(d.amount) from public.staff_advance_deductions d where d.advance_id=r.id),0))) from public.staff_advance_requests r where r.staff_id=v_target.staff_id and r.status='PAID'),0),
  'legacy_loan_balance',coalesce((select loan_remaining from public.salary_records where staff_id=v_target.staff_id and payroll_status in('FINALIZED','PAID') order by period_end desc,created_at desc limit 1),0))
 into v_result from (select 1) one left join public.staff s on s.id=v_target.staff_id;
 return v_result;
end $$;
revoke all on function public.superuser_user_deletion_impact(uuid) from public,anon;
grant execute on function public.superuser_user_deletion_impact(uuid) to authenticated;

create or replace function public.superuser_archive_user(p_user_id uuid,p_confirmation text,p_last_working_date date default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.users;v_target public.users;v_staff public.staff;v_impact jsonb;v_files jsonb;v_end date;
begin
 select * into v_actor from public.users where auth_user_id=auth.uid() and active=true and deleted_at is null;
 if v_actor.id is null or not v_actor.is_super_user then raise exception 'Super User access required' using errcode='42501';end if;
 select * into v_target from public.users where id=p_user_id;
 if v_target.staff_id is not null then select * into v_staff from public.staff where id=v_target.staff_id for update;end if;
 select * into v_target from public.users where id=p_user_id for update;
 v_impact:=public.superuser_user_deletion_impact(p_user_id);
 if p_confirmation is distinct from v_target.name then raise exception 'Type the exact user name to confirm deletion';end if;
 if v_target.deleted_at is null then
  if (v_impact->>'pending_advances')::integer>0 or (v_impact->>'pending_leave')::integer>0 or (v_impact->>'unfinished_transfers')::integer>0 then
   raise exception 'Resolve pending advances, leave requests and unfinished transfers before deleting this user';end if;
  if v_target.staff_id is not null then
   v_end:=coalesce(v_staff.employment_end_date,p_last_working_date);
   if v_end is null or v_end>(now() at time zone 'Asia/Kolkata')::date or v_end<v_staff.joining_date then raise exception 'Choose the actual last working date, between joining and today';end if;
   perform public.owner_set_staff_status(v_target.staff_id,'LEFT',v_end,'Account deleted; employment and financial history retained');
  end if;
  update public.users set active=false,auth_user_id=null,pin_hash=null,pin_set_at=null,pin_setup_hash=null,pin_setup_expires_at=null,
   failed_login_attempts=0,locked_until=null,deactivated_at=now(),deleted_at=now(),deleted_by=v_actor.id,
   deletion_auth_user_id=v_target.auth_user_id,setup_revision=gen_random_uuid(),permissions='{}'::jsonb where id=p_user_id;
  delete from public.employee_profiles where user_id=p_user_id;
  insert into public.admin_access_audit(action,target_user_id,target_name,performed_by,details)
   values('DELETE_USER_PRESERVE_HISTORY',p_user_id,v_target.name,v_actor.id,v_impact||jsonb_build_object('last_working_date',v_end));
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('bucket_id',bucket_id,'name',name)),'[]'::jsonb) into v_files from storage.objects
  where bucket_id in('employee-documents','employee-photos') and split_part(name,'/',1)=p_user_id::text;
 return jsonb_build_object('files',v_files,'auth_user_id',coalesce(v_target.deletion_auth_user_id,v_target.auth_user_id),'impact',v_impact);
end $$;
revoke all on function public.superuser_archive_user(uuid,text,date) from public,anon;
grant execute on function public.superuser_archive_user(uuid,text,date) to authenticated;

-- Guard legacy status/PIN/profile APIs: archived accounts cannot be reactivated accidentally.
create or replace function private.guard_archived_user() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.deleted_at is not null and (new.active is distinct from false or new.auth_user_id is not null or new.pin_hash is not null
  or new.pin_set_at is not null or new.pin_setup_hash is not null or new.deleted_at is distinct from old.deleted_at) then
  raise exception 'Deleted accounts cannot be reactivated or reset. Create a new employment record for rejoining';end if;
 return new;
end $$;
create trigger users_archive_guard before update on public.users for each row execute function private.guard_archived_user();
create or replace function private.guard_archived_staff() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.users where staff_id=old.id and deleted_at is not null) then raise exception 'Archived employment details are read-only';end if;
 return new;
end $$;
create trigger staff_archive_guard before update on public.staff for each row execute function private.guard_archived_staff();
create or replace function private.guard_archived_profile() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.users where id=new.user_id and deleted_at is not null) then raise exception 'Deleted accounts cannot collect a new onboarding profile';end if;
 return new;
end $$;
create trigger employee_profile_archive_guard before insert or update on public.employee_profiles for each row execute function private.guard_archived_profile();
revoke all on function private.guard_archived_user(),private.guard_archived_staff(),private.guard_archived_profile() from public,anon,authenticated;
create or replace function private.guard_archived_staff_request() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.staff where id=new.staff_id for key share;
 if exists(select 1 from public.users where staff_id=new.staff_id and deleted_at is not null) then raise exception 'New requests cannot be added to an archived employee';end if;
 return new;
end $$;
create trigger advance_archive_request_guard before insert on public.staff_advance_requests for each row execute function private.guard_archived_staff_request();
create trigger leave_archive_request_guard before insert on public.leave_requests for each row execute function private.guard_archived_staff_request();
revoke all on function private.guard_archived_staff_request() from public,anon,authenticated;

create or replace view public.login_directory as
 select u.id,u.name,u.role,u.outlet_id,o.name as outlet_name,u.can_switch_outlet,u.active,
  u.auth_user_id is not null as auth_enrolled,u.pin_set_at is not null as pin_set,o.theme_key,o.theme_color,
  coalesce(ep.onboarding_status,'invited') as onboarding_status,u.access_class,u.is_super_user,u.staff_id,
  (u.pin_setup_hash is not null and u.pin_set_at is null) as pin_reset_pending
 from public.users u left join public.outlets o on o.id=u.outlet_id left join public.employee_profiles ep on ep.user_id=u.id
 where u.deleted_at is null;
create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('schema_build',130)
$$;
notify pgrst,'reload schema';
