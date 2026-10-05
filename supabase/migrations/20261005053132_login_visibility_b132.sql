-- B132: directory visibility is independent of employee access and employment status.
alter table public.users add column show_on_login boolean not null default true;
grant select(show_on_login) on public.users to authenticated;
create or replace function public.admin_set_login_visibility(p_user_id uuid,p_visible boolean)
returns void language plpgsql security definer set search_path='' as $$
declare v_actor public.users;v_target public.users;
begin
 select * into v_actor from public.users where auth_user_id=auth.uid() and active=true and deleted_at is null;
 if v_actor.id is null or v_actor.access_class<>'ADMIN' then raise exception 'Admin access required' using errcode='42501';end if;
 if p_visible is null then raise exception 'Choose whether to show this account';end if;
 -- Serialize admin visibility changes so at least one active administrator stays selectable.
 perform 1 from public.users where access_class='ADMIN' order by id for update;
 select * into v_target from public.users where id=p_user_id for update;
 if v_target.id is null then raise exception 'Account not found';end if;
 if v_target.deleted_at is not null then raise exception 'Archived accounts cannot appear in login';end if;
 if v_target.access_class='ADMIN' and not coalesce(v_actor.is_super_user,false) then raise exception 'Super User access required for administrator accounts' using errcode='42501';end if;
 if v_target.access_class='ADMIN' and v_target.active and not p_visible and not exists(select 1 from public.users where access_class='ADMIN' and active=true and show_on_login=true and deleted_at is null and id<>p_user_id) then raise exception 'Keep at least one active administrator visible in login';end if;
 if v_target.show_on_login is distinct from p_visible then
  update public.users set show_on_login=p_visible where id=p_user_id;
  insert into public.admin_access_audit(action,target_user_id,target_name,performed_by,details) values('SET_LOGIN_VISIBILITY',p_user_id,v_target.name,v_actor.id,jsonb_build_object('show_on_login',p_visible));
 end if;
end $$;
revoke all on function public.admin_set_login_visibility(uuid,boolean) from public,anon;
grant execute on function public.admin_set_login_visibility(uuid,boolean) to authenticated;
create or replace view public.login_directory as
 select u.id,u.name,u.role,u.outlet_id,o.name as outlet_name,u.can_switch_outlet,u.active,
  u.auth_user_id is not null as auth_enrolled,u.pin_set_at is not null as pin_set,o.theme_key,o.theme_color,
  coalesce(ep.onboarding_status,'invited') as onboarding_status,u.access_class,u.is_super_user,u.staff_id,
  (u.pin_setup_hash is not null and u.pin_set_at is null) as pin_reset_pending
 from public.users u left join public.outlets o on o.id=u.outlet_id left join public.employee_profiles ep on ep.user_id=u.id
 where u.deleted_at is null and u.show_on_login=true;
create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('schema_build',132)
$$;
notify pgrst,'reload schema';
