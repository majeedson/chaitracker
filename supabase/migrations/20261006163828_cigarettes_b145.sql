-- B145: dedicated cigarette operations; POS sales remain SK price-group totals.
alter table public.cigarette_profiles add column if not exists pos_price numeric;
alter table public.cigarette_profiles add constraint cigarette_pos_price_valid check(pos_price is null or (pos_price>0 and pos_price<=10000));
alter table public.outlet_items add column if not exists cigarette_pos_price numeric check(cigarette_pos_price is null or (cigarette_pos_price>0 and cigarette_pos_price<=10000));
update public.outlet_items oi set preferred_vendor_id=v.id from public.vendors v,public.outlets o
 where o.id=oi.outlet_id and lower(o.name)='teapot' and lower(v.name)='kini'
 and exists(select 1 from public.cigarette_profiles c where c.item_id=oi.item_id);

create table public.cigarette_days(
 outlet_id integer references public.outlets(id),business_date date,sales jsonb,
 closing jsonb,report jsonb,closed_at timestamptz,closed_by uuid references public.users(id),
 primary key(outlet_id,business_date));
create table public.cigarette_audit(
 id uuid primary key default gen_random_uuid(),outlet_id integer references public.outlets(id),
 business_date date not null,action text not null,actor_id uuid references public.users(id),
 payload jsonb not null,created_at timestamptz not null default now());
create index cigarette_audit_day on public.cigarette_audit(outlet_id,business_date,created_at desc);
create table public.cigarette_transfers(
 id uuid primary key default gen_random_uuid(),source_outlet integer not null references public.outlets(id),
 destination_outlet integer not null references public.outlets(id),item_id varchar not null references public.items(id),
 pieces integer not null check(pieces>0),dispatch_date date not null,received_date date,
 dispatched_by uuid references public.users(id),received_by uuid references public.users(id),
 dispatched_at timestamptz default now(),received_at timestamptz,
 check(source_outlet<>destination_outlet));
create index cigarette_transfer_source on public.cigarette_transfers(source_outlet,dispatch_date);
create index cigarette_transfer_destination on public.cigarette_transfers(destination_outlet,received_date);
create table public.cigarette_adjustments(
 id uuid primary key default gen_random_uuid(),outlet_id integer not null references public.outlets(id),
 business_date date not null,item_id varchar not null references public.items(id),
 pieces integer not null,reason text not null,approved_by uuid references public.users(id),created_at timestamptz default now());
create index cigarette_adjustments_day on public.cigarette_adjustments(outlet_id,business_date);

create or replace function private.has_module_access(p_module text)
returns boolean language sql stable security definer set search_path='' as $f$
 select coalesce((select case when u.access_class='ADMIN' then true
 when not private.has_photo_checkin(u.id) then false
 when p_module not in('orders','purchase','extra-time','delta','summary','cigarettes') then false
 when jsonb_typeof(u.permissions->'module_access'->p_module)='boolean' then (u.permissions->'module_access'->>p_module)::boolean
 else p_module in('orders','purchase','extra-time','cigarettes') or (p_module='summary' and u.role in('Manager','Ops Manager'))
 end from public.users u where u.auth_user_id=auth.uid() and u.active limit 1),false)
$f$;
create or replace function private.validate_module_permissions(p_permissions jsonb)
returns void language plpgsql immutable security invoker set search_path='' as $f$
begin
 if p_permissions is null then return;end if;
 if jsonb_typeof(p_permissions)<>'object' then raise exception 'Permissions must be an object';end if;
 if p_permissions ? 'module_access' then
 if jsonb_typeof(p_permissions->'module_access')<>'object' then raise exception 'Module access must be an object';end if;
 if exists(select 1 from jsonb_each(p_permissions->'module_access') e where e.key not in('orders','purchase','extra-time','delta','summary','cigarettes') or jsonb_typeof(e.value)<>'boolean') then
 raise exception 'Choose true or false for the supported access domains';end if;end if;
end $f$;

alter table public.cigarette_days enable row level security;
alter table public.cigarette_audit enable row level security;
alter table public.cigarette_transfers enable row level security;
alter table public.cigarette_adjustments enable row level security;
create policy cigarette_days_read on public.cigarette_days for select to authenticated using(private.has_module_access('cigarettes') and private.can_operate_outlet(outlet_id));
create policy cigarette_audit_read on public.cigarette_audit for select to authenticated using(private.has_module_access('cigarettes') and private.can_operate_outlet(outlet_id));
create policy cigarette_transfers_read on public.cigarette_transfers for select to authenticated using(private.has_module_access('cigarettes') and (private.can_operate_outlet(source_outlet) or private.can_operate_outlet(destination_outlet)));
create policy cigarette_adjustments_read on public.cigarette_adjustments for select to authenticated using(private.has_module_access('cigarettes') and private.can_operate_outlet(outlet_id));
revoke all on public.cigarette_days,public.cigarette_audit,public.cigarette_transfers,public.cigarette_adjustments from anon,authenticated;
grant select on public.cigarette_days,public.cigarette_audit,public.cigarette_transfers,public.cigarette_adjustments to authenticated;

-- Privileged operations live in private; public wrapper uses the caller's identity.
create or replace function private.cigarette_workspace(p_outlet_id integer,p_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare v_rows jsonb;v_day public.cigarette_days;
begin
 perform private.require_module_access('cigarettes');
 if auth.uid() is null or not private.can_operate_outlet(p_outlet_id) then raise exception 'Outlet access denied' using errcode='42501';end if;
 select * into v_day from public.cigarette_days where outlet_id=p_outlet_id and business_date=p_date;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.vendor_name,r.item_name),'[]') into v_rows from (
 select i.id item_id,i.name item_name,c.pieces_per_pack,coalesce(oi.cigarette_pos_price,c.pos_price) pos_price,
 coalesce(oi.preferred_vendor_id,i.vendor_id) vendor_id,v.name vendor_name,
 coalesce(oi.target_stock,i.reorder_qty,0) target_stock,
 prev.last_count opening,prev.last_count_date opening_date,
 cur.last_count last_count,cur.last_count_date last_count_date,
 coalesce((select sum(case when lower(p.unit)='pack' then p.qty*c.pieces_per_pack when lower(p.unit) in('pc','piece','pieces') then p.qty else p.base_qty end)
 from public.purchases p where p.outlet_id=p_outlet_id and p.item_id=i.id and p.business_date=p_date and p.entry_type='item'),0) purchased,
 (select case when lower(p.unit)='pack' then p.invoice_amount/(p.qty*c.pieces_per_pack) when lower(p.unit) in('pc','piece','pieces') then p.invoice_amount/p.qty else p.invoice_amount/nullif(p.base_qty,0) end
 from public.purchases p where p.outlet_id=p_outlet_id and p.item_id=i.id and p.entry_type='item' and p.qty>0 and p.invoice_amount>0 and p.business_date<=p_date order by p.business_date desc,p.created_at desc,p.id desc limit 1) cost_per_piece,
 coalesce((select sum(t.pieces) from public.cigarette_transfers t where t.destination_outlet=p_outlet_id and t.item_id=i.id and t.received_date=p_date),0) transfer_in,
 coalesce((select sum(t.pieces) from public.cigarette_transfers t where t.source_outlet=p_outlet_id and t.item_id=i.id and t.dispatch_date=p_date),0) transfer_out,
 coalesce((select sum(a.pieces) from public.cigarette_adjustments a where a.outlet_id=p_outlet_id and a.item_id=i.id and a.business_date=p_date),0) adjustment
 from public.outlet_items oi join public.items i on i.id=oi.item_id join public.cigarette_profiles c on c.item_id=i.id
 join public.vendors v on v.id=coalesce(oi.preferred_vendor_id,i.vendor_id)
 left join public.get_tonights_stock(p_outlet_id::bigint,p_date-1) prev on prev.item_id=i.id
 left join public.get_tonights_stock(p_outlet_id::bigint,p_date) cur on cur.item_id=i.id
 where oi.outlet_id=p_outlet_id and oi.active and i.active and c.active
 )r;
 return jsonb_build_object('items',v_rows,'day',case when v_day.outlet_id is null then null else to_jsonb(v_day) end,
 'vendors',(select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'name',v.name) order by v.name),'[]') from public.vendors v where
 (lower(v.name)='kini' and exists(select 1 from public.outlets where id=p_outlet_id and lower(name)='teapot')) or
 (lower(v.name) in('itc','advance') and exists(select 1 from public.outlets where id=p_outlet_id and lower(regexp_replace(name,'[^a-zA-Z]','','g'))='chaicafe'))),
 'purchases',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from (select p.id,p.vendor_name,p.qty,p.unit,p.invoice_amount,i.name item_name from public.purchases p join public.items i on i.id=p.item_id join public.cigarette_profiles c on c.item_id=i.id where p.outlet_id=p_outlet_id and p.business_date=p_date order by p.created_at desc limit 100)r),
 'history',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from (select business_date,closed_at,report from public.cigarette_days where outlet_id=p_outlet_id and business_date<=p_date and closed_at is not null order by business_date desc limit 30)r),
 'audit',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from (select a.action,a.payload,a.created_at,u.name actor_name from public.cigarette_audit a left join public.users u on u.id=a.actor_id where a.outlet_id=p_outlet_id and a.business_date=p_date order by a.created_at desc limit 30)r),
 'transfers',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from (select t.*,i.name item_name,o.name source_name,d.name destination_name from public.cigarette_transfers t join public.items i on i.id=t.item_id join public.outlets o on o.id=t.source_outlet join public.outlets d on d.id=t.destination_outlet where (source_outlet=p_outlet_id or destination_outlet=p_outlet_id) and (received_at is null or received_date=p_date or dispatch_date=p_date) order by dispatched_at desc limit 100)r),
 'outlets',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name)),'[]') from public.outlets where lower(regexp_replace(name,'[^a-zA-Z]','','g')) in('teapot','chaicafe')));
end $f$;

create or replace function private.cigarette_action(p_outlet_id integer,p_date date,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $f$
declare a uuid:=private.actor_id();v public.cigarette_days;w jsonb;entries jsonb;e jsonb;r jsonb;report jsonb;
 item public.items;prof public.cigarette_profiles;vendor public.vendors;dest integer;n numeric;price numeric;qty numeric;
 tid uuid;loc bigint;take_id bigint;previous jsonb;requested uuid;cat integer;v_brand_name text;pack integer;
begin
 perform private.require_module_access('cigarettes');
 if auth.uid() is null or a is null or not private.can_operate_outlet(p_outlet_id) then raise exception 'Outlet access denied' using errcode='42501';end if;
 if p_date is null or p_date>public.get_effective_business_day(p_outlet_id,now()) then raise exception 'Invalid business date';end if;
 perform pg_advisory_xact_lock(hashtextextended('cigarettes:'||p_outlet_id||':'||p_date,0));
 select * into v from public.cigarette_days where outlet_id=p_outlet_id and business_date=p_date;
 if p_action='reopen' then
 if not private.is_admin() or length(trim(coalesce(p_payload->>'reason','')))<3 then raise exception 'Owner access and correction reason required';end if;
 if exists(select 1 from public.cigarette_days where outlet_id=p_outlet_id and business_date>p_date and closed_at is not null) then raise exception 'Later days are closed; reopen them first, newest first';end if;
 previous:=to_jsonb(v);update public.cigarette_days set closed_at=null,closed_by=null where outlet_id=p_outlet_id and business_date=p_date;
 elsif p_action='settings' then
 if not private.is_admin() then raise exception 'Owner access required';end if;
 select * into prof from public.cigarette_profiles where item_id=p_payload->>'item_id';if not found then raise exception 'Brand not found';end if;
 price:=(p_payload->>'pos_price')::numeric;
 if price is null or price<=0 or price>10000 then raise exception 'Enter SK price';end if;
 previous:=to_jsonb(prof);update public.outlet_items set cigarette_pos_price=price where outlet_id=p_outlet_id and item_id=prof.item_id;
 else
 if v.closed_at is not null and p_action<>'order' then raise exception 'Day is closed. Owner must reopen it before corrections';end if;
 -- Past movements cannot invalidate a later confirmed opening balance.
 if p_action<>'order' and exists(select 1 from public.cigarette_days where outlet_id=p_outlet_id and business_date>p_date and closed_at is not null) then raise exception 'A later day is closed; owner must reopen later days before changing this day';end if;
 w:=private.cigarette_workspace(p_outlet_id,p_date);
 if p_action='sales' then
 entries:=p_payload->'entries';
 if entries is null or jsonb_typeof(entries)<>'array' or jsonb_array_length(entries)=0 then raise exception 'Enter POS sales for each SK group';end if;
 if (select count(*) from jsonb_array_elements(entries))<>(select count(distinct (value->>'price')::numeric) from jsonb_array_elements(entries)) then raise exception 'Duplicate SK group';end if;
 for e in select value from jsonb_array_elements(entries) loop
 price:=(e->>'price')::numeric;qty:=(e->>'pieces')::numeric;n:=(e->>'amount')::numeric;
 if price is null or price<=0 or price>10000 or qty is null or qty<0 or qty<>trunc(qty) or qty>1000000 or n is null or n<0 or n>1000000000 then raise exception 'Invalid POS sale';end if;
 end loop;
 if exists(select 1 from (select distinct (value->>'pos_price')::numeric price from jsonb_array_elements(w->'items') where value->>'pos_price' is not null union select unnest(array[10,15,20,25,28,30]::numeric[])) g where not exists(select 1 from jsonb_array_elements(entries)z where (z->>'price')::numeric=g.price)) then raise exception 'Record every SK group; enter zero if none sold';end if;
 previous:=v.sales;insert into public.cigarette_days(outlet_id,business_date,sales) values(p_outlet_id,p_date,entries) on conflict(outlet_id,business_date) do update set sales=excluded.sales;
 elsif p_action='purchase' or p_action='order' then
 select * into vendor from public.vendors where id=(p_payload->>'vendor_id')::integer;
 if not found or not exists(select 1 from jsonb_array_elements(w->'vendors')x where (x->>'id')::integer=vendor.id) then raise exception 'Wrong cigarette vendor for this café';end if;
 entries:=p_payload->'entries';requested:=(p_payload->>'request_id')::uuid;
 if requested is null then raise exception 'Request identifier required';end if;
 if exists(select 1 from public.cigarette_audit where id=requested and (outlet_id<>p_outlet_id or action<>p_action or payload->'input'<>p_payload)) then raise exception 'Request identifier reused with different data';end if;
 if exists(select 1 from public.cigarette_audit where id=requested and outlet_id=p_outlet_id and action=p_action) then return jsonb_build_object('saved',true,'duplicate',true);end if;
 if entries is null or jsonb_typeof(entries)<>'array' or jsonb_array_length(entries) not between 1 and 100 then raise exception 'Choose brands and enter packs';end if;
 if (select count(*) from jsonb_array_elements(entries))<>(select count(distinct value->>'item_id') from jsonb_array_elements(entries)) then raise exception 'Duplicate brand';end if;
 for e in select value from jsonb_array_elements(entries) loop
 qty:=(e->>'packs')::numeric;n:=(e->>'amount')::numeric;
 if qty is null or qty<=0 or qty<>trunc(qty) or qty>1000000 or (p_action='purchase' and (n is null or n<=0 or n>1000000000)) then raise exception 'Enter whole packs and purchase amount';end if;
 if not exists(select 1 from jsonb_array_elements(w->'items')x where x->>'item_id'=e->>'item_id' and (x->>'vendor_id')::integer=vendor.id) then raise exception 'Brand does not belong to this vendor';end if;
 if p_action='purchase' then
 price:=(e->>'pos_price')::numeric;
 if price is null or price<=0 or price>10000 then raise exception 'Set the SK category for every purchased brand';end if;
 update public.outlet_items set cigarette_pos_price=price where outlet_id=p_outlet_id and item_id=e->>'item_id';
 select * into prof from public.cigarette_profiles where item_id=e->>'item_id';
 insert into public.purchases(id,business_date,outlet_id,user_id,vendor_id,vendor_name,item_id,qty,unit,purchase_unit,base_qty,invoice_amount,entry_type,receipt_status)
 values('PUR-'||gen_random_uuid(),p_date,p_outlet_id,a,vendor.id,vendor.name,e->>'item_id',qty,'Pack','Pack',qty*prof.pieces_per_pack,n,'item','RECEIVED');
 end if;end loop;
 elsif p_action='close' then
 if v.sales is null then raise exception 'Save POS sales before closing stock';end if;
 entries:=p_payload->'entries';
 if entries is null or jsonb_typeof(entries)<>'array' or jsonb_array_length(entries)<>jsonb_array_length(w->'items') or jsonb_array_length(entries)=0 then raise exception 'Count every cigarette brand';end if;
 if (select count(*) from jsonb_array_elements(entries))<>(select count(distinct value->>'item_id') from jsonb_array_elements(entries)) then raise exception 'Duplicate brand';end if;
 for e in select value from jsonb_array_elements(entries) loop
 qty:=(e->>'pieces')::numeric;
 if qty is null or qty<0 or qty<>trunc(qty) or qty>10000000 or not exists(select 1 from jsonb_array_elements(w->'items') x where x->>'item_id'=e->>'item_id') then raise exception 'Invalid brand count';end if;end loop;
 -- Freeze mappings and inputs with the close. No brand-wise sales are invented.
 select jsonb_build_object('brands',coalesce(jsonb_agg(x),'[]'),'sales',v.sales) into report from (
 select row||jsonb_build_object('closing',(select (z->>'pieces')::numeric from jsonb_array_elements(entries)z where z->>'item_id'=row->>'item_id')) x from jsonb_array_elements(w->'items')row)t;
 previous:=to_jsonb(v);
 insert into public.cigarette_days(outlet_id,business_date,closing,report,closed_at,closed_by) values(p_outlet_id,p_date,entries,report,now(),a)
 on conflict(outlet_id,business_date) do update set closing=excluded.closing,report=excluded.report,closed_at=excluded.closed_at,closed_by=excluded.closed_by;
 select id into loc from public.stock_locations where outlet_id=p_outlet_id and is_default limit 1;
 insert into public.stocktakes(outlet_id,location_id,business_date,stocktake_type,status,started_by,submitted_by,submitted_at)
 values(p_outlet_id,loc,p_date,'CONTROLLED','SUBMITTED',a,a,now()) returning id into take_id;
 for e in select value from jsonb_array_elements(entries) loop
 insert into public.stocktake_lines(stocktake_id,item_id,counted_quantity_base,display_quantity,display_unit,note) values(take_id,e->>'item_id',(e->>'pieces')::numeric,(e->>'pieces')::numeric,'Pc','Cigarettes daily close');end loop;
 elsif p_action='adjust' then
 if not private.is_admin() and not private.is_manager() then raise exception 'Manager or owner approval required';end if;
 qty:=(p_payload->>'pieces')::numeric;
 if qty is null or qty=0 or qty<>trunc(qty) or abs(qty)>1000000 or length(trim(coalesce(p_payload->>'reason','')))<3 then raise exception 'Enter signed pieces and reason';end if;
 if not exists(select 1 from jsonb_array_elements(w->'items') x where x->>'item_id'=p_payload->>'item_id') then raise exception 'Brand not found';end if;
 insert into public.cigarette_adjustments(outlet_id,business_date,item_id,pieces,reason,approved_by) values(p_outlet_id,p_date,p_payload->>'item_id',qty,p_payload->>'reason',a);
 elsif p_action='dispatch' then
 dest:=(p_payload->>'destination')::integer;qty:=(p_payload->>'pieces')::numeric;
 if dest is null or dest=p_outlet_id or qty is null or qty<=0 or qty<>trunc(qty) or qty>1000000 or not exists(select 1 from jsonb_array_elements(w->'outlets')x where (x->>'id')::integer=dest) then raise exception 'Check destination and pieces';end if;
 if not exists(select 1 from jsonb_array_elements(w->'items') x where x->>'item_id'=p_payload->>'item_id') or not exists(select 1 from public.outlet_items oi where outlet_id=dest and item_id=p_payload->>'item_id' and active) then raise exception 'Brand unavailable at destination';end if;
 insert into public.cigarette_transfers(source_outlet,destination_outlet,item_id,pieces,dispatch_date,dispatched_by) values(p_outlet_id,dest,p_payload->>'item_id',qty,p_date,a) returning id into tid;
 p_payload:=p_payload||jsonb_build_object('transfer_id',tid);
 elsif p_action='receive' then
 tid:=(p_payload->>'transfer_id')::uuid;
 perform 1 from public.cigarette_transfers where id=tid and destination_outlet=p_outlet_id and dispatch_date<=p_date and received_at is null for update;
 if not found then raise exception 'Transfer already received or unavailable';end if;
 update public.cigarette_transfers set received_date=p_date,received_at=now(),received_by=a where id=tid;
 elsif p_action='add' then
 v_brand_name:=regexp_replace(trim(p_payload->>'name'),'\s+',' ','g');pack:=(p_payload->>'pack')::integer;
 select * into vendor from public.vendors where id=(p_payload->>'vendor_id')::integer;
 if v_brand_name is null or length(v_brand_name) not between 1 and 150 or pack is null or pack not between 1 and 100 or not exists(select 1 from jsonb_array_elements(w->'vendors')x where (x->>'id')::integer=vendor.id) then raise exception 'Enter brand, pack size and permitted vendor';end if;
 perform pg_advisory_xact_lock(hashtextextended('cigarette-brand:'||lower(v_brand_name),0));
 select i.* into item from public.items i join public.cigarette_profiles c on c.item_id=i.id where lower(regexp_replace(trim(i.name),'\s+',' ','g'))=lower(v_brand_name) limit 1;
 if found then
 select * into prof from public.cigarette_profiles where item_id=item.id;
 if not item.active or not prof.active or prof.pieces_per_pack<>pack then raise exception 'Existing brand is inactive or has a different pack size';end if;
 else
 select i.category_id into cat from public.items i join public.cigarette_profiles c on c.item_id=i.id limit 1;
 if cat is null then raise exception 'Cigarette category missing';end if;
 insert into public.items(id,name,category_id,vendor_id,unit,pack_size) values('CIG-'||gen_random_uuid(),v_brand_name,cat,vendor.id,'Pc',pack::text) returning * into item;
 insert into public.cigarette_profiles(item_id,pieces_per_pack,active) values(item.id,pack,true);
 end if;
 insert into public.outlet_items(outlet_id,item_id,active,stock_unit,count_cycle,order_strategy,preferred_vendor_id) values(p_outlet_id,item.id,true,'Pc','CONTROLLED','CONTROLLED',vendor.id) on conflict(outlet_id,item_id) do nothing;
 if not exists(select 1 from public.outlet_items where outlet_id=p_outlet_id and item_id=item.id and active and preferred_vendor_id=vendor.id) then raise exception 'Brand already assigned to another vendor at this café';end if;
 else raise exception 'Unknown cigarette action';end if;
 end if;
 insert into public.cigarette_audit(id,outlet_id,business_date,action,actor_id,payload)
 values(coalesce(requested,gen_random_uuid()),p_outlet_id,p_date,p_action,a,jsonb_build_object('input',p_payload,'previous',previous));
 return jsonb_build_object('saved',true);
end $f$;

create or replace function public.get_cigarette_workspace(p_outlet_id integer,p_date date)
returns jsonb language sql stable security invoker set search_path='' as $f$ select private.cigarette_workspace(p_outlet_id,p_date) $f$;
create or replace function public.save_cigarette_action(p_outlet_id integer,p_date date,p_action text,p_payload jsonb)
returns jsonb language sql security invoker set search_path='' as $f$ select private.cigarette_action(p_outlet_id,p_date,p_action,p_payload) $f$;
revoke all on function private.cigarette_workspace(integer,date),private.cigarette_action(integer,date,text,jsonb),public.get_cigarette_workspace(integer,date),public.save_cigarette_action(integer,date,text,jsonb) from public,anon;
grant execute on function private.cigarette_workspace(integer,date),private.cigarette_action(integer,date,text,jsonb),public.get_cigarette_workspace(integer,date),public.save_cigarette_action(integer,date,text,jsonb) to authenticated;

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
    'vendors',(select coalesce(jsonb_agg(to_jsonb(v) order by v.name),'[]') from (select id,name from public.vendors where lower(trim(name)) not in('itc','advance') and purchase_enabled and private.purchase_name_allowed(name,'Whole Chicken'))v),
    'cigarette_item_ids',(select coalesce(jsonb_agg(item_id),'[]') from public.cigarette_profiles),
    'categories',(select coalesce(jsonb_agg(to_jsonb(c) order by c.name),'[]') from (select id,name from public.categories where id not in(select i.category_id from public.items i join public.cigarette_profiles c on c.item_id=i.id))c),
    'items',(select coalesce(jsonb_agg(to_jsonb(x) order by x.vendor_name,x.category_name,x.item_name),'[]') from (
      select i.id item_id,i.name item_name,i.category_id,c.name category_name,coalesce(oi.preferred_vendor_id,i.vendor_id) vendor_id,v.name vendor_name,
        i.unit,coalesce(oi.stock_unit,i.unit) order_unit,oi.order_strategy,
        case when p_module='purchase' then (select p.invoice_amount/p.qty from public.purchases p where p.outlet_id=p_outlet_id and p.item_id=i.id and p.entry_type='item' and p.qty>0 and p.invoice_amount>0 and lower(p.unit)=lower(i.unit) order by p.business_date desc,p.created_at desc,p.id desc limit 1) end last_price
      from public.outlet_items oi join public.items i on i.id=oi.item_id left join public.categories c on c.id=i.category_id
        left join public.vendors v on v.id=coalesce(oi.preferred_vendor_id,i.vendor_id)
      where not exists(select 1 from public.cigarette_profiles cp where cp.item_id=i.id) and oi.outlet_id=p_outlet_id and oi.active and i.active and i.purchase_enabled and v.purchase_enabled and private.purchase_name_allowed(v.name,i.name)
    ) x));
end $function$;

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
  if p_category_id in(select i.category_id from public.items i join public.cigarette_profiles c on c.item_id=i.id) or lower(trim(coalesce(p_category_name,'')))='cigarettes' or exists(select 1 from public.vendors where id=p_vendor_id and lower(name) in('itc','advance')) then raise exception 'Use the Cigarettes module to add brands';end if;
  if not private.can_operate_outlet(p_outlet_id) then raise exception 'Outlet access denied' using errcode='42501';end if;
  if not exists(select 1 from public.outlets where id=p_outlet_id) then raise exception 'Café not found';end if;
  select name into v_vendor from public.vendors where id=p_vendor_id and purchase_enabled;if not found then raise exception 'Vendor not found';end if;
  if v_name is null or length(v_name) not between 1 and 150 or v_unit is null or length(v_unit) not between 1 and 30 then raise exception 'Enter an item name and unit';end if;
  if not private.purchase_name_allowed(v_vendor,v_name) then raise exception 'Use Transfers for prepared items. Provit supplies whole chicken, shawarma, wings and skin only.';end if;
  -- Serialize normalized names across cafés so simultaneous additions reuse one item.
  perform pg_advisory_xact_lock(hashtextextended('vendor-catalogue:'||p_vendor_id||':'||lower(v_name),0));
  select * into v_item from public.items i where i.vendor_id=p_vendor_id and lower(regexp_replace(trim(i.name),'\s+',' ','g'))=lower(v_name) order by i.active desc,i.created_at,i.id limit 1;
  if found then
    if exists(select 1 from public.cigarette_profiles c where c.item_id=v_item.id) then raise exception 'Use the Cigarettes module';end if;    if not coalesce(v_item.active,false) or not v_item.purchase_enabled then raise exception 'This item is inactive. Ask a manager to review it.';end if;
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

CREATE OR REPLACE FUNCTION public.save_tonights_stocktake(p_outlet_id bigint, p_business_date date, p_user_id uuid, p_entries jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_location bigint; v_take bigint; e jsonb;
begin
 if not private.can_operate_outlet(p_outlet_id::integer) or p_user_id is distinct from private.actor_id() then
   raise exception 'Not authorized for this café';
 end if;
 if exists(select 1 from jsonb_array_elements(p_entries) z join public.cigarette_profiles c on c.item_id=z->>'item_id') then raise exception 'Use the Cigarettes module for cigarette stock';end if;
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
CREATE OR REPLACE FUNCTION public.save_monthly_stocktake(p_outlet_id bigint, p_business_date date, p_user_id uuid, p_entries jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_location bigint;v_take bigint;e jsonb;
begin
 if not private.can_operate_outlet(p_outlet_id::integer) or p_user_id is distinct from private.actor_id() then
   raise exception 'Not authorized for this café';
 end if;
 if exists(select 1 from jsonb_array_elements(p_entries) z join public.cigarette_profiles c on c.item_id=z->>'item_id') then raise exception 'Use the Cigarettes module for cigarette stock';end if;
 select id into v_location from public.stock_locations where outlet_id=p_outlet_id and is_default=true limit 1;
 insert into public.stocktakes(outlet_id,location_id,business_date,stocktake_type,status,started_by,submitted_by,submitted_at)
 values(p_outlet_id,v_location,p_business_date,'MONTHLY','SUBMITTED',p_user_id,p_user_id,now()) returning id into v_take;
 for e in select * from jsonb_array_elements(p_entries) loop
  insert into public.stocktake_lines(stocktake_id,item_id,counted_quantity_base,display_quantity,display_unit,note)
  values(v_take,e->>'item_id',(e->>'count_now')::numeric,(e->>'count_now')::numeric,e->>'unit',null);
 end loop;
 return v_take;
end $function$;

create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $f$ select jsonb_build_object('schema_build',145) $f$;

create or replace function private.cigarette_summary(p_outlet_id integer,p_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $f$
begin
 if auth.uid() is null or not private.can_operate_outlet(p_outlet_id) or not (private.has_module_access('summary') or private.has_module_access('cigarettes')) then raise exception 'Outlet access denied' using errcode='42501';end if;
 return (select jsonb_build_object('sales',d.sales,'closed',d.closed_at is not null) from public.cigarette_days d where d.outlet_id=p_outlet_id and d.business_date=p_date);
end $f$;
create or replace function public.get_cigarette_summary(p_outlet_id integer,p_date date)
returns jsonb language sql stable security invoker set search_path='' as $f$ select private.cigarette_summary(p_outlet_id,p_date) $f$;
revoke all on function private.cigarette_summary(integer,date),public.get_cigarette_summary(integer,date) from public,anon;
grant execute on function private.cigarette_summary(integer,date),public.get_cigarette_summary(integer,date) to authenticated;


create or replace function private.cigarette_item_ids(p_outlet_id integer)
returns jsonb language plpgsql stable security definer set search_path='' as $f$
begin
 if auth.uid() is null or not private.can_operate_outlet(p_outlet_id) or not(private.has_module_access('delta') or private.has_module_access('cigarettes') or private.has_module_access('purchase') or private.has_module_access('orders')) then raise exception 'Outlet access denied' using errcode='42501';end if;
 return (select coalesce(jsonb_agg(item_id),'[]') from public.cigarette_profiles);
end $f$;
create or replace function public.get_cigarette_item_ids(p_outlet_id integer)
returns jsonb language sql stable security invoker set search_path='' as $f$ select private.cigarette_item_ids(p_outlet_id) $f$;
revoke all on function private.cigarette_item_ids(integer),public.get_cigarette_item_ids(integer) from public,anon;
grant execute on function private.cigarette_item_ids(integer),public.get_cigarette_item_ids(integer) to authenticated;

notify pgrst,'reload schema';
