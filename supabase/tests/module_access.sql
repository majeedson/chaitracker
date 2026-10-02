-- Integration probe. Every permission and business-record change rolls back.
do $probe$
declare
 v_user public.users;v_admin public.users;v_staff public.staff;v_message text;v_other integer;
 v_delta_count bigint;v_purchase_count bigint;v_count bigint;v_summary public.daily_summaries;
 v_id text:='ACCESS-PROBE-'||gen_random_uuid()::text;
begin
 select u.* into v_user from public.users u join public.staff s on s.id=u.staff_id
  where u.active and u.auth_user_id is not null and u.role='Staff' and s.active order by u.id limit 1;
 select * into v_admin from public.users where active and auth_user_id is not null and role='Owner' limit 1;
 select * into v_staff from public.staff where id=v_user.staff_id;
 select id into v_other from public.outlets where id<>v_user.outlet_id limit 1;
 if v_user.id is null or v_admin.id is null then raise exception 'Active staff/admin fixtures required';end if;
 select count(*) into v_delta_count from public.inventory_entries where outlet_id=v_user.outlet_id;
 select count(*) into v_purchase_count from public.purchases where outlet_id=v_user.outlet_id;
 begin
  update public.users set permissions='{}',role='Staff' where id=v_user.id;
  perform set_config('request.jwt.claim.sub',v_user.auth_user_id::text,true);
  if not private.has_module_access('orders') or not private.has_module_access('purchase')
    or not private.has_module_access('extra-time') or private.has_module_access('summary') or private.has_module_access('delta') then
   raise exception 'Staff defaults changed';end if;
  update public.users set role='Manager' where id=v_user.id;
  if not private.has_module_access('summary') or private.has_module_access('delta') then raise exception 'Manager defaults changed';end if;
  perform set_config('request.jwt.claim.sub',v_admin.auth_user_id::text,true);
  perform public.owner_update_staff(v_staff.id,v_staff.name,v_staff.outlet_id,'Staff',v_staff.basic_salary,v_staff.joining_date,true,
   '{"module_access":{"orders":false,"purchase":false,"extra-time":false,"summary":false,"delta":false}}',v_staff.notes);
  perform set_config('request.jwt.claim.sub',v_user.auth_user_id::text,true);
  execute 'set local role authenticated';
  select count(*) into v_count from public.inventory_entries;if v_count<>0 then raise exception 'Revoked Delta leaked rows';end if;
  select count(*) into v_count from public.purchases;if v_count<>0 then raise exception 'Revoked Purchases leaked rows';end if;
  select count(*) into v_count from public.daily_summaries;if v_count<>0 then raise exception 'Revoked Summary leaked rows';end if;
  perform public.get_stock_purchase_quantities(v_user.outlet_id,current_date);
  -- Salary joins must remain readable without leaking another preparer's earnings.
  if exists(select 1 from public.extra_time_payments where staff_user_id<>v_user.id) then raise exception 'Revoked Transfers leaked earnings';end if;
  perform 1 from public.extra_time_dispatches;
  perform 1 from public.extra_time_requests;
  select count(*) into v_count from public.get_tomorrows_order(v_user.outlet_id,current_date);
  if v_count<>0 then raise exception 'Revoked Orders leaked suggestions';end if;
  begin
   perform public.save_purchase_entries(v_user.outlet_id,current_date,v_user.id,'','[]');
   raise exception 'Revoked purchase write allowed';
  exception when insufficient_privilege then null;end;
  begin
   perform public.dispatch_transfer(v_user.outlet_id,v_user.id,'[]');raise exception 'Revoked dispatch allowed';
  exception when insufficient_privilege then null;end;
  begin
   perform public.receive_transfer(v_user.outlet_id,'[]');raise exception 'Revoked receipt allowed';
  exception when insufficient_privilege then null;end;
  begin
   perform public.close_daily_summary(v_id,v_user.id);raise exception 'Revoked summary close allowed';
  exception when insufficient_privilege then null;end;
  -- Role-only salary and attendance RPCs remain available.
  perform public.get_salary_estimate(v_user.staff_id,current_date,current_date);
  perform public.get_attendance_calendar(v_user.outlet_id,v_user.staff_id,current_date,current_date);
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',v_admin.auth_user_id::text,true);
  perform public.owner_update_staff(v_staff.id,v_staff.name,v_staff.outlet_id,'Staff',v_staff.basic_salary,v_staff.joining_date,true,
   '{"module_access":{"orders":true,"purchase":true,"extra-time":true,"summary":true,"delta":true}}',v_staff.notes);
  perform set_config('request.jwt.claim.sub',v_user.auth_user_id::text,true);
  execute 'set local role authenticated';
  select count(*) into v_count from public.inventory_entries;
  if v_count<>v_delta_count then raise exception 'Delta grant escaped café scope or failed';end if;
  select count(*) into v_count from public.purchases;
  if v_count<>v_purchase_count then raise exception 'Purchase grant escaped café scope or failed';end if;
  v_summary:=public.save_daily_summary(v_id,v_user.outlet_id,current_date+500,v_user.id,v_user.name,'Staff');
  if v_summary.outlet_id<>v_user.outlet_id then raise exception 'Summary grant failed';end if;
  if not exists(select 1 from public.daily_summaries where id=v_id) then raise exception 'Saved Summary not visible';end if;
  if v_other is not null then
   begin
    perform public.save_daily_summary(v_id||'-other',v_other,current_date+500,v_user.id,v_user.name,'Staff');
    raise exception 'Cross-café summary grant allowed';
   exception when raise_exception then
    get stacked diagnostics v_message=message_text;
    if v_message<>'You cannot save another outlet summary' then raise;end if;
   end;
  end if;
  begin
   perform public.owner_update_staff(v_staff.id,v_staff.name,v_staff.outlet_id,'Staff',v_staff.basic_salary,v_staff.joining_date,true,'{}',v_staff.notes);
   raise exception 'Staff could manage access';
  exception when raise_exception then
   get stacked diagnostics v_message=message_text;
   if v_message<>'Owner access required.' then raise;end if;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',v_admin.auth_user_id::text,true);
  begin
   perform public.owner_update_staff(v_staff.id,v_staff.name,v_staff.outlet_id,'Staff',v_staff.basic_salary,v_staff.joining_date,true,'{"module_access":{"salary":false}}',v_staff.notes);
   raise exception 'Unexpected access domain accepted';
  exception when raise_exception then
   get stacked diagnostics v_message=message_text;
   if v_message<>'Choose true or false for the five supported access domains' then raise;end if;
  end;
  raise exception 'rollback_access_probe';
 exception when raise_exception then
  get stacked diagnostics v_message=message_text;
  if v_message<>'rollback_access_probe' then raise;end if;
 end;
end $probe$;
