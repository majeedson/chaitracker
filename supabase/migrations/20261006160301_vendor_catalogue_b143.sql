-- B143: one vendor catalogue for Purchases and Orders. Catalogue writes are
-- append/reuse only; staff cannot rename/delete items or change another café.
create or replace function private.vendor_catalogue(p_outlet_id integer,p_module text)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
begin
  if auth.uid() is null or p_module is null or p_module not in ('purchase','orders') then raise exception 'Authenticated operational module required' using errcode='42501';end if;
  perform private.require_module_access(p_module);
  if not private.can_operate_outlet(p_outlet_id) then raise exception 'Outlet access denied' using errcode='42501';end if;
  return jsonb_build_object(
    'vendors',(select coalesce(jsonb_agg(to_jsonb(v) order by v.name),'[]') from (select id,name from public.vendors)v),
    'categories',(select coalesce(jsonb_agg(to_jsonb(c) order by c.name),'[]') from (select id,name from public.categories)c),
    'items',(select coalesce(jsonb_agg(to_jsonb(x) order by x.vendor_name,x.category_name,x.item_name),'[]') from (
      select i.id item_id,i.name item_name,i.category_id,c.name category_name,coalesce(oi.preferred_vendor_id,i.vendor_id) vendor_id,v.name vendor_name,
        i.unit,coalesce(oi.stock_unit,i.unit) order_unit,oi.order_strategy,
        case when p_module='purchase' then (select p.invoice_amount/p.qty from public.purchases p where p.outlet_id=p_outlet_id and p.item_id=i.id and p.entry_type='item' and p.qty>0 and p.invoice_amount>0 and lower(p.unit)=lower(i.unit) order by p.business_date desc,p.created_at desc,p.id desc limit 1) end last_price
      from public.outlet_items oi join public.items i on i.id=oi.item_id left join public.categories c on c.id=i.category_id
        left join public.vendors v on v.id=coalesce(oi.preferred_vendor_id,i.vendor_id)
      where oi.outlet_id=p_outlet_id and oi.active and i.active
    ) x));
end $function$;
create or replace function public.get_vendor_catalogue(p_outlet_id integer,p_module text)
returns jsonb language sql stable security invoker set search_path='' as $function$ select private.vendor_catalogue(p_outlet_id,p_module) $function$;

create or replace function private.add_vendor_catalogue_item(p_outlet_id integer,p_module text,p_vendor_id integer,p_name text,p_category_id integer,p_category_name text,p_unit text)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare
  v_name text:=regexp_replace(trim(p_name),'\s+',' ','g');
  v_category text:=regexp_replace(trim(p_category_name),'\s+',' ','g');
  v_unit text:=trim(p_unit);v_item public.items;v_category_id integer;v_vendor text;
begin
  if auth.uid() is null or p_module is null or p_module not in ('purchase','orders') then raise exception 'Authenticated operational module required' using errcode='42501';end if;
  perform private.require_module_access(p_module);
  if not private.can_operate_outlet(p_outlet_id) then raise exception 'Outlet access denied' using errcode='42501';end if;
  if not exists(select 1 from public.outlets where id=p_outlet_id) then raise exception 'Café not found';end if;
  select name into v_vendor from public.vendors where id=p_vendor_id;if not found then raise exception 'Vendor not found';end if;
  if v_name is null or length(v_name) not between 1 and 150 or v_unit is null or length(v_unit) not between 1 and 30 then raise exception 'Enter an item name and unit';end if;
  -- Serialize normalized names across cafés so simultaneous additions reuse one item.
  perform pg_advisory_xact_lock(hashtextextended('vendor-catalogue:'||p_vendor_id||':'||lower(v_name),0));
  select * into v_item from public.items i where i.vendor_id=p_vendor_id and lower(regexp_replace(trim(i.name),'\s+',' ','g'))=lower(v_name) order by i.active desc,i.created_at,i.id limit 1;
  if found then
    if not coalesce(v_item.active,false) then raise exception 'This item is inactive. Ask a manager to review it.';end if;
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
end $function$;
create or replace function public.add_vendor_catalogue_item(p_outlet_id integer,p_module text,p_vendor_id integer,p_name text,p_category_id integer,p_category_name text,p_unit text)
returns jsonb language sql security invoker set search_path='' as $function$ select private.add_vendor_catalogue_item(p_outlet_id,p_module,p_vendor_id,p_name,p_category_id,p_category_name,p_unit) $function$;

-- Save each vendor card atomically and record its canonical vendor ID for credits.
create or replace function private.save_vendor_purchase_entries(p_outlet_id integer,p_business_date date,p_user_id uuid,p_vendor_name varchar,p_entries jsonb)
returns integer language plpgsql security definer set search_path='' as $function$
declare v_actor public.users;v_vendor_id integer;v_vendor_name text;v_count integer;
begin
  perform private.require_module_access('purchase');
  select * into v_actor from public.users where id=p_user_id and active and auth_user_id=auth.uid();if not found then raise exception 'Authenticated CafeTracker user required';end if;
  if not private.can_operate_outlet(p_outlet_id) then raise exception 'Outlet access denied' using errcode='42501';end if;
  select id,name into v_vendor_id,v_vendor_name from public.vendors where name=trim(p_vendor_name);if not found then raise exception 'Select a vendor';end if;
  if p_business_date is null then raise exception 'Business date required';end if;
  if p_entries is null or jsonb_typeof(p_entries)<>'array' or jsonb_array_length(p_entries) not between 1 and 500 then raise exception 'Add purchase entries';end if;
  if exists(select 1 from jsonb_to_recordset(p_entries) x(item_id varchar,qty numeric,unit varchar,invoice_amount numeric,entry_type varchar) where
    x.entry_type is null or x.entry_type not in('item','invoice') or x.invoice_amount is null or x.invoice_amount<0 or x.invoice_amount>1000000000 or x.invoice_amount::text in('NaN','Infinity','-Infinity') or
    (x.entry_type='invoice' and (x.invoice_amount<=0 or x.item_id is not null)) or
    (x.entry_type='item' and (x.qty is null or x.qty<=0 or x.qty>1000000 or x.qty::text in('NaN','Infinity','-Infinity') or not exists(
      select 1 from public.outlet_items oi join public.items i on i.id=oi.item_id
      where oi.outlet_id=p_outlet_id and oi.item_id=x.item_id and oi.active and i.active and coalesce(oi.preferred_vendor_id,i.vendor_id)=v_vendor_id and lower(i.unit)=lower(x.unit))))) then raise exception 'Check item quantities, amounts, units and vendor';end if;
  insert into public.purchases(id,business_date,outlet_id,user_id,vendor_id,vendor_name,item_id,qty,unit,invoice_amount,entry_type)
    select 'PUR-'||gen_random_uuid(),p_business_date,p_outlet_id,v_actor.id,v_vendor_id,v_vendor_name,x.item_id,coalesce(x.qty,0),coalesce(x.unit,''),x.invoice_amount,x.entry_type
    from jsonb_to_recordset(p_entries) x(item_id varchar,qty numeric,unit varchar,invoice_amount numeric,entry_type varchar);
  get diagnostics v_count=row_count;return v_count;
end $function$;
create or replace function public.save_purchase_entries(p_outlet_id integer,p_business_date date,p_user_id uuid,p_vendor_name varchar,p_entries jsonb)
returns integer language sql security invoker set search_path='' as $function$ select private.save_vendor_purchase_entries(p_outlet_id,p_business_date,p_user_id,p_vendor_name,p_entries) $function$;

revoke all on function private.vendor_catalogue(integer,text),private.add_vendor_catalogue_item(integer,text,integer,text,integer,text,text),private.save_vendor_purchase_entries(integer,date,uuid,varchar,jsonb),public.get_vendor_catalogue(integer,text),public.add_vendor_catalogue_item(integer,text,integer,text,integer,text,text),public.save_purchase_entries(integer,date,uuid,varchar,jsonb) from public,anon;
grant execute on function private.vendor_catalogue(integer,text),private.add_vendor_catalogue_item(integer,text,integer,text,integer,text,text),private.save_vendor_purchase_entries(integer,date,uuid,varchar,jsonb),public.get_vendor_catalogue(integer,text),public.add_vendor_catalogue_item(integer,text,integer,text,integer,text,text),public.save_purchase_entries(integer,date,uuid,varchar,jsonb) to authenticated;
create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $function$ select jsonb_build_object('schema_build',143) $function$;
notify pgrst,'reload schema';
