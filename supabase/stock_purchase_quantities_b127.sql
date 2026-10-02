-- Stock needs incoming quantities even when the Purchases domain is disabled.
-- This endpoint exposes quantity fields only, scoped to the user's own café.
create or replace function public.get_stock_purchase_quantities(p_outlet_id integer,p_business_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare v_rows jsonb;
begin
  if not private.can_operate_outlet(p_outlet_id) then raise exception 'Outlet access denied' using errcode='42501';end if;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_rows from(
    select p.item_id,p.business_date,p.qty,p.unit from public.purchases p
    where p.outlet_id=p_outlet_id and p.item_id is not null and p.business_date<=p_business_date
    order by p.business_date desc limit 500
  ) x;
  return v_rows;
end $function$;
revoke all on function public.get_stock_purchase_quantities(integer,date) from public,anon;
grant execute on function public.get_stock_purchase_quantities(integer,date) to authenticated;
