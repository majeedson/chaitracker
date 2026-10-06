import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {buildSalaryImport} from '../scripts/salary-sheet-import.mjs';
import {businessTotals} from '../src/businessMetrics.js';
const admin='00000000-0000-0000-0000-000000000001';let db;
const header=['SalaryID','Timestamp','Outlet','SavedBy','StaffName','PeriodStart','PeriodEnd','PayDate','PeriodDays','BasicSalary','HolidayPay','PresentDays','AbsentDays','AbsentDeduction','LateMins','LatePenalty','LatePenaltyWaived','PettyAdvance','OTCredit','LoanPrevBalance','LoanDeductThisMonth','LoanRemaining','NetSalary'];
const row=(id,overrides={})=>header.map(h=>({SalaryID:id,Timestamp:'2026-09-20 23:00:00',Outlet:'Cafe',SavedBy:'Owner',StaffName:'Employee',PeriodStart:'2026-08-12',PeriodEnd:'2026-09-11',PayDate:'2026-09-22',PeriodDays:31,BasicSalary:1000,PettyAdvance:200,NetSalary:800,...overrides})[h]??'');
const snapshot=async()=>({outlets:(await db.query('select id,name from outlets')).rows,staff:(await db.query('select id,name,outlet_id from staff')).rows,users:(await db.query('select id,name,outlet_id from users')).rows,salaries:(await db.query('select to_jsonb(s) data from salary_records s')).rows.map(x=>x.data)});
const input=async(values,extra={})=>({values:[header,...values],database:await snapshot(),spreadsheetId:'source',asOf:'2026-10-06',...extra});
const importPlan=async(plan,batch='00000000-0000-0000-0000-000000000010')=>(await db.query('select private.import_salary_sheet($1,$2,$3) data',[batch,'source',JSON.stringify(plan)])).rows[0].data;
const dashboard=async()=>(await db.query('select public.get_business_dashboard(1) data')).rows[0].data;
before(async()=>{
 db=new PGlite();await db.exec(await fs.readFile(new URL('fixtures/payroll-schema.sql',import.meta.url),'utf8'));
 await db.exec(`create or replace function public.get_effective_business_day(integer,timestamptz) returns date language sql stable as $$select case when $2=now() then date '2026-10-06' else (($2 at time zone 'Asia/Kolkata')-interval '4 hours')::date end$$;
 insert into outlets(id,name) values(1,'Cafe'),(2,'Other');
 insert into staff(id,name,outlet_id) values(1,'Employee',1),(2,'Other employee',2);
 insert into users(id,auth_user_id,name,outlet_id,access_class,active) values('${admin}','${admin}','Owner',1,'ADMIN',true);
 insert into daily_summaries(id,outlet_id,business_date,cash_sale,net_sale) values('DAY',1,'2026-09-25',2000,2000);
 insert into summary_staff_payouts(summary_id,staff_id,staff_name,payout_type,amount) values('DAY',1,'Employee','Salary',750),('DAY',1,'Employee','Advance',200),('DAY',1,'Employee','OT',25);`);
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261006150713_payroll_dashboard_b142.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());beforeEach(async()=>{await db.exec('begin');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[admin]);});afterEach(async()=>{await db.exec('rollback;reset role');});
test('last sheet row wins per salary start month even with backdated timestamps; net salary preserves advance deductions',async()=>{
 const plan=buildSalaryImport(await input([row('OLD'),row('NEW',{Timestamp:'2026-09-01 23:00:00',PeriodStart:'2026-08-01',NetSalary:850})]));
 assert.equal(plan[0].disposition,'superseded_duplicate');assert.equal(plan[1].record.net_salary,850);assert.equal(plan[1].record.petty_advance,200);assert.equal(plan[1].record.payroll_status,'PAID');
 await importPlan(plan);const d=await dashboard(),t=businessTotals(d,'2026-09-01','2026-09-30');assert.equal(t.staff_costs,1625);assert.equal(t.advances,200);
 assert.equal((await db.query('select count(*) n from private.salary_sheet_imports')).rows[0].n,2);
});
test('reconciled salary overrides a different summary amount once; advances and drawer records remain unchanged',async()=>{
 const summary=(await db.query("select p.*,d.outlet_id,d.business_date::text from summary_staff_payouts p join daily_summaries d on d.id=p.summary_id where payout_type='Salary'")).rows;
 const plan=buildSalaryImport(await input([row('SAL')],{summaryPayments:summary,links:[{salary_source_id:'SAL',summary_staff_id:summary[0].id}]}));
 await importPlan(plan);const t=businessTotals(await dashboard(),'2026-09-25','2026-09-25');
 assert.equal(t.staff_costs,825);assert.equal(t.advances,200);assert.equal(t.profit,1175);assert.equal(t.retained,975);
 assert.equal(Number((await db.query("select amount from summary_staff_payouts where payout_type='Salary'")).rows[0].amount),750);
 assert.equal((await importPlan(plan)).already_imported,true);
 assert.equal(Number((await db.query("select net_salary from salary_records where id='SAL'")).rows[0].net_salary),800);
});
test('superseded existing months retain their IDs and originals but do not enter paid costs or unpaid alerts',async()=>{
 await db.exec("insert into salary_records(id,outlet_id,staff_id,period_start,period_end,net_salary,petty_advance,legacy_salary_id,payroll_status) values('OLD',1,1,'2026-08-12','2026-09-11',700,200,'OLD','FINALIZED')");
 const plan=buildSalaryImport(await input([row('OLD'),row('NEW',{PeriodStart:'2026-08-01'})]));await importPlan(plan);
 const d=await dashboard();assert.equal(d.payroll_records_not_marked_paid,0);assert.equal(Number((await db.query("select net_salary from salary_records where id='OLD'")).rows[0].net_salary),700);
 assert.equal((await db.query("select payroll_details->'salary_sheet_import'->>'superseded' value from salary_records where id='OLD'")).rows[0].value,'true');
});
test('inspection drift and reused or foreign summary links are rejected atomically',async()=>{
 await db.exec("insert into salary_records(id,outlet_id,staff_id,period_start,period_end,net_salary,legacy_salary_id) values('SAL',1,1,'2026-08-12','2026-09-11',700,'SAL')");
 const inp=await input([row('SAL')]),plan=buildSalaryImport(inp);await db.exec("update salary_records set net_salary=710 where id='SAL';savepoint failure");
 await assert.rejects(importPlan(plan),/changed since inspection/);await db.exec('rollback to failure');assert.equal((await db.query('select count(*) n from private.salary_sheet_imports')).rows[0].n,0);
 assert.throws(()=>buildSalaryImport({...inp,links:[{salary_source_id:'SAL',summary_staff_id:999}]}),/Invalid or reused/);
 assert.throws(()=>buildSalaryImport({...inp,values:[header,row('SAL',{PayDate:'2026-12-22'})]}),/future salary/);
});
test('payment-only history flags missing sales and protected import/audit remain unavailable to app roles',async()=>{
 await importPlan(buildSalaryImport(await input([row('SAL')])));const d=await dashboard(),t=businessTotals(d,'2026-09-22','2026-09-22');assert.equal(t.expected,1);assert.equal(t.reported,0);assert.equal(t.staff_costs,800);assert.equal(t.profit,null);
 await db.exec('set role authenticated;savepoint denied');await assert.rejects(importPlan([]),/permission denied/);await db.exec('rollback to denied;savepoint denied');await assert.rejects(db.query('select * from private.salary_sheet_imports'),/permission denied/);await db.exec('rollback to denied');
});
