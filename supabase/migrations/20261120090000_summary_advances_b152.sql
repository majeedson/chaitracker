-- B152: staff advances recorded from the Daily Summary, past-day summary editing, and a save audit trail.
-- * Managers record cash/UPI advances handed over at the counter straight from the summary. They are stored as
--   PAID rows in staff_advance_requests, so expected cash (private.expected_cash) and payroll (private.advance_due)
--   pick them up with no further changes. Self-recorded advances are allowed and flagged for the owner.
-- * Summary saves and summary advances accept any business day up to today. Managers are limited to the last
--   7 business days; the owner (ADMIN) can edit any day. Future days are refused.
-- * Every save writes a SAVED row (with row counts and cash figures) to daily_summary_audit.

-- 1. Advance rows: origin, self-recorded flag and voiding.
alter table public.staff_advance_requests
  add column if not exists source text not null default 'REQUEST',
  add column if not exists self_recorded boolean not null default false,
  add column if not exists voided_by uuid references public.users(id),
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text;
alter table public.staff_advance_requests drop constraint if exists staff_advance_requests_source_check;
alter table public.staff_advance_requests add constraint staff_advance_requests_source_check check (source in ('REQUEST','SUMMARY'));
alter table public.staff_advance_requests drop constraint if exists staff_advance_requests_status_check;
alter table public.staff_advance_requests add constraint staff_advance_requests_status_check
  check (status in ('REQUESTED','APPROVED','REJECTED','PAID','VOID'));
alter table public.staff_advance_requests drop constraint if exists advance_paid_fields;
alter table public.staff_advance_requests add constraint advance_paid_fields check (
  (status in ('PAID','VOID') and paid_by is not null and paid_at is not null and business_date is not null and mode is not null and first_period is not null)
  or (status not in ('PAID','VOID') and paid_by is null and paid_at is null and business_date is null and mode is null and first_period is null));
alter table public.staff_advance_requests drop constraint if exists advance_void_fields;
alter table public.staff_advance_requests add constraint advance_void_fields check (
  (status='VOID' and voided_by is not null and voided_at is not null) or (status<>'VOID' and voided_by is null and voided_at is null));

-- 2. Summary audit: record saves too.
alter table public.daily_summary_audit add column if not exists details jsonb;
alter table public.daily_summary_audit drop constraint if exists daily_summary_audit_action_check;
alter table public.daily_summary_audit add constraint daily_summary_audit_action_check check (action in ('CLOSED','REOPENED','SAVED'));

-- 3. Which business days a summary user may write to.
create or replace function private.assert_summary_date(p_outlet_id integer,p_business_date date,p_admin boolean)
returns void language plpgsql stable set search_path='' as $function$
declare v_today date;
begin
 if p_business_date is null then raise exception 'Business date is required';end if;
 v_today:=public.get_effective_business_day(p_outlet_id,now());
 if p_business_date>v_today then raise exception 'Cannot use a future business day';end if;
 if not coalesce(p_admin,false) and p_business_date<v_today-7 then
   raise exception 'Managers can edit the last 7 days only. Ask the owner to change older days.';end if;
end $function$;
revoke all on function private.assert_summary_date(integer,date,boolean) from public,anon,authenticated;

-- 4. Save: past-day guard and audit row. Body otherwise unchanged from B128.
CREATE OR REPLACE FUNCTION public.save_daily_summary(p_summary_id character varying, p_outlet_id integer, p_business_date date, p_user_id uuid, p_user_name character varying, p_role character varying, p_cash_sale numeric DEFAULT 0, p_upi_sale numeric DEFAULT 0, p_swiggy_gross numeric DEFAULT 0, p_swiggy_payout numeric DEFAULT 0, p_zomato_gross numeric DEFAULT 0, p_zomato_payout numeric DEFAULT 0, p_own_digital numeric DEFAULT 0, p_discount numeric DEFAULT 0, p_opening_cash_system numeric DEFAULT 0, p_opening_cash_actual numeric DEFAULT 0, p_physical_cash numeric DEFAULT 0, p_expenses jsonb DEFAULT '[]'::jsonb, p_vendor_payouts jsonb DEFAULT '[]'::jsonb, p_staff_payouts jsonb DEFAULT '[]'::jsonb)
 RETURNS daily_summaries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_summary public.daily_summaries;v_net numeric;v_expected numeric;v_actor public.users;v_admin boolean;v_old_advances jsonb;v_new_advances jsonb;v_existed boolean;
begin
 perform private.require_module_access('summary');
 select * into v_actor from public.users where id=p_user_id and active=true and auth_user_id=auth.uid();
 if not found then raise exception 'Authenticated CafeTracker user required';end if;
 v_admin:=coalesce(v_actor.access_class,'STAFF')='ADMIN';
 if not v_admin and not private.has_module_access('summary') then raise exception 'Manager or Admin access required';end if;
 if not v_admin and v_actor.outlet_id<>p_outlet_id then raise exception 'You cannot save another outlet summary';end if;
 if not exists(select 1 from public.outlets where id=p_outlet_id) then raise exception 'Outlet not found';end if;
 perform private.assert_summary_date(p_outlet_id,p_business_date,v_admin);
 if exists(select 1 from public.daily_summaries where id=p_summary_id and is_closed=true) then raise exception 'Daily summary is already closed';end if;
 if exists(select 1 from public.daily_summaries where id=p_summary_id and (outlet_id<>p_outlet_id or business_date<>p_business_date)) then raise exception 'Summary identity does not match outlet and business date';end if;
 v_existed:=exists(select 1 from public.daily_summaries where id=p_summary_id);

 if jsonb_typeof(coalesce(p_staff_payouts,'[]'::jsonb))<>'array' then raise exception 'Staff payouts must be a list';end if;
 if exists(select 1 from jsonb_to_recordset(coalesce(p_staff_payouts,'[]'::jsonb)) x(staff_id integer,payout_type varchar,amount numeric,mode varchar)
   where x.amount is null or x.amount<=0 or coalesce(x.mode,'Cash') not in('Cash','UPI')
     or x.payout_type is null or x.payout_type not in('Salary','Reimbursement','Other','Advance')
     or not exists(select 1 from public.staff s where s.id=x.staff_id and s.outlet_id=p_outlet_id)) then
   raise exception 'Choose valid staff, payout type, amount and mode';end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.staff_id,x.amount,x.mode),'[]'::jsonb) into v_old_advances from
   (select staff_id,amount,mode from public.summary_staff_payouts where summary_id=p_summary_id and payout_type='Advance') x;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.staff_id,x.amount,x.mode),'[]'::jsonb) into v_new_advances from
   (select staff_id,amount,coalesce(mode,'Cash') mode from jsonb_to_recordset(coalesce(p_staff_payouts,'[]'::jsonb))
     x(staff_id integer,payout_type varchar,amount numeric,mode varchar) where payout_type='Advance') x;
 if v_new_advances is distinct from v_old_advances then
   raise exception 'Advances must use the approved advance payout workflow; legacy advance rows cannot be changed here';end if;
 insert into public.daily_summaries(id,outlet_id,business_date,saved_by,saved_by_name,role,cash_sale,upi_sale,swiggy_gross,swiggy_payout,zomato_gross,zomato_payout,own_digital,discount,net_sale,opening_cash_system,opening_cash_actual,physical_cash,expected_cash,short_excess,summary_status,is_closed)
 values(p_summary_id,p_outlet_id,p_business_date,v_actor.id,v_actor.name,case when v_admin then 'Admin' else v_actor.role end,coalesce(p_cash_sale,0),coalesce(p_upi_sale,0),coalesce(p_swiggy_gross,0),coalesce(p_swiggy_payout,0),coalesce(p_zomato_gross,0),coalesce(p_zomato_payout,0),coalesce(p_own_digital,0),coalesce(p_discount,0),0,coalesce(p_opening_cash_system,0),coalesce(p_opening_cash_actual,0),coalesce(p_physical_cash,0),0,0,'OPEN',false)
 on conflict(id) do update set saved_by=excluded.saved_by,saved_by_name=excluded.saved_by_name,role=excluded.role,cash_sale=excluded.cash_sale,upi_sale=excluded.upi_sale,swiggy_gross=excluded.swiggy_gross,swiggy_payout=excluded.swiggy_payout,zomato_gross=excluded.zomato_gross,zomato_payout=excluded.zomato_payout,own_digital=excluded.own_digital,discount=excluded.discount,opening_cash_system=excluded.opening_cash_system,opening_cash_actual=excluded.opening_cash_actual,physical_cash=excluded.physical_cash,summary_status='OPEN',is_closed=false;
 delete from public.summary_expenses where summary_id=p_summary_id;delete from public.summary_vendor_payouts where summary_id=p_summary_id;delete from public.summary_staff_payouts where summary_id=p_summary_id;
 insert into public.summary_expenses(summary_id,category,amount,mode) select p_summary_id,x.category,x.amount,coalesce(x.mode,'Cash') from jsonb_to_recordset(coalesce(p_expenses,'[]'::jsonb)) x(category varchar,amount numeric,mode varchar);
 insert into public.summary_vendor_payouts(summary_id,vendor_name,amount,mode) select p_summary_id,x.vendor_name,x.amount,coalesce(x.mode,'Cash') from jsonb_to_recordset(coalesce(p_vendor_payouts,'[]'::jsonb)) x(vendor_name varchar,amount numeric,mode varchar);
 insert into public.summary_staff_payouts(summary_id,staff_id,staff_name,payout_type,amount,mode)
 select p_summary_id,x.staff_id,s.name,x.payout_type,x.amount,coalesce(x.mode,'Cash')
 from jsonb_to_recordset(coalesce(p_staff_payouts,'[]'::jsonb)) x(staff_id integer,staff_name varchar,payout_type varchar,amount numeric,mode varchar)
 join public.staff s on s.id=x.staff_id and s.outlet_id=p_outlet_id;
 v_net:=coalesce(p_cash_sale,0)+coalesce(p_upi_sale,0)+coalesce(p_swiggy_payout,0)+coalesce(p_zomato_payout,0)+coalesce(p_own_digital,0)-coalesce(p_discount,0);
 v_expected:=private.expected_cash(p_summary_id);
 update public.daily_summaries set net_sale=v_net,expected_cash=v_expected,short_excess=coalesce(p_physical_cash,0)-v_expected where id=p_summary_id returning * into v_summary;
 insert into public.business_days(outlet_id,business_date,summary_status) values(p_outlet_id,p_business_date,'OPEN') on conflict(outlet_id,business_date) do update set summary_status='OPEN';
 insert into public.daily_summary_audit(summary_id,outlet_id,business_date,action,actor_user_id,actor_name,actor_role,details)
 values(v_summary.id,v_summary.outlet_id,v_summary.business_date,'SAVED',v_actor.id,v_actor.name,case when v_admin then 'Admin' else v_actor.role end,
  jsonb_build_object('new',not v_existed,
   'late_entry',p_business_date<public.get_effective_business_day(p_outlet_id,now()),
   'expenses',jsonb_array_length(coalesce(p_expenses,'[]'::jsonb)),
   'vendor_payouts',jsonb_array_length(coalesce(p_vendor_payouts,'[]'::jsonb)),
   'staff_payouts',jsonb_array_length(coalesce(p_staff_payouts,'[]'::jsonb)),
   'cash_sale',v_summary.cash_sale,'opening_cash_actual',v_summary.opening_cash_actual,
   'physical_cash',v_summary.physical_cash,'expected_cash',v_summary.expected_cash));
 return v_summary;
end $function$;

-- 5. Record an advance handed over at the counter, straight from the summary.
create or replace function public.record_summary_advance(p_outlet_id integer,p_business_date date,p_staff_id integer,p_amount numeric,p_mode text,p_installments integer default 1,p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $function$
declare v_actor public.users;v_admin boolean;v_staff public.staff;v_summary public.daily_summaries;v_row public.staff_advance_requests;
begin
 perform private.require_module_access('summary');
 select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;
 if not found then raise exception 'Authenticated CafeTracker user required';end if;
 v_admin:=coalesce(v_actor.access_class,'STAFF')='ADMIN';
 if not private.can_use_summary(p_outlet_id) then raise exception 'Summary access denied' using errcode='42501';end if;
 perform private.assert_summary_date(p_outlet_id,p_business_date,v_admin);
 select * into v_staff from public.staff where id=p_staff_id and outlet_id=p_outlet_id and active=true;
 if not found then raise exception 'Choose an active staff member of this café';end if;
 if p_amount is null or p_amount<=0 or p_amount>=10000000000 or p_amount<>round(p_amount,2) then raise exception 'Enter a valid amount';end if;
 if p_mode is null or p_mode not in ('Cash','UPI') then raise exception 'Choose Cash or UPI';end if;
 if p_installments is null or p_installments not between 1 and 12 then raise exception 'Choose 1 to 12 installments';end if;
 if length(coalesce(p_note,''))>500 then raise exception 'Note is too long';end if;
 select * into v_summary from public.daily_summaries where outlet_id=p_outlet_id and business_date=p_business_date for update;
 if found and v_summary.is_closed then raise exception 'Daily Summary is closed; reopen it before recording an advance';end if;
 insert into public.staff_advance_requests(staff_id,outlet_id,amount,installments,note,status,requested_by,requested_at,decided_by,decided_at,
   decision_note,paid_by,paid_at,business_date,mode,first_period,repayment_anchor_date,source,self_recorded)
 values(v_staff.id,p_outlet_id,p_amount,p_installments,coalesce(p_note,''),'PAID',v_actor.id,now(),v_actor.id,now(),
   'Recorded from Daily Summary',v_actor.id,now(),p_business_date,p_mode,
   private.salary_period_containing(p_business_date,v_staff.joining_date),
   coalesce(v_staff.joining_date,date_trunc('month',p_business_date)::date),'SUMMARY',v_actor.staff_id is not distinct from v_staff.id)
 returning * into v_row;
 if v_summary.id is not null then
   update public.daily_summaries set expected_cash=private.expected_cash(v_summary.id),
     short_excess=physical_cash-private.expected_cash(v_summary.id) where id=v_summary.id;
 end if;
 return jsonb_build_object('id',v_row.id,'staff_id',v_row.staff_id,'amount',v_row.amount,'mode',v_row.mode,'status',v_row.status,
   'business_date',v_row.business_date,'installments',v_row.installments,'source',v_row.source,'self_recorded',v_row.self_recorded);
end $function$;

-- 6. Void a summary advance entered by mistake, while the day is open and payroll has not used it.
create or replace function public.void_summary_advance(p_id uuid,p_reason text default '')
returns jsonb language plpgsql security definer set search_path='' as $function$
declare v_actor public.users;v_admin boolean;v_row public.staff_advance_requests;v_summary public.daily_summaries;
begin
 perform private.require_module_access('summary');
 select * into v_actor from public.users where auth_user_id=auth.uid() and active=true;
 if not found then raise exception 'Authenticated CafeTracker user required';end if;
 v_admin:=coalesce(v_actor.access_class,'STAFF')='ADMIN';
 select * into v_row from public.staff_advance_requests where id=p_id for update;
 if not found or v_row.source<>'SUMMARY' or v_row.status<>'PAID' then raise exception 'Only advances recorded from the Daily Summary can be voided';end if;
 if not private.can_use_summary(v_row.outlet_id) then raise exception 'Summary access denied' using errcode='42501';end if;
 perform private.assert_summary_date(v_row.outlet_id,v_row.business_date,v_admin);
 if length(coalesce(p_reason,''))>500 then raise exception 'Reason is too long';end if;
 select * into v_summary from public.daily_summaries where outlet_id=v_row.outlet_id and business_date=v_row.business_date for update;
 if found and v_summary.is_closed then raise exception 'Daily Summary is closed; reopen it before voiding an advance';end if;
 if exists(select 1 from public.staff_advance_deductions d where d.advance_id=v_row.id) then
   raise exception 'This advance has already been deducted in payroll';end if;
 if exists(select 1 from public.salary_records r where r.staff_id=v_row.staff_id and v_row.business_date between r.period_start and r.period_end
   and coalesce(r.payroll_status,'DRAFT')<>'DRAFT') then
   raise exception 'Payroll for this period is already finalised. Ask the owner to adjust payroll instead';end if;
 update public.staff_advance_requests set status='VOID',voided_by=v_actor.id,voided_at=now(),void_reason=coalesce(p_reason,'') where id=p_id returning * into v_row;
 if v_summary.id is not null then
   update public.daily_summaries set expected_cash=private.expected_cash(v_summary.id),
     short_excess=physical_cash-private.expected_cash(v_summary.id) where id=v_summary.id;
 end if;
 return jsonb_build_object('id',v_row.id,'status',v_row.status);
end $function$;

-- 7. Summary reconciliation list now says where each advance came from.
create or replace function public.get_summary_advances(p_outlet_id integer,p_business_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare v_result jsonb;
begin
 if not private.can_use_summary(p_outlet_id) then raise exception 'Summary access denied' using errcode='42501';end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.status,x.id),'[]'::jsonb) into v_result from
  (select id,staff_id,amount,mode,status,business_date,installments,source,self_recorded from public.staff_advance_requests
   where outlet_id=p_outlet_id and (status='APPROVED' or (status='PAID' and business_date=p_business_date))) x;
 return v_result;
end $function$;

revoke all on function public.record_summary_advance(integer,date,integer,numeric,text,integer,text),public.void_summary_advance(uuid,text) from public,anon;
grant execute on function public.record_summary_advance(integer,date,integer,numeric,text,integer,text),public.void_summary_advance(uuid,text) to authenticated;
revoke all on function public.get_summary_advances(integer,date) from public,anon;
grant execute on function public.get_summary_advances(integer,date) to authenticated;

create or replace function public.get_app_release() returns jsonb language sql stable set search_path='' as $f$ select jsonb_build_object('schema_build',152) $f$;
