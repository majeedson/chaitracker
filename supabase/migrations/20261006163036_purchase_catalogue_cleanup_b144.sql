-- B144: raw supplies belong to purchasing; café preparation belongs to Transfers.
alter table public.items add column if not exists purchase_enabled boolean not null default true;
alter table public.vendors add column if not exists purchase_enabled boolean not null default true;

create or replace function private.purchase_name_allowed(p_vendor_name text,p_item_name text)
returns boolean language sql immutable security invoker set search_path='' as $function$
  with names as (select trim(regexp_replace(lower(coalesce(p_vendor_name,'')),'[^a-z0-9]+',' ','g')) vendor,
    trim(regexp_replace(lower(coalesce(p_item_name,'')),'[^a-z0-9]+',' ','g')) item)
  select vendor not in ('pcafe','p cafe')
    and item not in ('keema','kheema','chicken keema','chicken kheema','finger','fingers','chicken finger','chicken fingers','boiled','boiled chicken','chicken boiled','fried','fried chicken','crispcross','crispcrosss','firehouse','tikka','chicken tikka','roasted chicken','chicken patty','chicken nuggets')
    and item !~ '^(rumali|roomali)( |$)'
    and (vendor<>'provit' or item in ('whole chicken','whole chicken patty','shawarma','shawarma chicken','chicken shawarma','wings','chicken wings','skin','chicken skin')) from names
$function$;
revoke all on function private.purchase_name_allowed(text,text) from public,anon;
grant execute on function private.purchase_name_allowed(text,text) to authenticated;

update public.vendors set purchase_enabled=false where lower(regexp_replace(name,'[^a-zA-Z0-9]','','g'))='pcafe';
update public.items set purchase_enabled=false where not private.purchase_name_allowed('Supplier',name);
-- Retain the same item identity and units while making the raw item label clear.
update public.items set name='Whole Chicken' where name='Whole Chicken (Patty)' and vendor_id in(select id from public.vendors where lower(trim(name))='provit');
-- Attach missing raw items (including shawarma at Teapot) only to cafés already using Provit.
insert into public.outlet_items(outlet_id,item_id,active,stock_unit,count_cycle,order_strategy,preferred_vendor_id,order_rounding)
select cafes.outlet_id,i.id,true,i.unit,'MONTHLY','MANUAL',v.id,case when lower(i.unit)='g' then 1000 else 1 end
from public.items i join public.vendors v on v.id=i.vendor_id
cross join (select distinct oi.outlet_id from public.outlet_items oi join public.items ri on ri.id=oi.item_id join public.vendors rv on rv.id=coalesce(oi.preferred_vendor_id,ri.vendor_id) where oi.active and lower(trim(rv.name))='provit') cafes
where i.active and i.purchase_enabled and lower(trim(v.name))='provit' and private.purchase_name_allowed(v.name,i.name)
on conflict(outlet_id,item_id) do nothing;

CREATE OR REPLACE FUNCTION public.get_tomorrows_order(p_outlet_id bigint, p_business_date date)
 RETURNS TABLE(item_id text, item_name text, category_name text, vendor_name text, order_strategy text, current_stock numeric, suggested_qty numeric, order_unit text, suggestion_basis text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
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
 from public.outlet_items oi join public.items i on i.id=oi.item_id left join public.categories c on c.id=i.category_id left join public.vendors v on v.id=coalesce(oi.preferred_vendor_id,i.vendor_id)
 left join latest l on l.item_id=oi.item_id left join hist h on h.item_id=oi.item_id where oi.outlet_id=p_outlet_id and private.has_module_access('orders') and private.can_operate_outlet(p_outlet_id::integer) and oi.active=true and i.active=true and i.purchase_enabled and v.purchase_enabled and private.purchase_name_allowed(v.name,i.name)
)
select item_id::text,item_name,category_name,vendor_name,order_strategy,current_stock,
case when order_strategy in('VENDOR_MANAGED','CONTROLLED','MANUAL') then 0 when coalesce(n15,0)>=2 then ceil(greatest(0,avg15-current_stock)/rounding)*rounding else ceil(greatest(0,fallback_target-current_stock)/rounding)*rounding end,
order_unit,case when order_strategy='VENDOR_MANAGED' then 'Vendor managed' when order_strategy in('CONTROLLED','MANUAL') then 'Manual' when coalesce(n15,0)>=2 then 'Recent purchase average ('||n15||' entries)' else 'Configured target fallback' end
from base order by category_name,vendor_name,item_name
$function$
;

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
  if not exists(select 1 from public.vendors where id=p_vendor_id and purchase_enabled) then
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
        and i.active=true and i.purchase_enabled and private.purchase_name_allowed((select name from public.vendors where id=p_vendor_id),i.name) and coalesce(oi.preferred_vendor_id,i.vendor_id)=p_vendor_id) then
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
end $function$
;

CREATE OR REPLACE FUNCTION private.save_vendor_purchase_entries(p_outlet_id integer, p_business_date date, p_user_id uuid, p_vendor_name character varying, p_entries jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor public.users;v_vendor_id integer;v_vendor_name text;v_count integer;
begin
  perform private.require_module_access('purchase');
  select * into v_actor from public.users where id=p_user_id and active and auth_user_id=auth.uid();if not found then raise exception 'Authenticated CafeTracker user required';end if;
  if not private.can_operate_outlet(p_outlet_id) then raise exception 'Outlet access denied' using errcode='42501';end if;
  select id,name into v_vendor_id,v_vendor_name from public.vendors where name=trim(p_vendor_name) and purchase_enabled;if not found then raise exception 'Select a vendor';end if;
  if p_business_date is null then raise exception 'Business date required';end if;
  if p_entries is null or jsonb_typeof(p_entries)<>'array' or jsonb_array_length(p_entries) not between 1 and 500 then raise exception 'Add purchase entries';end if;
  if exists(select 1 from jsonb_to_recordset(p_entries) x(item_id varchar,qty numeric,unit varchar,invoice_amount numeric,entry_type varchar) where
    x.entry_type is null or x.entry_type not in('item','invoice') or x.invoice_amount is null or x.invoice_amount<0 or x.invoice_amount>1000000000 or x.invoice_amount::text in('NaN','Infinity','-Infinity') or
    (x.entry_type='invoice' and (x.invoice_amount<=0 or x.item_id is not null)) or
    (x.entry_type='item' and (x.qty is null or x.qty<=0 or x.qty>1000000 or x.qty::text in('NaN','Infinity','-Infinity') or not exists(
      select 1 from public.outlet_items oi join public.items i on i.id=oi.item_id
      where oi.outlet_id=p_outlet_id and oi.item_id=x.item_id and oi.active and i.active and i.purchase_enabled and private.purchase_name_allowed(v_vendor_name,i.name) and coalesce(oi.preferred_vendor_id,i.vendor_id)=v_vendor_id and lower(i.unit)=lower(x.unit))))) then raise exception 'Check item quantities, amounts, units and vendor';end if;
  insert into public.purchases(id,business_date,outlet_id,user_id,vendor_id,vendor_name,item_id,qty,unit,invoice_amount,entry_type)
    select 'PUR-'||gen_random_uuid(),p_business_date,p_outlet_id,v_actor.id,v_vendor_id,v_vendor_name,x.item_id,coalesce(x.qty,0),coalesce(x.unit,''),x.invoice_amount,x.entry_type
    from jsonb_to_recordset(p_entries) x(item_id varchar,qty numeric,unit varchar,invoice_amount numeric,entry_type varchar);
  get diagnostics v_count=row_count;return v_count;
end $function$
;

CREATE OR REPLACE FUNCTION private.vendor_catalogue(p_outlet_id integer, p_module text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null or p_module is null or p_module not in ('purchase','orders') then raise exception 'Authenticated operational module required' using errcode='42501';end if;
  perform private.require_module_access(p_module);
  if not private.can_operate_outlet(p_outlet_id) then raise exception 'Outlet access denied' using errcode='42501';end if;
  return jsonb_build_object(
    'vendors',(select coalesce(jsonb_agg(to_jsonb(v) order by v.name),'[]') from (select id,name from public.vendors where purchase_enabled and private.purchase_name_allowed(name,'Whole Chicken'))v),
    'categories',(select coalesce(jsonb_agg(to_jsonb(c) order by c.name),'[]') from (select id,name from public.categories)c),
    'items',(select coalesce(jsonb_agg(to_jsonb(x) order by x.vendor_name,x.category_name,x.item_name),'[]') from (
      select i.id item_id,i.name item_name,i.category_id,c.name category_name,coalesce(oi.preferred_vendor_id,i.vendor_id) vendor_id,v.name vendor_name,
        i.unit,coalesce(oi.stock_unit,i.unit) order_unit,oi.order_strategy,
        case when p_module='purchase' then (select p.invoice_amount/p.qty from public.purchases p where p.outlet_id=p_outlet_id and p.item_id=i.id and p.entry_type='item' and p.qty>0 and p.invoice_amount>0 and lower(p.unit)=lower(i.unit) order by p.business_date desc,p.created_at desc,p.id desc limit 1) end last_price
      from public.outlet_items oi join public.items i on i.id=oi.item_id left join public.categories c on c.id=i.category_id
        left join public.vendors v on v.id=coalesce(oi.preferred_vendor_id,i.vendor_id)
      where oi.outlet_id=p_outlet_id and oi.active and i.active and i.purchase_enabled and v.purchase_enabled and private.purchase_name_allowed(v.name,i.name)
    ) x));
end $function$
;

CREATE OR REPLACE FUNCTION private.add_vendor_catalogue_item(p_outlet_id integer, p_module text, p_vendor_id integer, p_name text, p_category_id integer, p_category_name text, p_unit text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_name text:=regexp_replace(trim(p_name),'\s+',' ','g');
  v_category text:=regexp_replace(trim(p_category_name),'\s+',' ','g');
  v_unit text:=trim(p_unit);v_item public.items;v_category_id integer;v_vendor text;
begin
  if auth.uid() is null or p_module is null or p_module not in ('purchase','orders') then raise exception 'Authenticated operational module required' using errcode='42501';end if;
  perform private.require_module_access(p_module);
  if not private.can_operate_outlet(p_outlet_id) then raise exception 'Outlet access denied' using errcode='42501';end if;
  if not exists(select 1 from public.outlets where id=p_outlet_id) then raise exception 'Café not found';end if;
  select name into v_vendor from public.vendors where id=p_vendor_id and purchase_enabled;if not found then raise exception 'Vendor not found';end if;
  if v_name is null or length(v_name) not between 1 and 150 or v_unit is null or length(v_unit) not between 1 and 30 then raise exception 'Enter an item name and unit';end if;
  if not private.purchase_name_allowed(v_vendor,v_name) then raise exception 'Use Transfers for prepared items. Provit supplies whole chicken, shawarma, wings and skin only.';end if;
  -- Serialize normalized names across cafés so simultaneous additions reuse one item.
  perform pg_advisory_xact_lock(hashtextextended('vendor-catalogue:'||p_vendor_id||':'||lower(v_name),0));
  select * into v_item from public.items i where i.vendor_id=p_vendor_id and lower(regexp_replace(trim(i.name),'\s+',' ','g'))=lower(v_name) order by i.active desc,i.created_at,i.id limit 1;
  if found then
    if not coalesce(v_item.active,false) or not v_item.purchase_enabled then raise exception 'This item is inactive. Ask a manager to review it.';end if;
    if lower(v_item.unit)<>lower(v_unit) then raise exception 'Item already exists with unit %. Use the existing item.',v_item.unit;end if;
    v_category_id:=v_item.category_id;
  else
    if p_category_id is not null then
      select id into v_category_id from public.categories where id=p_category_id;if not found then raise exception 'Category not found';end if;
    else
      if v_category is null or length(v_category) not between 1 and 100 then raise exception 'Choose or enter a category';end if;
      perform pg_advisory_xact_lock(hashtextextended('vendor-category:'||lower(v_category),0));
      select id into v_category_id from public.categories where lower(regexp_replace(trim(name),'\s+',' ','g'))=lower(v_category) order by id limit 1;
      if not found then insert into public.categories(name) values(v_category) returning id into v_category_id;end if;
    end if;
    insert into public.items(id,name,category_id,vendor_id,unit) values('ITM-'||gen_random_uuid(),v_name,v_category_id,p_vendor_id,v_unit) returning * into v_item;
    insert into public.item_units(item_id,unit_name,base_multiplier,is_purchase_unit,is_count_unit,active) values(v_item.id,v_unit,1,true,true,true);
  end if;
  insert into public.outlet_items(outlet_id,item_id,active,stock_unit,count_cycle,order_strategy,preferred_vendor_id)
    values(p_outlet_id,v_item.id,true,v_item.unit,'MONTHLY','MANUAL',p_vendor_id)
    on conflict(outlet_id,item_id) do nothing;
  if not exists(select 1 from public.outlet_items where outlet_id=p_outlet_id and item_id=v_item.id and active and coalesce(preferred_vendor_id,v_item.vendor_id)=p_vendor_id) then raise exception 'Item is inactive or assigned to another vendor at this café. Ask a manager to review it.';end if;
  select name into v_category from public.categories where id=v_category_id;
  return jsonb_build_object('item_id',v_item.id,'item_name',v_item.name,'category_id',v_category_id,'category_name',v_category,'vendor_id',p_vendor_id,'vendor_name',v_vendor,'unit',v_item.unit,'order_unit',(select coalesce(stock_unit,v_item.unit) from public.outlet_items where outlet_id=p_outlet_id and item_id=v_item.id),'order_strategy','MANUAL','last_price',null);
end $function$
;

create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $function$ select jsonb_build_object('schema_build',144) $function$;
notify pgrst,'reload schema';
