-- B140: audited, optimistic attendance corrections and current-day shift recalculation.
alter table public.attendance add column manual_entry boolean not null default false;
alter table public.attendance add column manual_half_day boolean not null default false;
alter table public.attendance add column shift_override boolean not null default false;
alter table public.attendance add column photo_checkin_at timestamptz;
alter table public.attendance_corrections add column before_record jsonb;
alter table public.attendance_corrections add column after_record jsonb;
alter table public.attendance_corrections add column correction_type text;

create or replace function public.get_attendance_correction_context(p_staff_id integer,p_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_actor public.users;v_staff public.staff;v_att public.attendance;v_outlet integer;v_day date;v_history jsonb;
begin
 select * into v_actor from public.users where auth_user_id=auth.uid() and active and deleted_at is null;
 if v_actor.id is null or (coalesce(v_actor.access_class,'STAFF')<>'ADMIN' and v_actor.role not in('Manager','Ops Manager')) then raise exception 'Manager or admin access required' using errcode='42501';end if;
 select * into v_staff from public.staff where id=p_staff_id;
 if v_staff.id is null then raise exception 'Staff not found';end if;
 select * into v_att from public.attendance where staff_id=p_staff_id and attendance_date=p_date;
 v_outlet:=coalesce(v_att.outlet_id,v_staff.outlet_id);v_day:=public.get_effective_business_day(v_outlet,now());
 if p_date is null or p_date>v_day then raise exception 'Future attendance cannot be corrected';end if;
 if coalesce(v_actor.access_class,'STAFF')<>'ADMIN' then
  if v_actor.staff_id=p_staff_id then raise exception 'Managers cannot correct their own attendance; ask an admin';end if;
  if v_actor.outlet_id is distinct from v_outlet then raise exception 'Outlet access denied' using errcode='42501';end if;
  if p_date<v_day-1 then raise exception 'Manager can correct only today or yesterday. Owner access required.';end if;
  if v_att.id is null or not exists(select 1 from storage.objects where bucket_id='attendance-photos' and name=v_att.photo_url) then raise exception 'Photo check-in required before manager correction';end if;
 end if;
 if v_att.id is null and ((v_staff.joining_date is not null and p_date<v_staff.joining_date) or (v_staff.employment_end_date is not null and p_date>v_staff.employment_end_date)) then raise exception 'Date is outside the employment period';end if;
 select coalesce(jsonb_agg(to_jsonb(h)),'[]'::jsonb) into v_history from (
  select reason,reviewed_at,correction_type,before_record,after_record from public.attendance_corrections where staff_id=p_staff_id and attendance_date=p_date order by reviewed_at desc limit 5
 ) h;
 return jsonb_build_object('record',case when v_att.id is null then null else to_jsonb(v_att) end,
  'shift_start',coalesce(v_att.shift_start,private.resolve_staff_shift(p_staff_id,p_date)),
  'can_edit_status',coalesce(v_actor.access_class,'STAFF')='ADMIN','history',v_history);
end $$;
revoke all on function public.get_attendance_correction_context(integer,date) from public,anon;
grant execute on function public.get_attendance_correction_context(integer,date) to authenticated;

create or replace function public.save_attendance_correction(p_staff_id integer,p_date date,p_shift_start time,p_punch_time time,p_status text,p_reason text,p_expected jsonb)
returns public.attendance language plpgsql security definer set search_path='' as $$
declare v_actor public.users;v_staff public.staff;v_old public.attendance;v_new public.attendance;v_context jsonb;v_outlet public.outlets;v_late integer;v_half boolean;
begin
 select * into v_actor from public.users where auth_user_id=auth.uid() and active and deleted_at is null;
 if v_actor.id is null or (coalesce(v_actor.access_class,'STAFF')<>'ADMIN' and v_actor.role not in('Manager','Ops Manager')) then raise exception 'Manager or admin access required' using errcode='42501';end if;
 if length(trim(coalesce(p_reason,'')))<3 then raise exception 'Correction reason is required';end if;
 if p_shift_start is null then raise exception 'Shift start is required';end if;
 if p_status is null or p_status not in('Present','HalfDay','Absent','Leave') then raise exception 'Choose a valid attendance status';end if;
 if p_status in('Present','HalfDay') and p_punch_time is null then raise exception 'Arrival time is required';end if;
 if p_status in('Absent','Leave') and p_punch_time is not null then raise exception 'Absent or leave records cannot have an arrival time';end if;
 select * into v_staff from public.staff where id=p_staff_id for update;
 if v_staff.id is null then raise exception 'Staff not found';end if;
 select * into v_old from public.attendance where staff_id=p_staff_id and attendance_date=p_date for update;
 v_context:=public.get_attendance_correction_context(p_staff_id,p_date);
 if coalesce(p_expected,'null'::jsonb) is distinct from coalesce(v_context->'record','null'::jsonb) then raise exception 'Attendance changed since you opened it. Reopen the correction and try again.' using errcode='40001';end if;
 if coalesce(v_actor.access_class,'STAFF')<>'ADMIN' and (p_status<>'Present' or p_shift_start is distinct from v_old.shift_start) then raise exception 'Only an admin can change the shift or attendance status' using errcode='42501';end if;
 select * into v_outlet from public.outlets where id=coalesce(v_old.outlet_id,v_staff.outlet_id);
 v_late:=case when p_punch_time is null then 0 else greatest(0,floor(extract(epoch from(p_punch_time-p_shift_start))/60)::integer) end;
 if v_late<=coalesce(v_outlet.attendance_grace_minutes,15) then v_late:=0;end if;
 v_half:=p_status='HalfDay' or (p_status='Present' and v_late>=coalesce(v_outlet.half_day_late_minutes,240));
 if v_old.id is null then
  insert into public.attendance(staff_id,outlet_id,attendance_date,shift_start,punch_time,late_mins,half_day,status,manual_entry,manual_half_day,shift_override)
  values(p_staff_id,v_outlet.id,p_date,p_shift_start,p_punch_time,v_late,v_half,case when v_half then 'HalfDay' else p_status end,true,p_status='HalfDay',p_shift_start is distinct from private.resolve_staff_shift(p_staff_id,p_date)) returning * into v_new;
 else
  update public.attendance set shift_start=p_shift_start,punch_time=p_punch_time,late_mins=v_late,half_day=v_half,
   status=case when v_half then 'HalfDay' else p_status end,
   manual_entry=manual_entry or (coalesce(v_actor.access_class,'STAFF')='ADMIN' and p_punch_time is not null and not exists(select 1 from storage.objects where bucket_id='attendance-photos' and name=v_old.photo_url)),
   manual_half_day=p_status='HalfDay',shift_override=case when coalesce(v_actor.access_class,'STAFF')='ADMIN' then p_shift_start is distinct from private.resolve_staff_shift(p_staff_id,p_date) else shift_override end
  where id=v_old.id returning * into v_new;
 end if;
 insert into public.attendance_corrections(attendance_id,staff_id,outlet_id,attendance_date,requested_punch_time,reason,status,requested_by,reviewed_by,reviewed_at,review_note,original_punch_time,original_photo_url,before_record,after_record,correction_type)
 values(v_new.id,p_staff_id,v_outlet.id,p_date,(p_date+p_punch_time) at time zone coalesce(v_outlet.timezone,'Asia/Kolkata'),trim(p_reason),'APPROVED',v_actor.id,v_actor.id,now(),
  'Direct attendance correction',v_old.punch_time,v_old.photo_url,case when v_old.id is null then null else to_jsonb(v_old) end,to_jsonb(v_new),case when v_old.id is null then 'MANUAL_ENTRY' else 'MANUAL_CORRECTION' end);
 return v_new;
end $$;
revoke all on function public.save_attendance_correction(integer,date,time,time,text,text,jsonb) from public,anon;
grant execute on function public.save_attendance_correction(integer,date,time,time,text,text,jsonb) to authenticated;

-- Compatibility for earlier app builds, with the same authorization as the new editor.
create or replace function public.correct_attendance(p_attendance_id integer,p_punch_time time,p_reason text)
returns public.attendance language plpgsql security definer set search_path='' as $$
declare v_att public.attendance;v_result public.attendance;
begin
 select * into v_att from public.attendance where id=p_attendance_id;
 if v_att.id is null then raise exception 'Attendance record not found';end if;
 select * into v_result from public.save_attendance_correction(v_att.staff_id,v_att.attendance_date,coalesce(v_att.shift_start,private.resolve_staff_shift(v_att.staff_id,v_att.attendance_date)),p_punch_time,'Present',p_reason,to_jsonb(v_att));
 return v_result;
end $$;
revoke all on function public.correct_attendance(integer,time,text) from public,anon;
grant execute on function public.correct_attendance(integer,time,text) to authenticated;

create or replace function private.recalculate_attendance_shift(p_staff_id integer,p_date date,p_actor uuid,p_reason text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_old public.attendance;v_new public.attendance;v_outlet public.outlets;v_shift time;v_late integer;
begin
 select * into v_old from public.attendance where staff_id=p_staff_id and attendance_date=p_date for update;
 if v_old.id is null or v_old.shift_override then return false;end if;
 v_shift:=private.resolve_staff_shift(p_staff_id,p_date);
 if v_old.shift_start is not distinct from v_shift then return false;end if;
 select * into v_outlet from public.outlets where id=v_old.outlet_id;
 v_late:=case when v_old.punch_time is null then 0 else greatest(0,floor(extract(epoch from(v_old.punch_time-v_shift))/60)::integer) end;
 if v_late<=coalesce(v_outlet.attendance_grace_minutes,15) then v_late:=0;end if;
 update public.attendance set shift_start=v_shift,late_mins=v_late,
  half_day=status not in('Absent','Leave') and (manual_half_day or v_late>=coalesce(v_outlet.half_day_late_minutes,240)),
  status=case when status in('Absent','Leave') then status when manual_half_day or v_late>=coalesce(v_outlet.half_day_late_minutes,240) then 'HalfDay' else 'Present' end
 where id=v_old.id returning * into v_new;
 insert into public.attendance_corrections(attendance_id,staff_id,outlet_id,attendance_date,requested_punch_time,reason,status,requested_by,reviewed_by,reviewed_at,review_note,original_punch_time,original_photo_url,before_record,after_record,correction_type)
 values(v_new.id,p_staff_id,v_outlet.id,p_date,(p_date+v_old.punch_time) at time zone coalesce(v_outlet.timezone,'Asia/Kolkata'),p_reason,'APPROVED',p_actor,p_actor,now(),'Same-day shift recalculation',v_old.punch_time,v_old.photo_url,to_jsonb(v_old),to_jsonb(v_new),'SHIFT_RECALCULATION');
 return true;
end $$;
revoke all on function private.recalculate_attendance_shift(integer,date,uuid,text) from public,anon,authenticated;

create or replace function public.admin_save_staff_shift(p_staff_id integer,p_start_time time,p_effective_from date)
returns void language plpgsql security definer set search_path='' as $$
declare v_actor public.users;v_outlet integer;v_day date;
begin
 select * into v_actor from public.users where auth_user_id=auth.uid() and active and deleted_at is null;
 if v_actor.id is null or coalesce(v_actor.access_class,'STAFF')<>'ADMIN' then raise exception 'Admin access required' using errcode='42501';end if;
 select outlet_id into v_outlet from public.staff where id=p_staff_id for update;
 if v_outlet is null or exists(select 1 from public.users where staff_id=p_staff_id and deleted_at is not null) then raise exception 'Active employment record required';end if;
 v_day:=public.get_effective_business_day(v_outlet,now());
 if p_effective_from is null or p_effective_from<v_day then raise exception 'Shift changes must take effect today or later; historical attendance is preserved';end if;
 insert into public.staff_shift_settings(staff_id,effective_from,start_time,changed_by) values(p_staff_id,p_effective_from,p_start_time,v_actor.id)
 on conflict(staff_id,effective_from) do update set start_time=excluded.start_time,changed_by=excluded.changed_by,created_at=now();
 if p_effective_from=v_day then perform private.recalculate_attendance_shift(p_staff_id,v_day,v_actor.id,'Regular shift changed effective today');end if;
 insert into public.admin_access_audit(action,target_user_id,target_name,performed_by,details)
 select 'SET_STAFF_SHIFT',id,name,v_actor.id,jsonb_build_object('start_time',p_start_time,'effective_from',p_effective_from) from public.users where staff_id=p_staff_id;
end $$;

-- A manual arrival does not substitute for a selfie, and must not prevent its later submission.
create or replace function public.record_staff_photo_checkin(p_user_id uuid,p_photo_path text)
returns public.attendance language plpgsql security definer set search_path='' as $$
declare v_user public.users;v_staff public.staff;v_day date;v_shift time;v_punch time;v_raw integer;v_late integer;v_outlet public.outlets;v_row public.attendance;
begin
 select * into v_user from public.users where id=p_user_id for update;
 if v_user.id is null or not v_user.active or v_user.deleted_at is not null or v_user.access_class='ADMIN' then raise exception 'Active employee required';end if;
 select * into v_staff from public.staff where id=v_user.staff_id for update;
 if v_staff.id is null or not v_staff.active or v_staff.outlet_id is distinct from v_user.outlet_id then raise exception 'Active staff link required';end if;
 select * into v_outlet from public.outlets where id=v_user.outlet_id;
 v_day:=public.get_effective_business_day(v_user.outlet_id,now());v_punch:=(now() at time zone coalesce(v_outlet.timezone,'Asia/Kolkata'))::time;
 if p_photo_path is null or p_photo_path not like v_staff.id::text||'/'||v_day::text||'/%' or not exists(select 1 from storage.objects where bucket_id='attendance-photos' and name=p_photo_path) then raise exception 'Stored check-in photo required';end if;
 select * into v_row from public.attendance where staff_id=v_staff.id and attendance_date=v_day for update;
 if v_row.id is not null then
  if v_row.manual_entry and v_row.punch_time is not null and v_row.status in('Present','HalfDay') and not exists(select 1 from storage.objects where bucket_id='attendance-photos' and name=v_row.photo_url) then
   update public.attendance set photo_url=p_photo_path,photo_checkin_at=now() where id=v_row.id returning * into v_row;return v_row;
  end if;
  raise exception 'Attendance already recorded; contact an admin if it needs correction';
 end if;
 v_shift:=private.resolve_staff_shift(v_staff.id,v_day);
 v_raw:=greatest(0,floor(extract(epoch from ((((now() at time zone coalesce(v_outlet.timezone,'Asia/Kolkata'))::date+v_punch)-(v_day+v_shift))))/60)::integer);
 v_late:=case when v_raw<=coalesce(v_outlet.attendance_grace_minutes,15) then 0 else v_raw end;
 insert into public.attendance(attendance_date,outlet_id,staff_id,shift_start,punch_time,late_mins,half_day,status,photo_url,photo_checkin_at)
 values(v_day,v_user.outlet_id,v_staff.id,v_shift,v_punch,v_late,v_late>=coalesce(v_outlet.half_day_late_minutes,240),case when v_late>=coalesce(v_outlet.half_day_late_minutes,240) then 'HalfDay' else 'Present' end,p_photo_path,now()) returning * into v_row;
 return v_row;
end $$;
revoke all on function public.record_staff_photo_checkin(uuid,text) from public,anon,authenticated;
grant execute on function public.record_staff_photo_checkin(uuid,text) to service_role;

-- Repair only current-day records affected by an already-saved current-day shift change.
do $$ declare r record;begin
 for r in select a.staff_id,a.attendance_date,ss.changed_by from public.attendance a
 join lateral(select changed_by from public.staff_shift_settings where staff_id=a.staff_id and effective_from=a.attendance_date order by created_at desc limit 1) ss on true
 where a.attendance_date=public.get_effective_business_day(a.outlet_id,now()) and not a.shift_override
 loop perform private.recalculate_attendance_shift(r.staff_id,r.attendance_date,r.changed_by,'Recalculated today after a previously saved shift change');end loop;
end $$;
create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $$ select jsonb_build_object('schema_build',140) $$;
