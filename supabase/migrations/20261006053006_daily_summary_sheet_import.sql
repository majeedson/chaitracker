-- Full source provenance and reversible snapshots; never exposed through the app API.
create table private.daily_summary_sheet_imports(
 batch_id uuid not null, spreadsheet_id text not null, source_row integer not null,
 summary_id varchar not null, source_values jsonb not null, disposition text not null,
 before_record jsonb, after_record jsonb, imported_at timestamptz not null default now(),
 primary key(batch_id,source_row));
alter table private.daily_summary_sheet_imports enable row level security;
revoke all on private.daily_summary_sheet_imports from public,anon,authenticated;
create index daily_summary_sheet_imports_record_idx on private.daily_summary_sheet_imports(summary_id);

-- Database administrator only. The caller supplies an inspected plan with optimistic snapshots.
create function private.import_daily_summary_sheet(p_batch uuid,p_spreadsheet text,p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r jsonb; current_record jsonb; expected_record jsonb; sid varchar; moved integer; applied integer:=0;
begin
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)=0 then raise exception 'Empty import plan'; end if;
 if exists(select 1 from private.daily_summary_sheet_imports where batch_id=p_batch) then raise exception 'Batch already imported'; end if;
 lock table public.daily_summaries,public.summary_expenses,public.summary_vendor_payouts,public.summary_staff_payouts in share row exclusive mode;
 for r in select value from jsonb_array_elements(p_rows) loop
  if r->>'disposition'='superseded_duplicate' then continue; end if;
  sid:=r->>'summary_id';
  select to_jsonb(d)||jsonb_build_object(
   'expenses',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) from public.summary_expenses e where e.summary_id=d.id),
   'vendors',(select coalesce(jsonb_agg(to_jsonb(v) order by v.id),'[]'::jsonb) from public.summary_vendor_payouts v where v.summary_id=d.id),
   'staff_payments',(select coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]'::jsonb) from public.summary_staff_payouts s where s.summary_id=d.id))
   into current_record from public.daily_summaries d where d.id=sid;
  if coalesce(current_record,'null'::jsonb) is distinct from coalesce(r->'before_record','null'::jsonb) then raise exception 'Summary changed since inspection: %',sid; end if;
 end loop;
 create temporary table _daily_summary_import on commit drop as
  select value as payload,(value->'record'->'summary'->>'id')::varchar as id,
   (value->'record'->'summary'->>'business_date')::date as business_date,
   row_number() over(order by (value->>'source_row')::integer)::integer as position
  from jsonb_array_elements(p_rows) where jsonb_typeof(value->'record')='object';
 if exists(select id from pg_temp._daily_summary_import group by id having count(*)>1) then raise exception 'Repeated target ID'; end if;
 if exists(select 1 from pg_temp._daily_summary_import t where t.business_date>=current_date) then raise exception 'Unfinished/future business day'; end if;
 if exists(select 1 from public.daily_summaries where business_date>=date '2099-01-01') then raise exception 'Temporary date range is occupied'; end if;
 -- Move shifted legacy dates out of the unique-key range inside this transaction only.
 update public.daily_summaries d set business_date=date '2099-01-01'+t.position
  from pg_temp._daily_summary_import t where d.id=t.id and d.business_date<>t.business_date;
 get diagnostics moved=row_count;
 for r in select payload from pg_temp._daily_summary_import order by position loop
  sid:=r->>'summary_id';
  insert into public.daily_summaries select (jsonb_populate_record(null::public.daily_summaries,r->'record'->'summary')).*
   on conflict(id) do update set
    outlet_id=excluded.outlet_id,business_date=excluded.business_date,saved_by=excluded.saved_by,saved_by_name=excluded.saved_by_name,role=excluded.role,
    cash_sale=excluded.cash_sale,upi_sale=excluded.upi_sale,own_digital=excluded.own_digital,discount=excluded.discount,net_sale=excluded.net_sale,
    swiggy_gross=excluded.swiggy_gross,swiggy_payout=excluded.swiggy_payout,zomato_gross=excluded.zomato_gross,zomato_payout=excluded.zomato_payout,
    opening_cash_system=excluded.opening_cash_system,opening_cash_actual=excluded.opening_cash_actual,physical_cash=excluded.physical_cash,
    expected_cash=excluded.expected_cash,short_excess=excluded.short_excess,summary_status=excluded.summary_status,is_closed=excluded.is_closed,
    closed_by=excluded.closed_by,closed_at=excluded.closed_at,created_at=excluded.created_at;
  delete from public.summary_expenses where summary_id=sid;
  delete from public.summary_vendor_payouts where summary_id=sid;
  delete from public.summary_staff_payouts where summary_id=sid;
  insert into public.summary_expenses(summary_id,category,amount,mode)
   select sid,x.category,x.amount,x.mode from jsonb_to_recordset(r->'record'->'expenses') x(category varchar,amount numeric,mode varchar);
  insert into public.summary_vendor_payouts(summary_id,vendor_name,amount,mode)
   select sid,x.vendor_name,x.amount,x.mode from jsonb_to_recordset(r->'record'->'vendors') x(vendor_name varchar,amount numeric,mode varchar);
  insert into public.summary_staff_payouts(summary_id,staff_name,staff_id,payout_type,amount,mode)
   select sid,x.staff_name,x.staff_id,x.payout_type,x.amount,x.mode from jsonb_to_recordset(r->'record'->'staff_payments') x(staff_name varchar,staff_id integer,payout_type varchar,amount numeric,mode varchar);
  -- Every field and payment list must match the plan before the transaction can commit.
  select jsonb_build_object('summary',to_jsonb(d),
   'expenses',(select coalesce(jsonb_agg(to_jsonb(e)-'id'-'summary_id' order by e.id),'[]'::jsonb) from public.summary_expenses e where e.summary_id=sid),
   'vendors',(select coalesce(jsonb_agg(to_jsonb(v)-'id'-'summary_id' order by v.id),'[]'::jsonb) from public.summary_vendor_payouts v where v.summary_id=sid),
   'staff_payments',(select coalesce(jsonb_agg(to_jsonb(s)-'id'-'summary_id' order by s.id),'[]'::jsonb) from public.summary_staff_payouts s where s.summary_id=sid))
   into current_record from public.daily_summaries d where d.id=sid;
  expected_record:=(r->'record')||jsonb_build_object('summary',to_jsonb(jsonb_populate_record(null::public.daily_summaries,r->'record'->'summary')));
  if current_record is distinct from expected_record then raise exception 'Import verification failed: %',sid; end if;
  applied:=applied+1;
 end loop;
 insert into private.daily_summary_sheet_imports(batch_id,spreadsheet_id,source_row,summary_id,source_values,disposition,before_record,after_record)
  select p_batch,p_spreadsheet,(value->>'source_row')::integer,value->>'summary_id',value->'source_values',value->>'disposition',
   nullif(value->'before_record','null'::jsonb),nullif(value->'record','null'::jsonb) from jsonb_array_elements(p_rows);
 drop table pg_temp._daily_summary_import;
 return jsonb_build_object('batch_id',p_batch,'source_rows',jsonb_array_length(p_rows),'applied',applied,'dates_corrected',moved,
  'inserted',(select count(*) from jsonb_array_elements(p_rows) where value->>'disposition'='inserted'),
  'superseded_duplicates',(select count(*) from jsonb_array_elements(p_rows) where value->>'disposition'='superseded_duplicate'));
end $$;
revoke all on function private.import_daily_summary_sheet(uuid,text,jsonb) from public,anon,authenticated;
