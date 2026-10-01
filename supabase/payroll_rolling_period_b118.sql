-- B118: A payroll belongs to the month in which its period starts.
-- Rolling periods may end in the following month, so overlap is not a reliable selector.
create or replace function public.get_salary_payroll_context(p_staff_id integer,p_month_start date)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_actor public.users;v_current public.salary_records;v_prior public.salary_records;
begin
  select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;
  if not found then raise exception 'Authenticated CafeTracker user required';end if;
  if coalesce(v_actor.access_class,'STAFF')<>'ADMIN' and coalesce(v_actor.staff_id,0)<>p_staff_id then
    raise exception 'You can only view your own salary';
  end if;
  select * into v_current from public.salary_records r where r.staff_id=p_staff_id
    and r.period_start>=date_trunc('month',p_month_start)::date
    and r.period_start<(date_trunc('month',p_month_start)+interval '1 month')::date
  order by r.period_start desc,r.created_at desc limit 1;
  select * into v_prior from public.salary_records r where r.staff_id=p_staff_id
    and r.period_start<date_trunc('month',p_month_start)::date
    and r.payroll_status in ('FINALIZED','PAID')
  order by r.period_start desc,r.created_at desc limit 1;
  return jsonb_build_object('current',case when v_current.id is null then null else to_jsonb(v_current) end,
    'prior',case when v_prior.id is null then null else to_jsonb(v_prior) end);
end $function$;

revoke all on function public.get_salary_payroll_context(integer,date) from public,anon;
grant execute on function public.get_salary_payroll_context(integer,date) to authenticated;
