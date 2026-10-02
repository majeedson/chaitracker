-- B127: five-domain staff access, preserving existing role defaults.
create or replace function private.has_module_access(p_module text)
returns boolean language sql stable security definer set search_path='' as $function$
  select coalesce((select case
    when u.access_class='ADMIN' then true
    when p_module not in('orders','purchase','extra-time','delta','summary') then false
    when jsonb_typeof(u.permissions->'module_access'->p_module)='boolean'
      then (u.permissions->'module_access'->>p_module)::boolean
    else p_module in('orders','purchase','extra-time')
      or (p_module='summary' and u.role in('Manager','Ops Manager'))
    end from public.users u where u.auth_user_id=auth.uid() and u.active limit 1),false)
$function$;
create or replace function private.require_module_access(p_module text)
returns void language plpgsql stable security invoker set search_path='' as $function$
begin
  if not private.has_module_access(p_module) then raise exception 'Access to this module is disabled' using errcode='42501';end if;
end $function$;
create or replace function private.can_use_summary(p_outlet integer)
returns boolean language sql stable security invoker set search_path='' as $function$
  select private.has_module_access('summary') and private.can_operate_outlet(p_outlet)
$function$;
create or replace function private.validate_module_permissions(p_permissions jsonb)
returns void language plpgsql immutable security invoker set search_path='' as $function$
begin
  if p_permissions is null then return;end if;
  if jsonb_typeof(p_permissions)<>'object' then raise exception 'Permissions must be an object';end if;
  if p_permissions ? 'module_access' then
    if jsonb_typeof(p_permissions->'module_access')<>'object' then raise exception 'Module access must be an object';end if;
    if exists(select 1 from jsonb_each(p_permissions->'module_access') e
      where e.key not in('orders','purchase','extra-time','delta','summary') or jsonb_typeof(e.value)<>'boolean') then
      raise exception 'Choose true or false for the five supported access domains';
    end if;
  end if;
end $function$;
revoke all on function private.has_module_access(text),private.require_module_access(text),private.can_use_summary(integer),private.validate_module_permissions(jsonb) from public,anon;
grant execute on function private.has_module_access(text),private.require_module_access(text),private.can_use_summary(integer) to authenticated;

-- Staff granted Summary can use its café roster; existing manager attendance access is retained.
create or replace function private.staff_roster(p_outlet_id integer)
returns table(id integer,name varchar,outlet_id integer,active boolean)
language sql stable security definer set search_path='' as $function$
  select s.id,s.name,s.outlet_id,s.active from public.staff s
  where s.outlet_id=p_outlet_id and s.active
    and (private.can_manage_outlet(p_outlet_id) or private.can_use_summary(p_outlet_id)) order by s.name
$function$;

alter policy summaries_manager on public.daily_summaries using(private.can_use_summary(outlet_id));
alter policy expenses_manager on public.summary_expenses using(exists(select 1 from public.daily_summaries d where d.id=summary_id and private.can_use_summary(d.outlet_id)));
alter policy vendor_payouts_manager on public.summary_vendor_payouts using(exists(select 1 from public.daily_summaries d where d.id=summary_id and private.can_use_summary(d.outlet_id)));
alter policy staff_payouts_manager on public.summary_staff_payouts using(exists(select 1 from public.daily_summaries d where d.id=summary_id and private.can_use_summary(d.outlet_id)));
alter policy inventory_owner on public.inventory_entries using(private.is_admin() or (private.has_module_access('delta') and outlet_id=private.actor_outlet()));
alter policy purchases_outlet on public.purchases using(private.can_operate_outlet(outlet_id) and private.has_module_access('purchase'));

-- Orders compute suggestions internally; a disabled Purchases tab cannot read invoices.
-- Salary continues to read linked preparation earnings when Transfers is disabled.

create or replace function private.own_salary_transfer(p_kind text,p_id bigint)
returns boolean language sql stable security definer set search_path='' as $function$
  select exists(select 1 from public.extra_time_payments p
    join public.extra_time_dispatches d on d.id=p.dispatch_id
    where p.staff_user_id=private.actor_id() and
      ((p_kind='request' and d.request_id=p_id) or (p_kind='dispatch' and d.id=p_id)))
$function$;
revoke all on function private.own_salary_transfer(text,bigint) from public,anon;
grant execute on function private.own_salary_transfer(text,bigint) to authenticated;

CREATE OR REPLACE FUNCTION public.save_purchase_entries(p_outlet_id integer, p_business_date date, p_user_id uuid, p_vendor_name character varying, p_entries jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor public.users;v_admin boolean;v_count int;
begin
 perform private.require_module_access('purchase');
 select * into v_actor from public.users where id=p_user_id and active=true and auth_user_id=auth.uid();if not found then raise exception 'Authenticated CafeTracker user required';end if;
 v_admin:=coalesce(v_actor.access_class,'STAFF')='ADMIN';if not v_admin and v_actor.outlet_id<>p_outlet_id then raise exception 'You cannot record purchases for another outlet';end if;
 if p_entries is null or jsonb_typeof(p_entries)<>'array' then raise exception 'Purchase entries must be an array';end if;
 insert into public.purchases(id,business_date,outlet_id,user_id,vendor_id,vendor_name,item_id,qty,unit,invoice_amount,entry_type)
 select 'PUR-'||p_outlet_id||'-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||substr(md5(random()::text),1,6),p_business_date,p_outlet_id,v_actor.id,null,nullif(trim(p_vendor_name),''),x.item_id,x.qty,x.unit,x.invoice_amount,x.entry_type
 from jsonb_to_recordset(p_entries) x(item_id varchar,qty numeric,unit varchar,invoice_amount numeric,entry_type varchar)
 where (x.entry_type='invoice' and coalesce(x.invoice_amount,0)>0) or (x.entry_type='item' and x.item_id is not null and coalesce(x.qty,0)>0 and exists(select 1 from public.items i where i.id=x.item_id and i.active=true));
 get diagnostics v_count=row_count;if v_count=0 then raise exception 'No valid purchase entries';end if;return v_count;
end $function$;

CREATE OR REPLACE FUNCTION public.dispatch_transfer(p_outlet_id integer, p_prepared_by uuid, p_lines jsonb, p_prep_qty numeric DEFAULT NULL::numeric, p_rate numeric DEFAULT NULL::numeric)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor_id uuid; v_actor_outlet integer; v_actor_access text;
  v_request public.extra_time_requests; v_line jsonb;
  v_first_dispatch bigint; v_dispatch_id bigint; v_count integer := 0; v_category text; v_group uuid;
  v_staff_id uuid; v_qty numeric;
begin
 perform private.require_module_access('extra-time');
  select id,outlet_id,access_class into v_actor_id,v_actor_outlet,v_actor_access
    from public.users where auth_user_id=auth.uid() and active=true;
  if not found or (coalesce(v_actor_access,'STAFF')<>'ADMIN' and v_actor_outlet<>p_outlet_id)
    then raise exception 'Not authorized for this café'; end if;
  select id into v_staff_id from public.users
    where id=p_prepared_by and active=true and outlet_id=p_outlet_id;
  if not found then raise exception 'Select an active preparer at this café'; end if;
  if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'No items to dispatch'; end if;
  if (select count(*) from jsonb_array_elements(p_lines) x) <>
     (select count(distinct (x->>'request_id')::bigint) from jsonb_array_elements(p_lines) x)
    then raise exception 'Duplicate request line'; end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into v_request from public.extra_time_requests
      where id=(v_line->>'request_id')::bigint and source_outlet_id=p_outlet_id
      and status='REQUESTED' for update;
    if not found then raise exception 'Request is missing or already dispatched'; end if;
    if v_count>0 and (v_request.request_group<>v_group or v_request.category<>v_category)
      then raise exception 'Dispatch one request category at a time'; end if;
    v_group:=v_request.request_group; v_category:=v_request.category;
    v_qty:=(v_line->>'qty')::numeric;
    if v_qty is null or v_qty<=0 then raise exception 'Prepared quantity must be positive'; end if;
    insert into public.extra_time_dispatches(request_id,prepared_by,prep_qty,prep_unit,
      dispatched_qty,dispatch_unit,dispatched_by)
      values(v_request.id,p_prepared_by,case when v_count=0 then p_prep_qty end,
        case when v_count=0 and p_prep_qty is not null then
          case when v_category='CHICKEN_PATTY' then 'Chicken' else 'Pc' end end,
        v_qty,v_request.unit,v_actor_id)
      returning id into v_dispatch_id;
    if v_count=0 then v_first_dispatch:=v_dispatch_id; end if;
    update public.extra_time_requests set status='DISPATCHED' where id=v_request.id;
    v_count:=v_count+1;
  end loop;
  if v_category<>'JUICES' then
    if p_prep_qty is null or p_prep_qty<=0 or p_rate is null or p_rate<0
      then raise exception 'Preparation quantity and non-negative rate are required'; end if;
    insert into public.extra_time_payments(dispatch_id,staff_user_id,category,basis_qty,basis_unit,rate,status)
      values(v_first_dispatch,p_prepared_by,v_category,
        p_prep_qty,case when v_category='CHICKEN_PATTY' then 'Chicken' else 'Pc' end,p_rate,'READY');
  end if;
  return v_count;
end $function$;

CREATE OR REPLACE FUNCTION public.receive_transfer(p_outlet_id integer, p_lines jsonb, p_note text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor_id uuid; v_actor_outlet integer; v_actor_access text;
  v_request public.extra_time_requests; v_dispatch public.extra_time_dispatches;
  v_line jsonb; v_qty numeric; v_count integer:=0;
begin
 perform private.require_module_access('extra-time');
  select id,outlet_id,access_class into v_actor_id,v_actor_outlet,v_actor_access
    from public.users where auth_user_id=auth.uid() and active=true;
  if not found or (coalesce(v_actor_access,'STAFF')<>'ADMIN' and v_actor_outlet<>p_outlet_id)
    then raise exception 'Not authorized for this café'; end if;
  if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'No items to receive'; end if;
  if (select count(*) from jsonb_array_elements(p_lines) x) <>
     (select count(distinct (x->>'request_id')::bigint) from jsonb_array_elements(p_lines) x)
    then raise exception 'Duplicate request line'; end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into v_request from public.extra_time_requests
      where id=(v_line->>'request_id')::bigint and request_outlet_id=p_outlet_id
      and status='DISPATCHED' for update;
    if not found then raise exception 'Request is missing or already received'; end if;
    select * into v_dispatch from public.extra_time_dispatches where request_id=v_request.id for update;
    if not found then raise exception 'Dispatch record is missing'; end if;
    v_qty:=(v_line->>'qty')::numeric;
    if v_qty is null or v_qty<0 then raise exception 'Received quantity must be zero or greater'; end if;
    if v_qty<>v_dispatch.dispatched_qty and nullif(trim(p_note),'') is null
      then raise exception 'Explain any difference from the dispatched quantity'; end if;
    update public.extra_time_dispatches set received_qty=v_qty,received_by=v_actor_id,
      received_at=now(),receipt_note=nullif(trim(p_note),'') where id=v_dispatch.id;
    update public.extra_time_requests set status='RECEIVED',received_at=now() where id=v_request.id;
    v_count:=v_count+1;
  end loop;
  return v_count;
end $function$;

CREATE OR REPLACE FUNCTION public.create_manual_purchase_order(p_outlet_id integer, p_vendor_id integer, p_user_id uuid, p_lines jsonb)
 RETURNS character varying
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id varchar;
  v_date date;
  v_line jsonb;
  v_item_id varchar;
  v_qty numeric;
  v_count integer := 0;
  v_current numeric;
  v_minimum numeric;
  v_target numeric;
begin
 perform private.require_module_access('orders');
  if not private.is_admin() or p_user_id is distinct from private.actor_id() then
    raise exception 'Admin access required';
  end if;
  if not exists(select 1 from public.outlets where id=p_outlet_id) then
    raise exception 'Café not found';
  end if;
  if not exists(select 1 from public.vendors where id=p_vendor_id) then
    raise exception 'Vendor not found';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'Add at least one item';
  end if;
  if jsonb_array_length(p_lines)=0 then
    raise exception 'Add at least one item';
  end if;
  if jsonb_array_length(p_lines)>100 then raise exception 'Too many items in one order'; end if;

  -- Check the entire order before creating the header, so invalid input leaves no draft.
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) is distinct from 'object' or
       jsonb_typeof(v_line->'item_id') is distinct from 'string' or
       jsonb_typeof(v_line->'qty') is distinct from 'number' then
      raise exception 'Each item needs a quantity';
    end if;
    v_item_id:=v_line->>'item_id';
    v_qty:=(v_line->>'qty')::numeric;
    if v_qty<=0 or v_qty>1000000 then raise exception 'Quantity must be positive'; end if;
    if not exists(select 1 from public.outlet_items oi
      join public.items i on i.id=oi.item_id
      where oi.outlet_id=p_outlet_id and oi.item_id=v_item_id and oi.active=true
        and i.active=true and coalesce(oi.preferred_vendor_id,i.vendor_id)=p_vendor_id) then
      raise exception 'Item is unavailable from this vendor at this café';
    end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_lines)) <>
     (select count(distinct value->>'item_id') from jsonb_array_elements(p_lines)) then
    raise exception 'An item can appear only once';
  end if;

  v_date:=public.get_effective_business_day(p_outlet_id,now());
  v_id:='PO-'||p_outlet_id||'-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');
  insert into public.purchase_orders(id,business_date,outlet_id,vendor_id,created_by,
    status,message,order_method)
  values(v_id,v_date,p_outlet_id,p_vendor_id,p_user_id,'DRAFT',
    'Manually selected items','MANUAL');

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_item_id:=v_line->>'item_id';
    v_qty:=(v_line->>'qty')::numeric;
    select c.count_now,coalesce(oi.minimum_stock,0),coalesce(oi.target_stock,0)
      into v_current,v_minimum,v_target
    from public.outlet_items oi
    left join public.current_stock c on c.outlet_id=oi.outlet_id and c.item_id=oi.item_id
    where oi.outlet_id=p_outlet_id and oi.item_id=v_item_id;
    insert into public.purchase_order_items(purchase_order_id,item_id,current_stock,
      minimum_stock,reorder_qty,order_qty,suggestion_method)
    values(v_id,v_item_id,coalesce(v_current,0),coalesce(v_minimum,0),
      coalesce(v_target,0),v_qty,'MANUAL');
    v_count:=v_count+1;
  end loop;
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.create_low_stock_purchase_order(p_outlet_id integer, p_vendor_id integer, p_user_id uuid)
 RETURNS character varying
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor public.users;v_date date;v_id varchar;v_count int;
begin
 perform private.require_module_access('orders');
 select * into v_actor from public.users where id=p_user_id and active=true and auth_user_id=auth.uid();if not found or coalesce(v_actor.access_class,'STAFF')<>'ADMIN' then raise exception 'Admin access required';end if;
 if not exists(select 1 from public.vendors where id=p_vendor_id) then raise exception 'Vendor not found';end if;
 v_date:=public.get_effective_business_day(p_outlet_id,now());v_id:='PO-'||p_outlet_id||'-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');
 insert into public.purchase_orders(id,business_date,outlet_id,vendor_id,created_by,status,message) values(v_id,v_date,p_outlet_id,p_vendor_id,v_actor.id,'DRAFT','Generated from current stock below minimum');
 insert into public.purchase_order_items(purchase_order_id,item_id,current_stock,minimum_stock,reorder_qty,order_qty)
 select v_id,c.item_id,c.count_now,c.minimum_stock,c.reorder_qty,greatest(coalesce(c.reorder_qty,0),coalesce(c.minimum_stock,0)-coalesce(c.count_now,0))
 from public.current_stock c join public.items i on i.id=c.item_id
 where c.outlet_id=p_outlet_id and i.vendor_id=p_vendor_id and coalesce(c.minimum_stock,0)>0 and coalesce(c.count_now,0)<c.minimum_stock;
 get diagnostics v_count=row_count;if v_count=0 then delete from public.purchase_orders where id=v_id;raise exception 'No below-minimum items for this vendor';end if;
 return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.save_daily_summary(p_summary_id character varying, p_outlet_id integer, p_business_date date, p_user_id uuid, p_user_name character varying, p_role character varying, p_cash_sale numeric DEFAULT 0, p_upi_sale numeric DEFAULT 0, p_swiggy_gross numeric DEFAULT 0, p_swiggy_payout numeric DEFAULT 0, p_zomato_gross numeric DEFAULT 0, p_zomato_payout numeric DEFAULT 0, p_own_digital numeric DEFAULT 0, p_discount numeric DEFAULT 0, p_opening_cash_system numeric DEFAULT 0, p_opening_cash_actual numeric DEFAULT 0, p_physical_cash numeric DEFAULT 0, p_expenses jsonb DEFAULT '[]'::jsonb, p_vendor_payouts jsonb DEFAULT '[]'::jsonb, p_staff_payouts jsonb DEFAULT '[]'::jsonb)
 RETURNS daily_summaries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_summary public.daily_summaries;v_net numeric;v_expected numeric;v_actor public.users;v_admin boolean;
begin
 perform private.require_module_access('summary');
 select * into v_actor from public.users where id=p_user_id and active=true and auth_user_id=auth.uid();
 if not found then raise exception 'Authenticated CafeTracker user required';end if;
 v_admin:=coalesce(v_actor.access_class,'STAFF')='ADMIN';
 if not v_admin and not private.has_module_access('summary') then raise exception 'Manager or Admin access required';end if;
 if not v_admin and v_actor.outlet_id<>p_outlet_id then raise exception 'You cannot save another outlet summary';end if;
 if not exists(select 1 from public.outlets where id=p_outlet_id) then raise exception 'Outlet not found';end if;
 if exists(select 1 from public.daily_summaries where id=p_summary_id and is_closed=true) then raise exception 'Daily summary is already closed';end if;
 if exists(select 1 from public.daily_summaries where id=p_summary_id and (outlet_id<>p_outlet_id or business_date<>p_business_date)) then raise exception 'Summary identity does not match outlet and business date';end if;
 insert into public.daily_summaries(id,outlet_id,business_date,saved_by,saved_by_name,role,cash_sale,upi_sale,swiggy_gross,swiggy_payout,zomato_gross,zomato_payout,own_digital,discount,net_sale,opening_cash_system,opening_cash_actual,physical_cash,expected_cash,short_excess,summary_status,is_closed)
 values(p_summary_id,p_outlet_id,p_business_date,v_actor.id,v_actor.name,case when v_admin then 'Admin' else v_actor.role end,coalesce(p_cash_sale,0),coalesce(p_upi_sale,0),coalesce(p_swiggy_gross,0),coalesce(p_swiggy_payout,0),coalesce(p_zomato_gross,0),coalesce(p_zomato_payout,0),coalesce(p_own_digital,0),coalesce(p_discount,0),0,coalesce(p_opening_cash_system,0),coalesce(p_opening_cash_actual,0),coalesce(p_physical_cash,0),0,0,'OPEN',false)
 on conflict(id) do update set saved_by=excluded.saved_by,saved_by_name=excluded.saved_by_name,role=excluded.role,cash_sale=excluded.cash_sale,upi_sale=excluded.upi_sale,swiggy_gross=excluded.swiggy_gross,swiggy_payout=excluded.swiggy_payout,zomato_gross=excluded.zomato_gross,zomato_payout=excluded.zomato_payout,own_digital=excluded.own_digital,discount=excluded.discount,opening_cash_system=excluded.opening_cash_system,opening_cash_actual=excluded.opening_cash_actual,physical_cash=excluded.physical_cash,summary_status='OPEN',is_closed=false;
 delete from public.summary_expenses where summary_id=p_summary_id;delete from public.summary_vendor_payouts where summary_id=p_summary_id;delete from public.summary_staff_payouts where summary_id=p_summary_id;
 insert into public.summary_expenses(summary_id,category,amount,mode) select p_summary_id,x.category,x.amount,coalesce(x.mode,'Cash') from jsonb_to_recordset(coalesce(p_expenses,'[]'::jsonb)) x(category varchar,amount numeric,mode varchar);
 insert into public.summary_vendor_payouts(summary_id,vendor_name,amount,mode) select p_summary_id,x.vendor_name,x.amount,coalesce(x.mode,'Cash') from jsonb_to_recordset(coalesce(p_vendor_payouts,'[]'::jsonb)) x(vendor_name varchar,amount numeric,mode varchar);
 insert into public.summary_staff_payouts(summary_id,staff_id,staff_name,payout_type,amount,mode)
 select p_summary_id,x.staff_id,s.name,x.payout_type,x.amount,coalesce(x.mode,'Cash')
 from jsonb_to_recordset(coalesce(p_staff_payouts,'[]'::jsonb)) x(staff_id integer,staff_name varchar,payout_type varchar,amount numeric,mode varchar)
 join public.staff s on s.id=x.staff_id and s.outlet_id=p_outlet_id;
 v_net:=coalesce(p_cash_sale,0)+coalesce(p_upi_sale,0)+coalesce(p_swiggy_payout,0)+coalesce(p_zomato_payout,0)+coalesce(p_own_digital,0)-coalesce(p_discount,0);
 v_expected:=public.get_expected_cash(p_summary_id);
 update public.daily_summaries set net_sale=v_net,expected_cash=v_expected,short_excess=coalesce(p_physical_cash,0)-v_expected where id=p_summary_id returning * into v_summary;
 insert into public.business_days(outlet_id,business_date,summary_status) values(p_outlet_id,p_business_date,'OPEN') on conflict(outlet_id,business_date) do update set summary_status='OPEN';
 return v_summary;
end $function$;

CREATE OR REPLACE FUNCTION public.close_daily_summary(p_summary_id character varying, p_user_id uuid)
 RETURNS daily_summaries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_summary public.daily_summaries;v_actor public.users;
begin
 perform private.require_module_access('summary');
 select * into v_actor from public.users where id=p_user_id and active=true and auth_user_id=auth.uid();
 if not found or (coalesce(v_actor.access_class,'STAFF')<>'ADMIN' and not private.has_module_access('summary')) then raise exception 'Manager or Admin access required';end if;
 select * into v_summary from public.daily_summaries where id=p_summary_id;if not found then raise exception 'Daily summary not found: %',p_summary_id;end if;
 if coalesce(v_actor.access_class,'STAFF')<>'ADMIN' and v_actor.outlet_id<>v_summary.outlet_id then raise exception 'You cannot close another outlet summary';end if;
 update public.daily_summaries set is_closed=true,summary_status='CLOSED',closed_by=p_user_id,closed_at=now() where id=p_summary_id returning * into v_summary;
 update public.business_days set summary_status='CLOSED' where outlet_id=v_summary.outlet_id and business_date=v_summary.business_date;
 insert into public.daily_summary_audit(summary_id,outlet_id,business_date,action,actor_user_id,actor_name,actor_role) values(v_summary.id,v_summary.outlet_id,v_summary.business_date,'CLOSED',v_actor.id,v_actor.name,case when v_actor.access_class='ADMIN' then 'Admin' else v_actor.role end);
 return v_summary;
end $function$;

CREATE OR REPLACE FUNCTION public.reopen_daily_summary(p_summary_id character varying, p_user_id uuid)
 RETURNS daily_summaries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_summary public.daily_summaries;v_actor public.users;v_deadline timestamptz;v_admin boolean;
begin
 perform private.require_module_access('summary');
 select * into v_actor from public.users where id=p_user_id and active=true and auth_user_id=auth.uid();
 v_admin:=coalesce(v_actor.access_class,'STAFF')='ADMIN';
 if not found or (not v_admin and not private.has_module_access('summary')) then raise exception 'Manager or Admin access required';end if;
 select * into v_summary from public.daily_summaries where id=p_summary_id;if not found then raise exception 'Daily summary not found: %',p_summary_id;end if;
 if not v_summary.is_closed then return v_summary;end if;
 if not v_admin then
  if v_actor.outlet_id<>v_summary.outlet_id then raise exception 'You cannot reopen another outlet summary';end if;
  v_deadline:=public.get_daily_summary_reopen_deadline(p_summary_id);
  if now()>=v_deadline then raise exception 'Manager reopen window has closed. Admin access required.';end if;
 end if;
 update public.daily_summaries set is_closed=false,summary_status='OPEN',closed_by=null,closed_at=null where id=p_summary_id returning * into v_summary;
 update public.business_days set summary_status='OPEN' where outlet_id=v_summary.outlet_id and business_date=v_summary.business_date;
 insert into public.daily_summary_audit(summary_id,outlet_id,business_date,action,actor_user_id,actor_name,actor_role) values(v_summary.id,v_summary.outlet_id,v_summary.business_date,'REOPENED',v_actor.id,v_actor.name,case when v_admin then 'Admin' else v_actor.role end);
 return v_summary;
end $function$;

CREATE OR REPLACE FUNCTION public.get_tomorrows_order(p_outlet_id bigint, p_business_date date)
 RETURNS TABLE(item_id text, item_name text, category_name text, vendor_name text, order_strategy text, current_stock numeric, suggested_qty numeric, order_unit text, suggestion_basis text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with latest as (
 select distinct on (sl.item_id) sl.item_id,sl.counted_quantity_base qty from public.stocktakes st join public.stocktake_lines sl on sl.stocktake_id=st.id
 where st.outlet_id=p_outlet_id and st.business_date=p_business_date and st.status='SUBMITTED'
 order by sl.item_id,st.submitted_at desc nulls last,st.id desc
), hist as (
 select p.item_id,avg(p.qty) filter(where p.business_date>=p_business_date-14 and p.business_date<p_business_date) avg15,
 count(*) filter(where p.business_date>=p_business_date-14 and p.business_date<p_business_date) n15
 from public.purchases p where p.outlet_id=p_outlet_id and p.item_id is not null and p.entry_type='item' group by p.item_id
), base as (
 select oi.item_id,i.name item_name,c.name category_name,coalesce(v.name,'Unassigned') vendor_name,oi.order_strategy,coalesce(l.qty,0) current_stock,
 coalesce(oi.stock_unit,i.unit) order_unit,h.avg15,h.n15,coalesce(oi.target_stock,i.reorder_qty,oi.minimum_stock,i.minimum_stock,0) fallback_target,greatest(coalesce(oi.order_rounding,1),0.0001) rounding
 from public.outlet_items oi join public.items i on i.id=oi.item_id left join public.categories c on c.id=i.category_id left join public.vendors v on v.id=oi.preferred_vendor_id
 left join latest l on l.item_id=oi.item_id left join hist h on h.item_id=oi.item_id where oi.outlet_id=p_outlet_id and private.has_module_access('orders') and private.can_operate_outlet(p_outlet_id::integer) and oi.active=true and i.active=true
)
select item_id::text,item_name,category_name,vendor_name,order_strategy,current_stock,
case when order_strategy in('VENDOR_MANAGED','CONTROLLED','MANUAL') then 0 when coalesce(n15,0)>=2 then ceil(greatest(0,avg15-current_stock)/rounding)*rounding else ceil(greatest(0,fallback_target-current_stock)/rounding)*rounding end,
order_unit,case when order_strategy='VENDOR_MANAGED' then 'Vendor managed' when order_strategy in('CONTROLLED','MANUAL') then 'Manual' when coalesce(n15,0)>=2 then 'Recent purchase average ('||n15||' entries)' else 'Configured target fallback' end
from base order by category_name,vendor_name,item_name
$function$;

CREATE OR REPLACE FUNCTION public.owner_add_staff(p_name text, p_outlet_id integer, p_role text, p_basic_salary numeric, p_joining_date date, p_permissions jsonb DEFAULT '{"stock": true, "salary": false, "summary": true, "purchase": true, "attendance": true}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare actor uuid; new_staff_id integer; new_user_id uuid;
begin
 perform private.validate_module_permissions(p_permissions);
 if p_role is null or p_role not in('Staff','Manager','Ops Manager') then raise exception 'Choose a valid staff role';end if;
 actor:=auth.uid();
 if actor is null or not exists(select 1 from public.users u where u.auth_user_id=actor and u.role='Owner' and u.active=true) then raise exception 'Owner access required.'; end if;
 if nullif(trim(p_name),'') is null then raise exception 'Staff name is required.'; end if;
 if p_outlet_id is null or not exists(select 1 from public.outlets where id=p_outlet_id) then raise exception 'Valid outlet is required.'; end if;
 if p_basic_salary is null or p_basic_salary <= 0 then raise exception 'Agreed salary must be greater than zero.'; end if;
 if p_joining_date is null then raise exception 'Joining date is required.'; end if;
 insert into public.staff(name,outlet_id,basic_salary,joining_date,active) values(trim(p_name),p_outlet_id,p_basic_salary,p_joining_date,true) returning id into new_staff_id;
 insert into public.users(name,pin_hash,role,outlet_id,can_switch_outlet,active,permissions,staff_id,pin_setup_hash,pin_setup_expires_at)
 values(trim(p_name),null,coalesce(nullif(trim(p_role),''),'Staff'),p_outlet_id,false,true,coalesce(p_permissions,'{}'::jsonb),new_staff_id,null,null)
 returning id into new_user_id;
 return jsonb_build_object('staff_id',new_staff_id,'user_id',new_user_id);
end $function$;

CREATE OR REPLACE FUNCTION public.owner_update_staff(p_staff_id integer, p_name text, p_outlet_id integer, p_role text, p_basic_salary numeric, p_joining_date date, p_active boolean, p_permissions jsonb, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ declare actor uuid; uid uuid; begin
 perform private.validate_module_permissions(p_permissions);
 if p_role is null or p_role not in('Staff','Manager','Ops Manager') then raise exception 'Choose a valid staff role';end if; actor:=auth.uid(); if actor is null or not exists(select 1 from public.users u where u.auth_user_id=actor and u.role='Owner' and u.active=true) then raise exception 'Owner access required.'; end if; if nullif(trim(p_name),'') is null or p_basic_salary is null or p_basic_salary<=0 or p_joining_date is null then raise exception 'Name, salary and joining date are required.'; end if; select u.id into uid from public.users u where u.staff_id=p_staff_id; if uid is null then raise exception 'User profile not found.'; end if; update public.staff set name=trim(p_name),outlet_id=p_outlet_id,basic_salary=p_basic_salary,joining_date=p_joining_date,active=p_active,notes=nullif(trim(coalesce(p_notes,'')),'') where id=p_staff_id; update public.users set name=trim(p_name),outlet_id=p_outlet_id,role=coalesce(nullif(trim(p_role),''),'Staff'),active=p_active,permissions=coalesce(p_permissions,'{}'::jsonb),deactivated_at=case when p_active then null else coalesce(deactivated_at,now()) end where id=uid; return jsonb_build_object('staff_id',p_staff_id,'user_id',uid,'active',p_active); end $function$;

alter policy transfers_dispatches_create on public.extra_time_dispatches with check((((dispatched_by = ( SELECT private.actor_id() AS actor_id)) AND (EXISTS ( SELECT 1
   FROM extra_time_requests r
  WHERE ((r.id = extra_time_dispatches.request_id) AND ( SELECT private.can_operate_outlet(r.source_outlet_id) AS can_operate_outlet)))))) and private.has_module_access('extra-time'));

alter policy transfers_dispatches_receive on public.extra_time_dispatches using(((EXISTS ( SELECT 1
   FROM extra_time_requests r
  WHERE ((r.id = extra_time_dispatches.request_id) AND ( SELECT private.can_operate_outlet(r.request_outlet_id) AS can_operate_outlet))))) and private.has_module_access('extra-time')) with check(((EXISTS ( SELECT 1
   FROM extra_time_requests r
  WHERE ((r.id = extra_time_dispatches.request_id) AND ( SELECT private.can_operate_outlet(r.request_outlet_id) AS can_operate_outlet))))) and private.has_module_access('extra-time'));


alter policy transfers_payments_create on public.extra_time_payments with check((((status = 'READY'::text) AND (EXISTS ( SELECT 1
   FROM (extra_time_dispatches d
     JOIN extra_time_requests r ON ((r.id = d.request_id)))
  WHERE ((d.id = extra_time_payments.dispatch_id) AND (d.prepared_by = extra_time_payments.staff_user_id) AND ( SELECT private.can_operate_outlet(r.source_outlet_id) AS can_operate_outlet)))))) and private.has_module_access('extra-time'));


alter policy transfers_requests_create on public.extra_time_requests with check((((status = 'REQUESTED'::text) AND (requested_by = ( SELECT private.actor_id() AS actor_id)) AND (request_outlet_id <> source_outlet_id) AND ( SELECT private.can_operate_outlet(extra_time_requests.request_outlet_id) AS can_operate_outlet))) and private.has_module_access('extra-time'));

alter policy transfers_requests_transition on public.extra_time_requests using(((( SELECT private.can_operate_outlet(extra_time_requests.request_outlet_id) AS can_operate_outlet) OR ( SELECT private.can_operate_outlet(extra_time_requests.source_outlet_id) AS can_operate_outlet))) and private.has_module_access('extra-time')) with check(((( SELECT private.can_operate_outlet(extra_time_requests.request_outlet_id) AS can_operate_outlet) OR ( SELECT private.can_operate_outlet(extra_time_requests.source_outlet_id) AS can_operate_outlet))) and private.has_module_access('extra-time'));


-- Summary can read approved/paid advances at its own café for cash reconciliation.
create policy advance_summary_reconciliation on public.staff_advance_requests for select to authenticated using(status in('APPROVED','PAID') and private.can_use_summary(outlet_id));

alter policy transfers_dispatches_visible on public.extra_time_dispatches using((((EXISTS ( SELECT 1
   FROM extra_time_requests r
  WHERE ((r.id = extra_time_dispatches.request_id) AND (( SELECT private.can_operate_outlet(r.request_outlet_id) AS can_operate_outlet) OR ( SELECT private.can_operate_outlet(r.source_outlet_id) AS can_operate_outlet)))))) and private.has_module_access('extra-time')) or private.own_salary_transfer('dispatch',id));

alter policy transfers_payments_review on public.extra_time_payments using((((( SELECT private.is_admin() AS is_admin) OR (EXISTS ( SELECT 1
   FROM (extra_time_dispatches d
     JOIN extra_time_requests r ON ((r.id = d.request_id)))
  WHERE ((d.id = extra_time_payments.dispatch_id) AND (( SELECT private.can_manage_outlet(r.source_outlet_id) AS can_manage_outlet) OR ( SELECT private.can_manage_outlet(r.request_outlet_id) AS can_manage_outlet))))))) and private.has_module_access('extra-time')) or staff_user_id=private.actor_id());

alter policy transfers_requests_visible on public.extra_time_requests using((((( SELECT private.can_operate_outlet(extra_time_requests.request_outlet_id) AS can_operate_outlet) OR ( SELECT private.can_operate_outlet(extra_time_requests.source_outlet_id) AS can_operate_outlet))) and private.has_module_access('extra-time')) or private.own_salary_transfer('request',id));
