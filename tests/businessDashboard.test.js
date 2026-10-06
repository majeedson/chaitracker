import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {JSDOM} from 'jsdom';
import {businessTotals,comparableChange,dashboardPeriods,groupedCosts} from '../src/businessMetrics.js';
import {renderBusinessDashboard} from '../src/businessDashboard.js';
let db;
const admin='00000000-0000-0000-0000-000000000001',staff='00000000-0000-0000-0000-000000000002';
const actor=id=>db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
const dashboard=async outlet=>(await db.query('select public.get_business_dashboard($1) data',[outlet??null])).rows[0].data;
before(async()=>{
 db=new PGlite();
 await db.exec(await fs.readFile(new URL('fixtures/payroll-schema.sql',import.meta.url),'utf8'));
 await db.exec(`create or replace function public.get_effective_business_day(integer,timestamptz) returns date language sql stable as $$select case when $2=now() then date '2026-10-06' else (($2 at time zone 'Asia/Kolkata')-interval '4 hours')::date end$$;
 insert into outlets(id,name) values(1,'Teapot'),(2,'Chai'),(3,'New café');
 insert into users(id,auth_user_id,name,access_class,active) values('${admin}','${admin}','Owner','ADMIN',true),('${staff}','${staff}','Manager','STAFF',true);
 insert into staff(id,name,outlet_id) values(1,'Employee',1);
 insert into daily_summaries(id,outlet_id,business_date,net_sale,cash_sale,upi_sale,swiggy_gross,swiggy_payout,discount,short_excess,is_closed) values
 ('DAY',1,'2026-10-05',1950,1000,800,300,200,50,-20,true),('OTHER',2,'2026-10-05',100,100,0,0,0,0,5,true);
 insert into summary_expenses(summary_id,category,amount) values('DAY','Milk',100),('DAY','Utility',50),('DAY','Pigmy',200);
 insert into summary_vendor_payouts(summary_id,vendor_name,amount) values('DAY','Vendor',100),('DAY','Vendor',200);
 insert into summary_staff_payouts(summary_id,staff_id,payout_type,amount) values('DAY',1,'Salary',200),('DAY',1,'OT',25),('DAY',1,'Advance',50);
 insert into salary_records(id,outlet_id,staff_id,payroll_status,net_salary,paid_at) values
 ('PAID1',1,1,'PAID',200,'2026-10-05T12:00Z'),('PAID2',1,1,'PAID',200,'2026-10-05T12:01Z'),('PAID3',1,1,'PAID',400,'2026-10-05T12:02Z'),('UNPAID',1,1,'FINALIZED',1000,null),('DRAFT',1,1,'DRAFT',700,null);
 insert into staff_advance_requests(outlet_id,staff_id,status,business_date,amount,paid_at) values(1,1,'PAID','2026-10-05',50,'2026-10-05T12:00Z'),(1,1,'PAID','2026-10-05',60,'2026-10-05T12:01Z');`);
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261006050646_business_dashboard_b137.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());
beforeEach(async()=>{await db.exec('begin');await actor(admin);});
afterEach(async()=>{await db.exec('rollback;reset role');});
const rejects=async(fn,pattern)=>{await db.exec('savepoint expected_failure');try{await assert.rejects(fn(),pattern);}finally{await db.exec('rollback to expected_failure;release savepoint expected_failure');}};
test('financial rollup avoids join multiplication, excludes savings/advances, counts paid payroll once',async()=>{
 const data=await dashboard(1),t=businessTotals(data,'2026-10-05','2026-10-05');
 assert.equal(t.net_sales,1950);assert.equal(t.gross_sales,2100);assert.equal(t.platform_reduction,100);
 assert.equal(t.operating_expenses,150);assert.equal(t.vendor_payments,300);assert.equal(t.staff_costs,825);
 assert.equal(t.costs,1275);assert.equal(t.profit,675);assert.equal(t.savings,200);assert.equal(t.advances,110);assert.equal(t.retained,365);
 assert.equal(data.payroll_not_marked_paid,1000);assert.equal(data.payroll_records_not_marked_paid,1);
 assert.equal(groupedCosts(data,'2026-10-01','2026-10-05').reduce((sum,c)=>sum+c.amount,0),1275);
});
test('anonymous, staff/manager and inactive admin cannot read financial aggregates',async()=>{
 await actor(staff);await rejects(()=>dashboard(),/Admin access required/);
 await actor('');await rejects(()=>dashboard(),/Admin access required/);
 await actor(admin);await db.query('update users set active=false where id=$1',[admin]);await rejects(()=>dashboard(),/Admin access required/);
 await db.exec('set role anon');await rejects(()=>dashboard(),/permission denied/);
});
test('authenticated admin can scope one café; invalid scope is rejected and shortages do not offset excess',async()=>{
 await db.exec('set role authenticated');const scoped=await dashboard(1);assert.equal(scoped.outlets.length,1);assert.ok(scoped.days.every(d=>d.outlet_id===1));
 const all=businessTotals(await dashboard(),'2026-10-05','2026-10-05');assert.equal(all.cash_shortage,20);assert.equal(all.cash_excess,5);
 await rejects(()=>dashboard(999),/Outlet not found/);
});
test('missing days stay unavailable, real zero sales stay zero, and incomplete growth is withheld',async()=>{
 const data=await dashboard(1),missing=businessTotals(data,'2026-10-04','2026-10-04');assert.equal(missing.profit,null);assert.equal(missing.daily_average,null);
 data.days.push({...data.days[0],business_date:'2026-10-06',net_sales:0,gross_sales:0,operating_expenses:0,vendor_payments:0,staff_costs:0,savings:0,advances:0});
 const zero=businessTotals(data,'2026-10-06','2026-10-06');assert.equal(zero.profit,0);assert.equal(zero.net_sales,0);assert.equal(zero.margin,null);
 assert.equal(comparableChange(zero,missing),null);
 const complete={complete:true,expected:1,reporting_ids:[1],net_sales:100};assert.equal(comparableChange({...complete,net_sales:120},complete),20);
 assert.equal(comparableChange({...complete,reporting_ids:[2]},complete),null);
 assert.equal(comparableChange(complete,{...complete,net_sales:0}),null);
});
test('equal elapsed day comparisons handle short months, leap years and the first day of a new year',()=>{
 const empty={outlets:[],days:[],costs:[],business_day:'2026-03-31'};
 const march=dashboardPeriods(empty,'2026-03-31',true);assert.equal(march.comparisonEnd,'2026-03-28');assert.equal(march.previousComparableEnd,'2026-02-28');
 const leap=dashboardPeriods({...empty,business_day:'2024-03-31'},'2024-03-31',true);assert.equal(leap.comparisonEnd,'2024-03-29');assert.equal(leap.previousComparableEnd,'2024-02-29');
 const january=dashboardPeriods({...empty,business_day:'2027-01-01'});assert.equal(january.currentMonth,'2027-01');assert.equal(january.elapsed,0);assert.equal(january.current.expected,0);assert.equal(january.previousFull.net_sales,0);
});
test('legacy net totals are preserved and material channel differences withhold growth',async()=>{
 const data=await dashboard(1),day='2026-10-05',row=data.days.find(d=>d.business_date===day);
 row.net_sales=Number(row.cash_sales)+Number(row.direct_digital)+Number(row.online_net)-Number(row.discounts)+2;
 assert.equal(businessTotals(data,day,day).unreconciled,0);
 row.net_sales+=1000;
 const total=businessTotals(data,day,day);assert.equal(total.unreconciled,1);assert.equal(total.net_sales,row.net_sales);
 assert.equal(comparableChange(total,{...total,unreconciled:0,net_sales:100}),null);
 const dom=new JSDOM('<main></main>'),view=dom.window.document.querySelector('main');
 const q={select:()=>q,eq:async()=>({data:[]})};
 await renderBusinessDashboard(view,{rpc:async name=>({data:name==='get_business_dashboard'?data:[]}),from:()=>q},{access_class:'ADMIN',context_outlet_id:1});
 assert.match(view.textContent,/Net sales need reconciliation/);assert.match(view.textContent,/Check net sales/);
 dom.window.close();
});
test('dashboard uses yesterday, flags data gaps, supports history and emits café-scoped actions',async()=>{
 const data=await dashboard(),dom=new JSDOM('<main id="view"></main>');globalThis.CustomEvent=dom.window.CustomEvent;
 const view=dom.window.document.querySelector('#view'),calls=[];
 const client={rpc:async(name,args)=>{calls.push({name,args});return name==='get_business_dashboard'?{data}:{data:[]};},from:()=>{const q={select:()=>q,eq:async()=>({data:[]})};return q;}};
 const profile={id:admin,access_class:'ADMIN'};
 await renderBusinessDashboard(view,client,profile);
 assert.equal(view.querySelector('#businessDashboardDay').value,'2026-10-05');assert.match(view.textContent,/Profit estimate/);assert.match(view.textContent,/cash basis estimate/i);
 assert.equal(view.querySelectorAll('.biz-table')[0].querySelectorAll('tbody tr').length,7);
 let event;view.addEventListener('app:navigate',e=>event=e.detail);view.querySelector('[data-biz-cafe="1"]').click();assert.equal(event.module,'dashboard');assert.equal(event.outletId,1);
 const day=view.querySelector('#businessDashboardDay');day.value='2026-10-04';day.dispatchEvent(new dom.window.Event('change'));
 assert.match(view.textContent,/No sales summaries for this day/);assert.equal(view.querySelector('.biz-kpi strong').textContent,'—');assert.equal(profile._dashboardDay,'2026-10-04');
 dom.window.close();delete globalThis.CustomEvent;
});
