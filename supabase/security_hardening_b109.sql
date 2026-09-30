-- B109: close Data API exposure while preserving the existing login dropdown.
-- This script is applied after the B109 client uses get_staff_roster for manager lists.
revoke all on all tables in schema public from anon;
grant select on public.login_directory to anon;
grant select (id,name,theme_key,theme_color) on public.outlets to anon;

revoke all on public.users from authenticated;
grant select (id,name,role,outlet_id,can_switch_outlet,active,permissions,
  auth_user_id,pin_set_at,staff_id,access_class,is_super_user)
  on public.users to authenticated;

create schema if not exists private;
revoke all on schema private from public,anon;
grant usage on schema private to authenticated;

create or replace function private.actor_id() returns uuid language sql stable
security definer set search_path = '' as $$
  select id from public.users where auth_user_id=(select auth.uid()) and active=true limit 1
$$;
create or replace function private.actor_outlet() returns integer language sql stable
security definer set search_path = '' as $$
  select outlet_id from public.users where auth_user_id=(select auth.uid()) and active=true limit 1
$$;
create or replace function private.actor_staff_id() returns integer language sql stable
security definer set search_path = '' as $$
  select staff_id from public.users where auth_user_id=(select auth.uid()) and active=true limit 1
$$;
create or replace function private.is_admin() returns boolean language sql stable
security definer set search_path = '' as $$
  select exists(select 1 from public.users where auth_user_id=(select auth.uid())
    and active=true and access_class='ADMIN')
$$;
create or replace function private.is_manager() returns boolean language sql stable
security definer set search_path = '' as $$
  select exists(select 1 from public.users where auth_user_id=(select auth.uid())
    and active=true and role in ('Manager','Ops Manager'))
$$;
create or replace function private.can_operate_outlet(p_outlet integer) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.users where auth_user_id=(select auth.uid())
    and active=true and (access_class='ADMIN' or outlet_id=p_outlet))
$$;
create or replace function private.can_manage_outlet(p_outlet integer) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.users where auth_user_id=(select auth.uid())
    and active=true and (access_class='ADMIN' or
      (outlet_id=p_outlet and role in ('Manager','Ops Manager'))))
$$;
revoke all on all functions in schema private from public,anon;
grant execute on all functions in schema private to authenticated;

create or replace function private.staff_roster(p_outlet_id integer)
returns table(id integer,name varchar,outlet_id integer,active boolean)
language sql stable security definer set search_path = '' as $$
  select s.id,s.name,s.outlet_id,s.active from public.staff s
  where s.outlet_id=p_outlet_id and s.active=true
    and private.can_manage_outlet(p_outlet_id)
  order by s.name
$$;
revoke all on function private.staff_roster(integer) from public,anon;
grant execute on function private.staff_roster(integer) to authenticated;
create or replace function public.get_staff_roster(p_outlet_id integer)
returns table(id integer,name varchar,outlet_id integer,active boolean)
language sql stable security invoker set search_path = '' as $$
  select * from private.staff_roster(p_outlet_id)
$$;
revoke all on function public.get_staff_roster(integer) from public,anon;
grant execute on function public.get_staff_roster(integer) to authenticated;

-- Every exposed public table gets RLS, including those not queried directly by
-- the browser. Tables without a policy are deliberately denied to API roles.
do $$ declare r record; begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p') loop
    execute format('alter table public.%I enable row level security',r.relname);
  end loop;
end $$;

create policy outlets_login on public.outlets for select to anon using (true);
create policy outlets_active on public.outlets for select to authenticated
  using ((select private.actor_id()) is not null);
create policy outlet_hours_active on public.outlet_hours for select to authenticated
  using ((select private.can_operate_outlet(outlet_id)));
create policy categories_active on public.categories for select to authenticated
  using ((select private.actor_id()) is not null);
create policy vendors_active on public.vendors for select to authenticated
  using ((select private.actor_id()) is not null);
create policy items_active on public.items for select to authenticated
  using ((select private.actor_id()) is not null);

create policy users_directory on public.users for select to authenticated
  using ((select private.is_admin()) or auth_user_id=(select auth.uid()) or
    (active=true and outlet_id=(select private.actor_outlet())));
create policy staff_private on public.staff for select to authenticated
  using ((select private.is_admin()) or id=(select private.actor_staff_id()));

create policy summaries_manager on public.daily_summaries for select to authenticated
  using ((select private.can_manage_outlet(outlet_id)));
create policy expenses_manager on public.summary_expenses for select to authenticated
  using (exists(select 1 from public.daily_summaries d where d.id=summary_id
    and (select private.can_manage_outlet(d.outlet_id))));
create policy vendor_payouts_manager on public.summary_vendor_payouts for select to authenticated
  using (exists(select 1 from public.daily_summaries d where d.id=summary_id
    and (select private.can_manage_outlet(d.outlet_id))));
create policy staff_payouts_manager on public.summary_staff_payouts for select to authenticated
  using (exists(select 1 from public.daily_summaries d where d.id=summary_id
    and (select private.can_manage_outlet(d.outlet_id))));
create policy purchases_outlet on public.purchases for select to authenticated
  using ((select private.can_operate_outlet(outlet_id)));
create policy stocktakes_outlet on public.stocktakes for select to authenticated
  using ((select private.can_operate_outlet(outlet_id)));
create policy inventory_owner on public.inventory_entries for select to authenticated
  using ((select private.is_admin()));
create policy purchase_orders_owner on public.purchase_orders for select to authenticated
  using ((select private.is_admin()));

create policy transfers_requests_visible on public.extra_time_requests for select to authenticated
  using ((select private.can_operate_outlet(request_outlet_id)) or
    (select private.can_operate_outlet(source_outlet_id)));
create policy transfers_requests_create on public.extra_time_requests for insert to authenticated
  with check (status='REQUESTED' and requested_by=(select private.actor_id()) and
    request_outlet_id<>source_outlet_id and
    (select private.can_operate_outlet(request_outlet_id)));
create policy transfers_requests_transition on public.extra_time_requests for update to authenticated
  using ((select private.can_operate_outlet(request_outlet_id)) or
    (select private.can_operate_outlet(source_outlet_id)))
  with check ((select private.can_operate_outlet(request_outlet_id)) or
    (select private.can_operate_outlet(source_outlet_id)));

create policy transfers_dispatches_visible on public.extra_time_dispatches for select to authenticated
  using (exists(select 1 from public.extra_time_requests r where r.id=request_id and
    ((select private.can_operate_outlet(r.request_outlet_id)) or
     (select private.can_operate_outlet(r.source_outlet_id)))));
create policy transfers_dispatches_create on public.extra_time_dispatches for insert to authenticated
  with check (dispatched_by=(select private.actor_id()) and
    exists(select 1 from public.extra_time_requests r where r.id=request_id and
      (select private.can_operate_outlet(r.source_outlet_id))));
create policy transfers_dispatches_receive on public.extra_time_dispatches for update to authenticated
  using (exists(select 1 from public.extra_time_requests r where r.id=request_id and
    (select private.can_operate_outlet(r.request_outlet_id))))
  with check (exists(select 1 from public.extra_time_requests r where r.id=request_id and
    (select private.can_operate_outlet(r.request_outlet_id))));

create policy transfers_payments_review on public.extra_time_payments for select to authenticated
  using ((select private.is_admin()) or exists(
    select 1 from public.extra_time_dispatches d
      join public.extra_time_requests r on r.id=d.request_id
    where d.id=dispatch_id and
      ((select private.can_manage_outlet(r.source_outlet_id)) or
       (select private.can_manage_outlet(r.request_outlet_id)))));
create policy transfers_payments_create on public.extra_time_payments for insert to authenticated
  with check (status='READY' and exists(
    select 1 from public.extra_time_dispatches d
      join public.extra_time_requests r on r.id=d.request_id
    where d.id=dispatch_id and d.prepared_by=staff_user_id and
      (select private.can_operate_outlet(r.source_outlet_id))));

-- The three stock views are not login resources. A caller must see the
-- underlying rows through RLS; the login-directory view remains intentionally
-- limited and public to support name selection before authentication.
alter view public.current_stock set (security_invoker=true);
alter view public.stock_as_of_date set (security_invoker=true);
alter view public.stock_delta set (security_invoker=true);
revoke all on public.stock_as_of_date,public.stock_delta from anon,authenticated;
revoke all on public.current_stock from anon;

-- The client writes only a new request directly. Other writes use RPCs.
revoke insert,update,delete on all tables in schema public from authenticated;
grant insert on public.extra_time_requests to authenticated;
