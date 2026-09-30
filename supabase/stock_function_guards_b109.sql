-- B109: bound privileged stock RPCs to the authenticated actor and café.
CREATE OR REPLACE FUNCTION public.get_monthly_stock(p_outlet_id bigint, p_business_date date)
 RETURNS TABLE(item_id text, item_name text, category_name text, stock_unit text, count_cycle text, order_strategy text, minimum_stock numeric, target_stock numeric, order_rounding numeric, preferred_vendor_id bigint, vendor_name text, last_count numeric, last_count_date date, pieces_per_pack integer)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with take_counts as (
 select distinct on(sl.item_id) sl.item_id,sl.counted_quantity_base qty,st.business_date dt
 from public.stocktakes st join public.stocktake_lines sl on sl.stocktake_id=st.id
 where st.outlet_id=p_outlet_id and st.business_date<=p_business_date and st.status='SUBMITTED'
 order by sl.item_id,st.business_date desc,st.submitted_at desc nulls last,st.id desc
), legacy_counts as (
 select distinct on(ie.item_id) ie.item_id,ie.count_now::numeric qty,ie.business_date::date dt
 from public.inventory_entries ie where ie.outlet_id=p_outlet_id and ie.business_date<=p_business_date
 order by ie.item_id,ie.business_date desc,ie.created_at desc
), best as (
 select oi.item_id,case when tc.dt is not null and (lc.dt is null or tc.dt>=lc.dt) then tc.qty else lc.qty end qty,greatest(tc.dt,lc.dt) dt
 from public.outlet_items oi left join take_counts tc on tc.item_id=oi.item_id left join legacy_counts lc on lc.item_id=oi.item_id
 where oi.outlet_id=p_outlet_id
)
select oi.item_id::text,i.name,c.name,coalesce(oi.stock_unit,i.unit),oi.count_cycle,oi.order_strategy,
coalesce(oi.minimum_stock,i.minimum_stock,0),coalesce(oi.target_stock,i.reorder_qty,oi.minimum_stock,i.minimum_stock,0),
coalesce(oi.order_rounding,1),oi.preferred_vendor_id,v.name,coalesce(b.qty,0),b.dt,cp.pieces_per_pack
from public.outlet_items oi join public.items i on i.id=oi.item_id left join public.categories c on c.id=i.category_id
left join public.vendors v on v.id=oi.preferred_vendor_id left join best b on b.item_id=oi.item_id
left join public.cigarette_profiles cp on cp.item_id=oi.item_id
where oi.outlet_id=p_outlet_id and private.can_operate_outlet(p_outlet_id::integer) and oi.active=true and i.active=true
order by c.name,i.name $function$;


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
 left join latest l on l.item_id=oi.item_id left join hist h on h.item_id=oi.item_id where oi.outlet_id=p_outlet_id and private.can_operate_outlet(p_outlet_id::integer) and oi.active=true and i.active=true
)
select item_id::text,item_name,category_name,vendor_name,order_strategy,current_stock,
case when order_strategy in('VENDOR_MANAGED','CONTROLLED','MANUAL') then 0 when coalesce(n15,0)>=2 then ceil(greatest(0,avg15-current_stock)/rounding)*rounding else ceil(greatest(0,fallback_target-current_stock)/rounding)*rounding end,
order_unit,case when order_strategy='VENDOR_MANAGED' then 'Vendor managed' when order_strategy in('CONTROLLED','MANUAL') then 'Manual' when coalesce(n15,0)>=2 then 'Recent purchase average ('||n15||' entries)' else 'Configured target fallback' end
from base order by category_name,vendor_name,item_name
$function$;


CREATE OR REPLACE FUNCTION public.get_tonights_stock(p_outlet_id bigint, p_business_date date)
 RETURNS TABLE(item_id text, item_name text, category_name text, stock_unit text, count_cycle text, order_strategy text, minimum_stock numeric, target_stock numeric, order_rounding numeric, preferred_vendor_id bigint, vendor_name text, last_count numeric, last_count_date date, pieces_per_pack integer)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with take_counts as (
 select distinct on(sl.item_id) sl.item_id,sl.counted_quantity_base qty,st.business_date dt
 from public.stocktakes st join public.stocktake_lines sl on sl.stocktake_id=st.id
 where st.outlet_id=p_outlet_id and st.business_date<=p_business_date and st.status='SUBMITTED'
 order by sl.item_id,st.business_date desc,st.submitted_at desc nulls last,st.id desc
), legacy_counts as (
 select distinct on(ie.item_id) ie.item_id,ie.count_now::numeric qty,ie.business_date::date dt
 from public.inventory_entries ie where ie.outlet_id=p_outlet_id and ie.business_date<=p_business_date
 order by ie.item_id,ie.business_date desc,ie.created_at desc
), best as (
 select oi.item_id,
 case when tc.dt is not null and (lc.dt is null or tc.dt>=lc.dt) then tc.qty else lc.qty end qty,
 greatest(tc.dt,lc.dt) dt
 from public.outlet_items oi left join take_counts tc on tc.item_id=oi.item_id left join legacy_counts lc on lc.item_id=oi.item_id
 where oi.outlet_id=p_outlet_id
)
select oi.item_id::text,i.name,c.name,coalesce(oi.stock_unit,i.unit),oi.count_cycle,oi.order_strategy,
coalesce(oi.minimum_stock,i.minimum_stock,0),coalesce(oi.target_stock,i.reorder_qty,oi.minimum_stock,i.minimum_stock,0),
coalesce(oi.order_rounding,1),oi.preferred_vendor_id,v.name,coalesce(b.qty,0),b.dt,cp.pieces_per_pack
from public.outlet_items oi join public.items i on i.id=oi.item_id left join public.categories c on c.id=i.category_id
left join public.vendors v on v.id=oi.preferred_vendor_id left join best b on b.item_id=oi.item_id
left join public.cigarette_profiles cp on cp.item_id=oi.item_id
where oi.outlet_id=p_outlet_id and private.can_operate_outlet(p_outlet_id::integer) and oi.active=true and i.active=true and
(oi.count_cycle in('DAILY','CONTROLLED') or (oi.count_cycle='WEEKLY' and extract(dow from p_business_date)::int=coalesce(oi.count_weekday,5)) or (oi.count_cycle='MONTHLY' and p_business_date=(date_trunc('month',p_business_date)+interval '1 month - 1 day')::date))
order by case oi.count_cycle when 'CONTROLLED' then 0 when 'DAILY' then 1 when 'WEEKLY' then 2 else 3 end,c.name,i.name
$function$;


CREATE OR REPLACE FUNCTION public.save_monthly_stocktake(p_outlet_id bigint, p_business_date date, p_user_id uuid, p_entries jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_location bigint;v_take bigint;e jsonb;
begin
 if not private.can_operate_outlet(p_outlet_id::integer) or p_user_id is distinct from private.actor_id() then
   raise exception 'Not authorized for this café';
 end if;
 select id into v_location from public.stock_locations where outlet_id=p_outlet_id and is_default=true limit 1;
 insert into public.stocktakes(outlet_id,location_id,business_date,stocktake_type,status,started_by,submitted_by,submitted_at)
 values(p_outlet_id,v_location,p_business_date,'MONTHLY','SUBMITTED',p_user_id,p_user_id,now()) returning id into v_take;
 for e in select * from jsonb_array_elements(p_entries) loop
  insert into public.stocktake_lines(stocktake_id,item_id,counted_quantity_base,display_quantity,display_unit,note)
  values(v_take,e->>'item_id',(e->>'count_now')::numeric,(e->>'count_now')::numeric,e->>'unit',null);
 end loop;
 return v_take;
end $function$;


CREATE OR REPLACE FUNCTION public.save_tonights_stocktake(p_outlet_id bigint, p_business_date date, p_user_id uuid, p_entries jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_location bigint; v_take bigint; e jsonb;
begin
 if not private.can_operate_outlet(p_outlet_id::integer) or p_user_id is distinct from private.actor_id() then
   raise exception 'Not authorized for this café';
 end if;
 select id into v_location from public.stock_locations where outlet_id=p_outlet_id and is_default=true limit 1;
 insert into public.stocktakes(outlet_id,location_id,business_date,stocktake_type,status,started_by,submitted_by,submitted_at)
 values(p_outlet_id,v_location,p_business_date,'DAILY','SUBMITTED',p_user_id,p_user_id,now())
 returning id into v_take;
 for e in select * from jsonb_array_elements(p_entries) loop
   insert into public.stocktake_lines(stocktake_id,item_id,counted_quantity_base,display_quantity,display_unit,note)
   values(v_take,e->>'item_id',(e->>'count_now')::numeric,(e->>'count_now')::numeric,e->>'unit',null);
 end loop;
 return v_take;
end $function$;

