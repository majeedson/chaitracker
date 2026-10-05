-- B133: normalize empty dates from legacy profile forms.
create or replace function public.owner_save_staff_profile(p_staff_id integer,p_expected jsonb,p_changes jsonb)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare v_staff public.staff;v_user public.users;v_snapshot jsonb;v_status text;v_result jsonb;
begin
 if not private.is_admin() then raise exception 'Owner access required' using errcode='42501';end if;
 select * into v_staff from public.staff where id=p_staff_id for update;
 select * into v_user from public.users where staff_id=p_staff_id for update;
 if v_staff.id is null or v_user.id is null then raise exception 'Staff profile not found';end if;
 v_snapshot:=jsonb_build_object('name',v_staff.name,'outlet_id',v_staff.outlet_id,'basic_salary',v_staff.basic_salary,
  'joining_date',v_staff.joining_date,'notes',v_staff.notes,'role',v_user.role,'permissions',coalesce(v_user.permissions,'{}'::jsonb),
  'employment_status',v_staff.employment_status,'status_effective_from',v_staff.status_effective_from,'status_note',v_staff.status_note);
 if p_expected is distinct from v_snapshot then raise exception 'This profile changed since you opened it. Reopen it before saving';end if;
 v_status:=upper(p_changes->>'employment_status');
 if v_status is null or v_status not in('ACTIVE','VACATION','LEAVE','INACTIVE','LEFT') then raise exception 'Choose a valid employment status';end if;
 v_result:=public.owner_update_staff(p_staff_id,p_changes->>'name',(p_changes->>'outlet_id')::integer,p_changes->>'role',
   (p_changes->>'basic_salary')::numeric,nullif(trim(p_changes->>'joining_date'),'')::date,v_status not in('INACTIVE','LEFT'),p_changes->'permissions',p_changes->>'notes');
 if v_status is distinct from v_staff.employment_status or nullif(trim(p_changes->>'status_effective_from'),'')::date is distinct from v_staff.status_effective_from
   or nullif(trim(coalesce(p_changes->>'status_note','')),'') is distinct from v_staff.status_note then
   perform public.owner_set_staff_status(p_staff_id,v_status,nullif(trim(p_changes->>'status_effective_from'),'')::date,p_changes->>'status_note');end if;
 return v_result;
end $function$;
revoke all on function public.owner_save_staff_profile(integer,jsonb,jsonb) from public,anon;
grant execute on function public.owner_save_staff_profile(integer,jsonb,jsonb) to authenticated;


create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('schema_build',133)
$$;
notify pgrst,'reload schema';
