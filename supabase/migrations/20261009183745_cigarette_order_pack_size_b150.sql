-- B150: order-specific pack sizes, separate from stock and purchase conversion.
do $migration$
declare definition text;
begin
 select pg_get_functiondef('private.cigarette_action(integer,date,text,jsonb)'::regprocedure) into definition;
 definition:=replace(definition,'qty:=(e->>''packs'')::numeric;n:=(e->>''amount'')::numeric;',
 'if p_action=''order'' and e ? ''pieces_per_pack'' and (nullif(e->>''pieces_per_pack'','''') is null or (e->>''pieces_per_pack'')::numeric not between 1 and 100 or (e->>''pieces_per_pack'')::numeric<>trunc((e->>''pieces_per_pack'')::numeric)) then raise exception ''Enter whole pieces per pack (1–100)'';end if;
 qty:=(e->>''packs'')::numeric;n:=(e->>''amount'')::numeric;');
 definition:=replace(definition,'if pk is null or pk not in(0,140,260,400,450) then raise exception ''Set the PK category for this brand'';end if;',
 'if (pk is null and coalesce(p_payload->>''source'','''')<>''orders'') or (pk is not null and pk not in(0,140,260,400,450)) then raise exception ''Set the PK category for this brand'';end if;');
 definition:=replace(definition,'update public.outlet_items set cigarette_pack_price=pk where outlet_id=p_outlet_id and item_id=item.id;',
 'if pk is not null then update public.outlet_items set cigarette_pack_price=pk where outlet_id=p_outlet_id and item_id=item.id;end if;');
 execute definition;
 select pg_get_functiondef('private.cigarette_workspace(integer,date)'::regprocedure) into definition;
 definition:=replace(definition,'c.pieces_per_pack,coalesce(oi.cigarette_pos_price',
 'c.pieces_per_pack,coalesce((select (entry->>''pieces_per_pack'')::integer from public.cigarette_audit a cross join lateral jsonb_array_elements(a.payload->''input''->''entries'') entry where a.outlet_id=p_outlet_id and a.business_date<=p_date and a.action=''order'' and entry->>''item_id''=i.id and entry->>''pieces_per_pack'' is not null order by a.business_date desc,a.created_at desc limit 1),c.pieces_per_pack) order_pack_size,coalesce(oi.cigarette_pos_price');
 execute definition;
end $migration$;
create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $f$ select jsonb_build_object('schema_build',150) $f$;
