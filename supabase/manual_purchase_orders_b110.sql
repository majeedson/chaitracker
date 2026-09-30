-- Owner-created draft POs may include any active item assigned to the café.
create or replace function public.create_manual_purchase_order(
  p_outlet_id integer, p_vendor_id integer, p_user_id uuid, p_lines jsonb)
returns varchar language plpgsql security definer set search_path = '' as $function$
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

revoke all on function public.create_manual_purchase_order(integer,integer,uuid,jsonb)
  from public,anon;
grant execute on function public.create_manual_purchase_order(integer,integer,uuid,jsonb)
  to authenticated;

create policy purchase_order_items_owner on public.purchase_order_items for select
  to authenticated using ((select private.is_admin()));
create policy outlet_items_owner on public.outlet_items for select
  to authenticated using ((select private.is_admin()));
