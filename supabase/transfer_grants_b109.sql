-- Preserve invoker transfer RPCs after restricting direct reads of users.
create or replace function public.dispatch_transfer(p_outlet_id integer, p_prepared_by uuid,
  p_lines jsonb, p_prep_qty numeric default null, p_rate numeric default null)
returns integer language plpgsql security definer set search_path = '' as $function$
declare v_actor_id uuid; v_actor_outlet integer; v_actor_access text;
  v_request public.extra_time_requests; v_line jsonb;
  v_first_dispatch bigint; v_dispatch_id bigint; v_count integer := 0; v_category text; v_group uuid;
  v_staff_id uuid; v_qty numeric;
begin
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

create or replace function public.receive_transfer(p_outlet_id integer,p_lines jsonb,p_note text default null)
returns integer language plpgsql security definer set search_path = '' as $function$
declare v_actor_id uuid; v_actor_outlet integer; v_actor_access text;
  v_request public.extra_time_requests; v_dispatch public.extra_time_dispatches;
  v_line jsonb; v_qty numeric; v_count integer:=0;
begin
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
