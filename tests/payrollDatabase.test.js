import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {loadSalaryTransfers} from '../src/payrollData.js';

let db;
const admin='00000000-0000-0000-0000-000000000001',staff='00000000-0000-0000-0000-000000000002',other='00000000-0000-0000-0000-000000000003',advance='00000000-0000-0000-0000-000000000010';
const rows=async(sql,args=[])=>(await db.query(sql,args)).rows;
const actor=async(id=admin)=>db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
const estimate=async(start='2026-09-01',end='2026-09-30')=>(await rows('select get_salary_estimate_v2(1,$1,$2) value',[start,end]))[0].value;
const details=(extra={})=>({basic_salary:15000,present_days:27,absent_days:3,half_days:0,holiday_pay:0,holiday_days:0,extra_earnings:[],extra_deductions:[],included_transfer_ids:[],...extra});
const payroll=async(d,action='FINALIZE',end='2026-09-30')=>(await rows('select * from save_salary_payroll(1,$1,$2,$3,$4,$5,$6)',['2026-09-01',end,'2026-10-10',JSON.stringify(d),action,admin]))[0];
const attendance=async(end='2026-09-30')=>db.exec(`insert into attendance(staff_id,outlet_id,attendance_date,shift_start,punch_time,status,late_mins,half_day) select 1,1,d,'11:00','11:00','Present',0,false from generate_series('2026-09-01'::date,'${end}'::date,interval '1 day') d;`);
const restart=async()=>{await db.exec('rollback;begin');await actor();};
const snapshot={name:'Employee',outlet_id:1,basic_salary:15000,joining_date:'2025-01-01',notes:null,role:'Staff',permissions:{module_access:{summary:true,'extra-time':false}},employment_status:'ACTIVE',status_effective_from:null,status_note:null};
before(async()=>{
 db=new PGlite();
 await db.exec(await fs.readFile(new URL('fixtures/payroll-schema.sql',import.meta.url),'utf8'));
 await db.exec(await fs.readFile(new URL('../supabase/payroll_loan_override_b115.sql',import.meta.url),'utf8'));
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261002125447_payroll_access_b128.sql',import.meta.url),'utf8'));
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261005054016_staff_optional_dates_b133.sql',import.meta.url),'utf8'));
 await db.exec(`insert into outlets(id,name,timezone,shift_start_hour,shift_start_minute,attendance_grace_minutes,half_day_late_minutes) values(1,'Cafe','Asia/Kolkata',11,0,15,240),(2,'Other','Asia/Kolkata',11,0,15,240);
 insert into staff(id,name,outlet_id,basic_salary,joining_date,active,employment_status) values(1,'Employee',1,15000,'2025-01-01',true,'ACTIVE'),(2,'Other employee',1,12000,'2025-01-07',true,'ACTIVE');
 insert into users(id,auth_user_id,name,role,access_class,outlet_id,staff_id,active,permissions) values
 ('${admin}','${admin}','Owner','Owner','ADMIN',1,null,true,'{}'),
 ('${staff}','${staff}','Employee','Staff','STAFF',1,1,true,'{"module_access":{"summary":true,"extra-time":false}}'),
 ('${other}','${other}','Other employee','Staff','STAFF',1,2,true,'{}');`);
});
after(async()=>db?.close());beforeEach(async()=>{await db.exec('begin');await actor();});afterEach(async()=>db.exec('rollback'));

test('Summary cannot create a self advance or an unapproved owner advance',async()=>{
 const payouts=JSON.stringify([{staff_id:1,payout_type:'Advance',amount:5000,mode:'Cash'}]);await actor(staff);
 await assert.rejects(rows("select save_daily_summary('SUM',1,'2026-09-01',$1,'Employee','Staff',p_staff_payouts=>$2)",[staff,payouts]),/approved advance payout workflow/);
 await restart();await assert.rejects(rows("select save_daily_summary('SUM',1,'2026-09-01',$1,'Owner','Owner',p_staff_payouts=>$2)",[admin,payouts]),/approved advance payout workflow/);
});
test('unchanged legacy advances can be preserved but not duplicated',async()=>{
 await db.exec("insert into daily_summaries(id,outlet_id,business_date,is_closed) values('SUM',1,'2026-09-01',false);insert into summary_staff_payouts(summary_id,staff_id,staff_name,payout_type,amount,mode) values('SUM',1,'Employee','Advance',100,'Cash');");
 const legacy={staff_id:1,payout_type:'Advance',amount:100,mode:'Cash'};
 await rows("select save_daily_summary('SUM',1,'2026-09-01',$1,'Owner','Owner',p_staff_payouts=>$2)",[admin,JSON.stringify([legacy])]);
 await assert.rejects(rows("select save_daily_summary('SUM',1,'2026-09-01',$1,'Owner','Owner',p_staff_payouts=>$2)",[admin,JSON.stringify([legacy,legacy])]),/legacy advance rows/);
});
test('Summary reconciliation exposes minimal payouts without coworker EMI records',async()=>{
 await db.exec(`insert into staff_advance_requests(id,staff_id,outlet_id,amount,installments,status,business_date,mode,note) values('${advance}',2,1,600,3,'PAID','2026-09-01','Cash','private reason');insert into staff_advance_deductions(advance_id,period_start,amount,salary_record_id) values('${advance}','2026-09-01',200,'SECRET');`);
 await actor(staff);await db.exec('set local role authenticated');
 const result=(await rows("select get_summary_advances(1,'2026-09-01') value"))[0].value;
 assert.equal(result.length,1);assert.deepEqual(Object.keys(result[0]).sort(),['amount','business_date','id','mode','staff_id','status']);
 assert.equal((await rows('select * from staff_advance_requests')).length,0);assert.equal((await rows('select * from staff_advance_deductions')).length,0);
 await assert.rejects(rows("select get_summary_advances(2,'2026-09-01')"),/Summary access denied/);
});
test('salary periods and context retain the joining anchor across February',async()=>{
 assert.equal((await rows("select private.salary_period_end('2027-02-28','2025-01-31') value"))[0].value.toISOString().slice(0,10),'2027-03-30');
 await db.exec("insert into salary_records(id,staff_id,outlet_id,period_start,period_end,payroll_status,loan_remaining) values('AUG',1,1,'2026-08-07','2026-09-06','PAID',1000);");
 const c=(await rows("select get_salary_payroll_context(1,'2026-09-07') value"))[0].value;
 assert.equal(c.current,null);assert.equal(c.prior.id,'AUG');assert.equal(c.prior.loan_remaining,1000);
});
test('30/31 day estimates apply the three-off rule and missing records stay incomplete',async()=>{
 await attendance();await db.exec("update attendance set status='Absent' where attendance_date<='2026-09-03'");assert.equal((await estimate()).estimated_net,15000);
 await db.exec("update attendance set status='Absent' where attendance_date='2026-09-04'");assert.equal((await estimate()).estimated_net,13000);
 await db.exec("delete from attendance;insert into attendance(staff_id,outlet_id,attendance_date,shift_start,punch_time,status) select 1,1,d,'11:00','11:00',case when d<='2026-10-04' then 'Absent' else 'Present' end from generate_series('2026-10-01'::date,'2026-10-31'::date,interval '1 day') d");
 assert.equal((await estimate('2026-10-01','2026-10-31')).estimated_net,13500);
 await db.exec('delete from attendance');const empty=await estimate();assert.equal(empty.unrecorded_days,30);assert.equal(empty.holiday_duty_allowance,0);
});
test('approved full leave counts without punches and punch conflicts need review',async()=>{
 await db.exec("insert into leave_requests(staff_id,outlet_id,leave_type,start_date,end_date,status) values(1,1,'LEAVE','2026-09-01','2026-09-03','APPROVED')");
 const e=await estimate('2026-09-01','2026-09-03');assert.equal(e.leave_days,3);assert.equal(e.unrecorded_days,0);
 await attendance('2026-09-01');const conflict=await estimate('2026-09-01','2026-09-03');assert.equal(conflict.needs_review_days,1);assert.equal(conflict.data_complete,false);
});
test('late tiers are per day and approved half-day leave waives lateness',async()=>{
 await attendance();await db.exec("update attendance set late_mins=16,punch_time='11:16' where attendance_date<='2026-09-03'");
 const late=await estimate();assert.equal(late.deductible_late_hours,1.5);assert.equal(late.late_deduction,63);
 await db.exec("update attendance set late_mins=240,punch_time='15:00' where attendance_date='2026-09-01';insert into leave_requests(staff_id,outlet_id,leave_type,start_date,end_date,status) values(1,1,'HALF_DAY','2026-09-01','2026-09-01','APPROVED')");
 const half=await estimate();assert.equal(half.half_days,1);assert.equal(half.half_day_deduction,250);assert.equal(half.late_mins,32);assert.equal(half.deductible_late_hours,1);
 const day=(await rows("select * from get_attendance_calendar(1,1,'2026-09-01','2026-09-01')"))[0];assert.equal(day.status,'HALF_DAY');assert.equal(day.late_mins,0);
 await db.exec("delete from attendance where attendance_date='2026-09-01'");const missing=await estimate();assert.equal(missing.half_days,0);assert.equal(missing.unrecorded_days,1);
});
test('EMI starts in the rolling period containing payout and carries missed installments',async()=>{
 await db.exec(`update staff set joining_date='2025-01-07' where id=1;insert into staff_advance_requests(id,staff_id,outlet_id,amount,installments,status,business_date,paid_at,first_period) values('${advance}',1,1,1000,2,'PAID','2026-09-28','2026-09-28','2026-09-01')`);
 assert.equal((await estimate('2026-09-01','2026-09-05')).advance_installment_due,0);assert.equal((await estimate('2026-09-07','2026-10-06')).advance_installment_due,500);assert.equal((await estimate('2026-10-07','2026-11-06')).advance_installment_due,1000);
});
test('draft subtracts EMI without posting and finalization is idempotent',async()=>{
 await db.exec(`insert into staff_advance_requests(id,staff_id,outlet_id,amount,installments,status,business_date,paid_at,first_period) values('${advance}',1,1,1000,2,'PAID','2026-09-02','2026-09-02','2026-09-01')`);
 const d=details({advance_installment_deduction:500});assert.equal(Number((await payroll(d,'SAVE_DRAFT')).net_salary),14500);assert.equal((await rows('select * from staff_advance_deductions')).length,0);
 assert.equal(Number((await payroll(d)).net_salary),14500);await payroll(d);assert.equal((await rows('select * from staff_advance_deductions')).length,1);assert.equal(Number((await rows('select amount from staff_advance_deductions'))[0].amount),500);
 await assert.rejects(payroll(details({present_days:26,advance_installment_deduction:500}),'FINALIZE','2026-09-29'),/dates cannot be changed/);
});
async function transfer(id=1,date='2026-09-20'){
 await db.exec(`insert into extra_time_requests(id,requested_at,request_group) values(${id},'${date}',gen_random_uuid());insert into extra_time_dispatches(id,request_id,prepared_by) values(${id},${id},'${staff}');insert into extra_time_payments(id,dispatch_id,staff_user_id,category,amount,status) values(${id},${id},'${staff}','CHICKEN_PATTY',100,'READY');`);
}
test('posted transfers cannot lose their dates, selection or amount',async()=>{
 await transfer();const d=details({extra_earnings:[{label:'Transfer',amount:100,transfer_id:1}],included_transfer_ids:[1]});await payroll(d);
 await assert.rejects(payroll({...d,present_days:12},'FINALIZE','2026-09-15'),/dates cannot be changed/);
 await restart();await transfer();await payroll(d);await assert.rejects(payroll(details()),/Posted transfer earnings/);
 await restart();await transfer();await payroll(d);await assert.rejects(payroll(details({extra_earnings:[{label:'Transfer',amount:50,transfer_id:1}],included_transfer_ids:[1]})),/Posted transfer amounts are locked/);
});
test('a first-posting transfer override is reflected in the paid ledger and then locked',async()=>{
 await transfer();const d=details({extra_earnings:[{label:'Transfer adjustment',amount:150,transfer_id:1}],included_transfer_ids:[1]});const saved=await payroll(d);assert.equal(Number(saved.net_salary),15150);
 const entry=(await rows('select * from extra_time_payments where id=1'))[0];assert.equal(Number(entry.amount),150);assert.equal(entry.salary_record_id,saved.id);assert.equal(entry.status,'PAID');
 await payroll(d);assert.equal(Number((await rows('select amount from extra_time_payments where id=1'))[0].amount),150);
});
test('transfer reads paginate within the period and survive Transfers revocation',async()=>{
 await db.exec(`insert into extra_time_requests(id,requested_at,request_group) select x,case when x<=300 then '2026-08-20'::timestamptz else '2026-09-20'::timestamptz end,gen_random_uuid() from generate_series(1,605) x;
 insert into extra_time_dispatches(id,request_id,prepared_by) select id,id,'${staff}' from extra_time_requests;
 insert into extra_time_payments(id,dispatch_id,staff_user_id,category,amount,status) select id,id,'${staff}','CHICKEN_PATTY',100,'READY' from extra_time_requests;`);
 await actor(staff);const pages=[];const client={rpc:async(name,args)=>{pages.push(args.p_after_id);try{return {data:(await rows('select get_salary_transfer_payments($1,$2,$3,$4) value',[args.p_staff_id,args.p_start,args.p_end,args.p_after_id]))[0].value};}catch(error){return {error};}}};
 const data=await loadSalaryTransfers(client,1,'2026-09-01','2026-09-30');assert.equal(data.length,305);assert.equal(data[0].id,301);assert.deepEqual(pages,[0,600]);await assert.rejects(rows("select get_salary_transfer_payments(2,'2026-09-01','2026-09-30')"),/own salary/);
});
test('blank effective date is normalized and legacy status saves do not need joining dates',async()=>{
 await rows('select owner_save_staff_profile(1,$1,$2)',[JSON.stringify(snapshot),JSON.stringify({...snapshot,status_effective_from:''})]);assert.equal((await rows('select status_effective_from from staff where id=1'))[0].status_effective_from,null);
 await db.exec("update staff set joining_date=null,active=false,employment_status='INACTIVE' where id=1;update users set active=false where staff_id=1");await rows("select owner_set_staff_status(1,'ACTIVE','2026-10-05',null)");assert.equal((await rows('select active from users where staff_id=1'))[0].active,true);assert.equal((await rows('select joining_date from staff where id=1'))[0].joining_date,null);
});
test('profile saves atomically update salary/access and reject stale editors',async()=>{
 const changes={...snapshot,basic_salary:16000,permissions:{module_access:{summary:false}},status_effective_from:'2026-09-01'};
 await rows('select owner_save_staff_profile(1,$1,$2)',[JSON.stringify(snapshot),JSON.stringify(changes)]);assert.equal(Number((await rows('select basic_salary from staff where id=1'))[0].basic_salary),16000);
 await assert.rejects(rows('select owner_save_staff_profile(1,$1,$2)',[JSON.stringify(snapshot),JSON.stringify(changes)]),/profile changed/);
});
test('invalid profile access rolls back salary and direct legacy saves are blocked',async()=>{
 await db.exec('savepoint invalid_profile');await assert.rejects(rows('select owner_save_staff_profile(1,$1,$2)',[JSON.stringify(snapshot),JSON.stringify({...snapshot,basic_salary:16000,permissions:{module_access:{salary:false}}})]),/five supported access domains/);
 await db.exec('rollback to savepoint invalid_profile');assert.equal(Number((await rows('select basic_salary from staff where id=1'))[0].basic_salary),15000);assert.equal((await rows('select permissions from users where staff_id=1'))[0].permissions.module_access.summary,true);
 await db.exec('set local role authenticated');await assert.rejects(rows("select owner_update_staff(1,'Employee',1,'Staff',16000,'2025-01-01',true,'{}',null)"),/permission denied/);
});
test('petty advances, overtime, late tiers, half days and loan override reconcile together',async()=>{
 await attendance();await db.exec("update attendance set status='Absent' where attendance_date<='2026-09-03';update attendance set late_mins=16 where attendance_date between '2026-09-04' and '2026-09-06';update attendance set half_day=true where attendance_date='2026-09-07';insert into staff_payments(staff_id,business_date,payment_type,amount) values(1,'2026-09-10','Petty Advance',500),(1,'2026-09-10','Loan Deduction',200)");
 const e=await estimate();assert.equal(e.advance_deduction,500);assert.equal(e.loan_deduction,200);
 const saved=await payroll(details({half_days:1,advance_deduction:e.advance_deduction,loan_prev_balance:1000,loan_deduct_this_month:200,loan_remaining:650,loan_remaining_manual:true,ot_credit:600,extra_earnings:[{label:'Bonus',amount:100}],extra_deductions:[{label:'Other',amount:50}]}));assert.equal(Number(saved.net_salary),14637);assert.equal(Number(saved.loan_remaining),650);assert.equal(saved.payroll_details.late_hours,1.5);assert.equal(saved.payroll_details.half_day_deduction,250);
});
test('moving a staff profile does not duplicate its existing payroll or transfer ledger',async()=>{
 await transfer();const d=details({extra_earnings:[{label:'Transfer',amount:100,transfer_id:1}],included_transfer_ids:[1]});const original=await payroll(d);await db.exec('update staff set outlet_id=2 where id=1;update users set outlet_id=2 where staff_id=1');
 const revised=await payroll(d);assert.equal(revised.id,original.id);assert.equal(revised.outlet_id,1);assert.equal((await rows('select * from salary_records where staff_id=1')).length,1);assert.equal((await rows('select salary_record_id from extra_time_payments where id=1'))[0].salary_record_id,original.id);
});
test('unused paid offs produce holiday duty and scheduled offs are recorded',async()=>{
 await attendance();for(let off=0;off<=3;off++){await db.exec(`update attendance set status=case when extract(day from attendance_date)<=${off} then 'Absent' else 'Present' end`);const e=await estimate();assert.equal(e.holiday_duty_days,3-off);assert.equal(e.estimated_net,15000+(3-off)*500);}
 await db.exec("delete from attendance where attendance_date='2026-09-04';insert into staff_shifts(staff_id,outlet_id,shift_date,shift_type) values(1,1,'2026-09-04','OFF')");const e=await estimate();assert.equal(e.leave_days,1);assert.equal(e.data_complete,true);
});
test('half-day waivers apply only on the approved date and legacy finalizers cannot bypass rules',async()=>{
 await attendance();await db.exec("update attendance set half_day=true,late_mins=240 where attendance_date='2026-09-01'");const e=await estimate();assert.equal(e.half_day_deduction,250);assert.equal(e.deductible_late_hours,4);assert.equal(e.late_deduction,167);
 await actor(staff);await db.exec('set local role authenticated');await assert.rejects(rows("select finalize_salary_record_v2(1,'2026-09-01','2026-09-30','2026-10-10',$1)",[admin]),/permission denied/);
});
test('manager payout works with Summary revoked and freezes the EMI anchor against profile edits',async()=>{
 await db.exec(`update users set role='Manager',permissions='{"module_access":{"summary":false}}' where id='${other}';create or replace function public.get_effective_business_day(integer,timestamptz) returns date language sql stable as $$select '2026-09-04'::date$$;insert into daily_summaries(id,outlet_id,business_date,is_closed,opening_cash_actual,physical_cash) values('SUM',1,'2026-09-04',false,2000,2000);insert into staff_advance_requests(id,staff_id,outlet_id,amount,installments,status) values('${advance}',1,1,1000,2,'APPROVED');`);
 await actor(other);await db.exec('set local role authenticated');const payout=(await rows('select * from pay_staff_advance($1,$2)',[advance,'Cash']))[0];assert.equal(payout.first_period.toISOString().slice(0,10),'2026-09-01');
 await db.exec('reset role');await actor();assert.equal(Number((await rows("select expected_cash from daily_summaries where id='SUM'"))[0].expected_cash),1000);await db.exec("update staff set joining_date='2025-01-07' where id=1");assert.equal((await estimate('2026-09-07','2026-10-06')).advance_installment_due,500);
});
