import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {buildSummaryImport,sourceTime} from '../scripts/daily-summary-import.mjs';
let db;
const headers=['SummaryID','Timestamp','BusinessDate','Outlet','SavedBy','Role','CashSale','UPISale','Swiggy','Zomato','OwnDigital','Discount','NetSale','Expenses','PhysicalCash','ShortExcess','OpeningCashSystem','OpeningCashActual','SwiggyPayout','ZomatoPayout','VendorPayments','StaffPayments','IsClosed','ClosedBy','ClosedAt','SwiggyGross','ZomatoGross','ExpectedCash','SummaryStatus'];
const row=(id,date,override={})=>{const r={SummaryID:id,Timestamp:date+' 23:00:00',BusinessDate:date,Outlet:'Teapot',SavedBy:'Anuj',Role:'Manager',CashSale:'100',UPISale:'200',NetSale:'350',Expenses:'[{"category":"Pigmy","amount":10,"mode":"Cash"},{"category":"","amount":25,"mode":"UPI"}]',VendorPayments:'[{"vendor":"Vendor","amount":40,"mode":"Cash"}]',StaffPayments:'[{"staff":"Anuj","type":"Advance","amount":15}]',Swiggy:'100',SwiggyPayout:'50',...override};return headers.map(h=>r[h]??'');};
const snapshot=async()=>({outlets:(await db.query('select id,name from outlets')).rows,users:(await db.query('select id,name,outlet_id from users')).rows,staff:(await db.query('select id,name,outlet_id from staff')).rows,summaries:(await db.query(`select to_jsonb(d)||jsonb_build_object('expenses',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]'::jsonb) from summary_expenses e where e.summary_id=d.id),'vendors',(select coalesce(jsonb_agg(to_jsonb(v) order by id),'[]'::jsonb) from summary_vendor_payouts v where v.summary_id=d.id),'staff_payments',(select coalesce(jsonb_agg(to_jsonb(s) order by id),'[]'::jsonb) from summary_staff_payouts s where s.summary_id=d.id)) as record from daily_summaries d`)).rows.map(r=>r.record)});
const plan=async rows=>buildSummaryImport({values:[headers,...rows],database:await snapshot(),asOf:'2026-03-01'});
const run=async(p,batch='00000000-0000-0000-0000-000000000001')=>(await db.query('select private.import_daily_summary_sheet($1,$2,$3) as result',[batch,'source-sheet',JSON.stringify(p)])).rows[0].result;
const rejects=async(fn,pattern)=>{await db.exec('savepoint expected_failure');try{await assert.rejects(fn(),pattern);}finally{await db.exec('rollback to expected_failure;release savepoint expected_failure');}};
before(async()=>{
 db=new PGlite();await db.exec(await fs.readFile(new URL('fixtures/payroll-schema.sql',import.meta.url),'utf8'));
 await db.exec(`alter table summary_expenses add column id serial primary key;alter table summary_vendor_payouts add column id serial primary key;alter table daily_summaries add unique(outlet_id,business_date);
 alter table summary_expenses add check(mode in('Cash','UPI'));create table daily_summary_audit(summary_id varchar references daily_summaries(id),action text);
 insert into outlets(id,name) values(1,'Teapot');insert into users(name,outlet_id) values('Anuj',1);insert into staff(id,name,outlet_id) values(3,'Anuj',1);
 insert into daily_summaries(id,outlet_id,business_date,net_sale) values('OLD1',1,'2026-02-23',10),('OLD2',1,'2026-02-24',20);
 insert into summary_expenses(summary_id,category,amount,mode) values('OLD1','Old cost',5,'Cash');insert into daily_summary_audit values('OLD1','REOPENED');`);
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261006053006_daily_summary_sheet_import.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());beforeEach(async()=>db.exec('begin'));afterEach(async()=>db.exec('rollback;reset role'));
test('latest submission wins, same timestamps use last sheet row, source date remains literal and blank amounts stay unknown',async()=>{
 const p=await plan([row('OLD1','2026-02-24',{Timestamp:'2026-02-25 2:02:00'}),row('NEW','2026-02-24',{Timestamp:'2026-02-25 2:03:00',NetSale:'450'}),row('NEWER','2026-02-24',{Timestamp:'2026-02-25 2:03:00',NetSale:'550'}),row('OLD2','2026-02-25')]);
 assert.equal(p[2].record.summary.net_sale,550);assert.equal(p[2].summary_id,'OLD1');assert.equal(p[2].record.summary.business_date,'2026-02-24');assert.equal(p[2].record.summary.expected_cash,null);
 assert.equal(p[2].record.summary.created_at,'2026-02-24T20:33:00.000Z');assert.equal(p[2].record.summary.swiggy_gross,100);assert.equal(p[2].record.expenses[1].category,'Uncategorised');assert.equal(p[2].record.staff_payments[0].staff_id,3);
 assert.equal(p.filter(r=>r.disposition==='superseded_duplicate').length,2);
});
test('date correction handles adjacent unique keys, keeps stable IDs/audit and replaces payment lists exactly once',async()=>{
 const p=await plan([row('OLD1','2026-02-24'),row('OLD2','2026-02-25'),row('NEW3','2026-02-26')]);
 const result=await run(p);assert.equal(result.dates_corrected,2);assert.equal(result.inserted,1);
 const s=await snapshot();assert.deepEqual(s.summaries.map(d=>d.business_date).sort(),['2026-02-24','2026-02-25','2026-02-26']);assert.equal(s.summaries.find(d=>d.id==='OLD1').expenses.length,2);
 assert.equal((await db.query('select count(*) n from daily_summary_audit')).rows[0].n,1);
 const audit=(await db.query('select before_record,after_record from private.daily_summary_sheet_imports where source_row=2')).rows[0];assert.equal(audit.before_record.business_date,'2026-02-23');assert.equal(audit.before_record.expenses[0].amount,5);assert.equal(audit.after_record.summary.business_date,'2026-02-24');
 await run(await plan([row('OLD1','2026-02-24'),row('OLD2','2026-02-25'),row('NEW3','2026-02-26')]),'00000000-0000-0000-0000-000000000002');
 assert.equal((await db.query('select count(*) n from summary_staff_payouts')).rows[0].n,3);
});
test('stale inspected records abort before updates; invalid payment rolls back the entire import',async()=>{
 const p=await plan([row('OLD1','2026-02-24'),row('OLD2','2026-02-25')]);await db.exec("update daily_summaries set net_sale=999 where id='OLD1'");
 await rejects(()=>run(p),/changed since inspection/);assert.equal((await db.query('select count(*) n from private.daily_summary_sheet_imports')).rows[0].n,0);
 const fresh=await plan([row('OLD1','2026-02-24'),row('OLD2','2026-02-25')]);fresh[1].record.expenses[0].mode='Invalid';
 await rejects(()=>run(fresh),/check constraint/);assert.equal((await db.query("select business_date::text d,net_sale from daily_summaries where id='OLD1'")).rows[0].d,'2026-02-23');
 assert.equal((await db.query('select count(*) n from private.daily_summary_sheet_imports')).rows[0].n,0);
});
test('a newer native app submission is retained, and source validation rejects ambiguous or incomplete records',async()=>{
 await db.exec("insert into daily_summaries(id,outlet_id,business_date,net_sale,created_at) values('APP',1,'2026-02-28',900,'2026-02-28T20:00Z')");
 const p=await plan([row('SHEET','2026-02-28')]);assert.equal(p[0].disposition,'newer_app_record');assert.equal(p[0].record,null);await run(p);assert.equal((await db.query("select net_sale from daily_summaries where id='APP'")).rows[0].net_sale,'900');
 await assert.rejects(()=>plan([row('BAD','2026-02-30')]),/Invalid business date/);
 await assert.rejects(()=>plan([row('BAD','2026-02-26',{NetSale:'bad'})]),/Invalid amount/);
 assert.throws(()=>sourceTime('2026-02-24 25:01:00'),/Invalid source timestamp/);
});
test('anonymous and authenticated app roles cannot execute import or read source audit data',async()=>{
 await db.exec('set role authenticated');await rejects(()=>db.query('select private.import_daily_summary_sheet($1,$2,$3)',['00000000-0000-0000-0000-000000000001','source','[]']),/permission denied/);
 await rejects(()=>db.query('select * from private.daily_summary_sheet_imports'),/permission denied/);await db.exec('set role anon');await rejects(()=>db.query('select * from private.daily_summary_sheet_imports'),/permission denied/);
});
