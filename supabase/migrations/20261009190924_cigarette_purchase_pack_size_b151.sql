-- B151: preserve the actual pieces received on each cigarette invoice.
-- Latest receipt size prefills physical counts per café; old receipts keep base_qty.
do $migration$
declare definition text;receipt_size text := 'coalesce((select (p.base_qty/p.qty)::integer from public.purchases p where p.outlet_id=p_outlet_id and p.item_id=i.id and p.business_date<=p_date and p.entry_type=''item'' and lower(p.unit)=''pack'' and p.qty>0 and p.base_qty>0 order by p.business_date desc,p.created_at desc,p.id desc limit 1),c.pieces_per_pack)';
begin
 select pg_get_functiondef('private.cigarette_action(integer,date,text,jsonb)'::regprocedure) into definition;
 if position('qty*prof.pieces_per_pack' in definition)=0 then raise exception 'Unexpected purchase conversion';end if;
 definition:=replace(definition,'if p_action=''order'' and e ? ''pieces_per_pack''','if p_action in(''order'',''purchase'') and e ? ''pieces_per_pack''');
 definition:=replace(definition,'qty*prof.pieces_per_pack','qty*coalesce((e->>''pieces_per_pack'')::integer,(select (x->>''pieces_per_pack'')::integer from jsonb_array_elements(w->''items'')x where x->>''item_id''=e->>''item_id''))');
 execute definition;
 select pg_get_functiondef('private.cigarette_workspace(integer,date)'::regprocedure) into definition;
 if position('c.pieces_per_pack,coalesce((select (entry' in definition)=0 then raise exception 'Unexpected workspace pack size';end if;
 definition:=replace(definition,'c.pieces_per_pack,coalesce((select (entry',receipt_size||' pieces_per_pack,coalesce((select (entry');
 definition:=replace(definition,'),c.pieces_per_pack) order_pack_size', '),'||receipt_size||') order_pack_size');
 definition:=replace(definition,'then p.qty*c.pieces_per_pack','then coalesce(p.base_qty,p.qty*c.pieces_per_pack)');
 definition:=replace(definition,'p.invoice_amount/(p.qty*c.pieces_per_pack)','p.invoice_amount/nullif(coalesce(p.base_qty,p.qty*c.pieces_per_pack),0)');
 definition:=replace(definition,'p.id,p.vendor_name,p.qty,p.unit,p.invoice_amount,i.name item_name','p.id,p.vendor_name,p.qty,p.unit,p.invoice_amount,case when lower(p.unit)=''pack'' then coalesce(p.base_qty/nullif(p.qty,0),c.pieces_per_pack) end pieces_per_pack,i.name item_name');
 execute definition;
end $migration$;
create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $f$ select jsonb_build_object('schema_build',151) $f$;
