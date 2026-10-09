-- B149: PK450 replaces PK350 for current entry. Preserve closed-day snapshots.
alter table public.outlet_items drop constraint outlet_items_cigarette_pack_price_check;
update public.outlet_items set cigarette_pack_price=450 where cigarette_pack_price=350;
alter table public.outlet_items add constraint outlet_items_cigarette_pack_price_check check(cigarette_pack_price in(0,140,260,400,450));
do $migration$
declare definition text;
begin
 select pg_get_functiondef('private.cigarette_action(integer,date,text,jsonb)'::regprocedure) into definition;
 if position('140,260,350,400' in definition)=0 then raise exception 'Unexpected PK validation definition';end if;
 execute replace(replace(definition,'140,260,350,400','140,260,400,450'),'PK140, PK260, PK350 or PK400','PK140, PK260, PK400 or PK450');
end $migration$;
update public.cigarette_days d set pack_sales=(select jsonb_agg(case when (x->>'price')::numeric=350 then jsonb_set(x,'{price}','450'::jsonb) else x end order by ord) from jsonb_array_elements(d.pack_sales) with ordinality as e(x,ord))
where closed_at is null and exists(select 1 from jsonb_array_elements(d.pack_sales)x where (x->>'price')::numeric=350)
and not exists(select 1 from jsonb_array_elements(d.pack_sales)x where (x->>'price')::numeric=350 and ((x->>'packs')::numeric<>0 or (x->>'amount')::numeric<>0));
create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $f$ select jsonb_build_object('schema_build',149) $f$;
