import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {JSDOM} from 'jsdom';
import {creditTotals,renderVendorCredits} from '../src/vendorCredits.js';
let db,seq=0;
const admin='00000000-0000-0000-0000-000000000001',staff='00000000-0000-0000-0000-000000000002';
const actor=id=>db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
const read=async(outlet=1,month=null)=>(await db.query('select public.get_customer_credits($1,$2) data',[outlet,month])).rows[0].data;
const id=()=> '20000000-0000-0000-0000-'+String(++seq).padStart(12,'0');
const action=async(type,payload={},outlet=1)=>{
 const p={outlet_id:outlet,request_id:id(),expected_revision:(await read(outlet)).revision,note:'Confirmed customer account',...payload};
 return (await db.query('select public.manage_customer_credits($1,$2) result',[type,JSON.stringify(p)])).rows[0].result;
};
const customer=async(overrides={},outlet=1)=>(await action('CUSTOMER',{name:'Ankit',phone:'9876543210',amount:500,...overrides},outlet)).customer_id;
const movement=(customer_id,overrides={})=>action('MOVEMENT',{customer_id,business_date:'2026-10-06',kind:'RECEIVE_CUSTOMER',amount:100,...overrides});
const rejects=async(fn,pattern)=>{await db.exec('savepoint expected_failure');try{await assert.rejects(fn(),pattern);}finally{await db.exec('rollback to expected_failure;release savepoint expected_failure');}};
before(async()=>{
 db=new PGlite();await db.exec(await fs.readFile(new URL('fixtures/payroll-schema.sql',import.meta.url),'utf8'));
 await db.exec("insert into outlets(id,name) values(1,'Teapot'),(2,'Chai');"+
 "insert into users(id,auth_user_id,name,access_class,active) values('"+admin+"','"+admin+"','Owner','ADMIN',true),('"+staff+"','"+staff+"','Manager','STAFF',true);"+
 "create or replace function public.get_effective_business_day(integer,timestamptz) returns date language sql stable as $$select date '2026-10-06'$$;");
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261006125345_customer_credits_b141.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());beforeEach(async()=>{await db.exec('begin');await actor(admin);});afterEach(async()=>db.exec('rollback;reset role'));
test('customer name, phone and opening credit are stored separately; collections reduce receivables without creating sales',async()=>{
 const c=await customer();const initial=await read();assert.equal(initial.accounts[0].customer_name,'Ankit');assert.equal(initial.accounts[0].phone,'9876543210');assert.equal(initial.accounts[0].balance,500);
 await movement(c);await movement(c,{kind:'ADD_CREDIT',amount:50});
 const data=await read();assert.equal(data.accounts[0].balance,450);assert.equal(data.movements.length,3);
 assert.equal(creditTotals([{balance:-900},{balance:700}],data.accounts).toReceive,450);
 assert.equal((await db.query('select count(*) n from daily_summaries')).rows[0].n,0);
});
test('empty customer ledger is zero; phone validation and normalized duplicates are enforced per café',async()=>{
 assert.equal(creditTotals([],[]).toReceive,0);const c=await customer({amount:0});assert.equal((await read()).accounts[0].balance,0);
 for(const bad of [{name:'A'},{phone:'123'},{phone:'1234567abc'},{phone:'+'},{phone:'1234567890123456'},{amount:-1}])await rejects(()=>customer(bad),/name and valid phone|opening credit/);
 await rejects(()=>customer({phone:'+98 765-43210'}),/duplicate key/);
 await customer({},2);assert.equal((await read(null)).accounts.length,2);
 await action('EDIT_CUSTOMER',{customer_id:c,name:'Ankit Kumar',phone:'9123456789'});
 assert.equal((await read()).customers[0].name,'Ankit Kumar');assert.equal((await read()).accounts[0].balance,0);
});
test('cannot collect more than owed, backdate before customer creation, use future dates, or write another café customer',async()=>{
 const c=await customer();await rejects(()=>movement(c,{amount:501}),/exceeds customer credit/);
 await rejects(()=>movement(c,{business_date:'2026-10-05'}),/Movement date/);
 await rejects(()=>movement(c,{business_date:'2026-10-07'}),/Movement date/);
 await rejects(()=>movement(c,{amount:0}),/Invalid movement/);await rejects(()=>movement(c,{kind:'PAY_VENDOR'}),/Invalid movement/);
 await rejects(()=>action('MOVEMENT',{customer_id:c,business_date:'2026-10-06',kind:'ADD_CREDIT',amount:10},2),/Customer not found/);
 await rejects(()=>action('EDIT_CUSTOMER',{customer_id:c,name:'Other café',phone:'9111111111'},2),/Customer not found/);
 assert.equal((await read(2)).accounts.length,0);assert.equal((await read()).accounts[0].balance,500);
});
test('idempotent retries preserve one customer and movement; stale revisions and changed request payloads are rejected',async()=>{
 const request_id=id(),p={outlet_id:1,request_id,expected_revision:0,name:'Ankit',phone:'9876543210',amount:300,note:'Opening customer credit'};
 const call=p=>db.query("select public.manage_customer_credits('CUSTOMER',$1) result",[JSON.stringify(p)]);
 const first=(await call(p)).rows[0].result;assert.deepEqual((await call(p)).rows[0].result,first);
 assert.equal((await read()).revision,1);assert.equal((await read()).movements.length,1);
 await rejects(()=>call({...p,name:'Changed'}),/Request ID already used/);
 await rejects(()=>action('CUSTOMER',{expected_revision:0,name:'Other',phone:'9111111111'}),/Credits changed/);
});
test('corrections retain the audit trail and cannot remove credit supporting an existing collection',async()=>{
 const c=await customer();const paid=await movement(c);
 await rejects(()=>action('VOID',{movement_id:c}),/exceeds customer credit/);
 await action('VOID',{movement_id:paid.movement_id});
 assert.equal((await read()).accounts[0].balance,500);
 const audit=(await db.query("select before_record from private.customer_credit_audit where action='VOID'")).rows[0].before_record;
 assert.equal(audit.kind,'RECEIVE_CUSTOMER');assert.equal((await read()).movements.filter(m=>m.voided_at).length,1);
 await action('VOID',{movement_id:c});assert.equal((await read()).accounts[0].balance,0);
});
test('closing applies to customers existing at month end, keeps outlets separate and carries later credit/payment forward',async()=>{
 const c=await customer({amount:500});await db.query("update private.credit_customers set created_business_date='2026-09-01' where id=$1",[c]);
 await action('CLOSE',{month:'2026-09-01',balances:[{customer_id:c,balance:200}]});
 assert.equal((await read()).accounts[0].balance,700);assert.equal((await read(1,'2026-09-01')).accounts[0].balance,200);
 await movement(c,{amount:50});assert.equal((await read()).accounts[0].balance,650);
 await rejects(()=>movement(c,{business_date:'2026-09-25'}),/Movement date/);
 await action('REOPEN',{month:'2026-09-01'});
 await action('CLOSE',{month:'2026-09-01',balances:[{customer_id:c,balance:100}]});
 assert.equal((await read()).accounts[0].balance,550);
 const newCustomer=await customer({name:'New customer',phone:'9111111111',amount:0});
 assert.equal((await read(1,'2026-09-01')).accounts.length,1);
 await rejects(()=>action('REOPEN',{month:'2026-08-01'}),/latest closed/);
 assert.notEqual(c,newCustomer);assert.equal((await read(2)).accounts.length,0);
});
test('month closing requires every eligible customer once; reopening retains a provisional balance and re-closing validates payments',async()=>{
 const c=await customer({amount:0});await db.query("update private.credit_customers set created_business_date='2026-09-01' where id=$1",[c]);
 for(const balances of [[],[{customer_id:c,balance:-1}],[{customer_id:c,balance:2},{customer_id:c,balance:3}],[{customer_id:id(),balance:0}]])await rejects(()=>action('CLOSE',{month:'2026-09-01',balances}),/every customer/);
 await action('CLOSE',{month:'2026-09-01',balances:[{customer_id:c,balance:100}]});await movement(c,{amount:90});
 await action('REOPEN',{month:'2026-09-01'});assert.equal((await read()).accounts[0].balance,10);
 await rejects(()=>action('CLOSE',{month:'2026-09-01',balances:[{customer_id:c,balance:80}]}),/exceeds customer credit/);
 await action('CLOSE',{month:'2026-09-01',balances:[{customer_id:c,balance:150}]});assert.equal((await read()).accounts[0].balance,60);
});
test('backdated collection cannot be supported by credit entered on a later day',async()=>{
 const c=await customer({amount:0});await db.query("update private.credit_customers set created_business_date='2026-10-01' where id=$1",[c]);
 await movement(c,{kind:'ADD_CREDIT',amount:200,business_date:'2026-10-06'});
 await rejects(()=>movement(c,{amount:100,business_date:'2026-10-05'}),/exceeds customer credit/);
 assert.equal((await read()).accounts[0].balance,200);
});
test('active administrators only; direct tables and private validation helper stay inaccessible',async()=>{
 await actor(staff);await rejects(()=>read(),/Admin access/);await rejects(()=>db.query("select public.manage_customer_credits('CUSTOMER','{}')"),/Admin access/);
 await actor('');await rejects(()=>read(),/Admin access/);
 await actor(admin);await db.query('update users set active=false where id=$1',[admin]);await rejects(()=>read(),/Admin access/);
 await db.query('update users set active=true where id=$1',[admin]);await db.exec('set role authenticated');assert.equal((await read()).accounts.length,0);
 for(const table of ['credit_customers','customer_credit_months','customer_credit_balances','customer_credit_movements','customer_credit_audit'])await rejects(()=>db.query('select * from private.'+table),/permission denied/);
 await rejects(()=>db.query('select private.check_customer_credit_balance(1,$1)',[id()]),/permission denied/);
 await db.exec('set role anon');await rejects(()=>read(),/permission denied/);
});
test('customer tab collects name and phone, searches phone, edits details and sends customer payments',async()=>{
 const c=await customer(),d=await read(),dom=new JSDOM('<main></main>'),view=dom.window.document.querySelector('main'),calls=[];
 const vendorData={...d,vendors:[{id:1,name:'Supplier'}],accounts:[{vendor_id:1,vendor_name:'Supplier',outlet_id:1,outlet_name:'Teapot',balance:-999}],movements:[]};
 const client={rpc:async(name,args)=>{calls.push({name,args});return {data:name==='get_vendor_credits'?vendorData:name==='get_customer_credits'?d:{action:args.p_action}};}};
 const profile={access_class:'ADMIN',context_outlet_id:1};await renderVendorCredits(view,client,profile);
 view.querySelector('[data-credit-tab="receive"]').click();await new Promise(r=>setTimeout(r,0));
 assert.equal(profile._creditsMode,'receive');assert.match(view.querySelector('#creditAccountRows').textContent,/Ankit/);assert.doesNotMatch(view.querySelector('#creditAccountRows').textContent,/Supplier/);
 assert.equal(view.querySelector('.credit-phone').getAttribute('href'),'tel:9876543210');
 const search=view.querySelector('#creditAccountSearch');search.value='543210';search.dispatchEvent(new dom.window.Event('input'));assert.equal(view.querySelectorAll('.credit-account').length,1);
 view.querySelector('#creditOpenCustomer').click();let cf=view.querySelector('#creditCustomerForm');
 assert.equal(cf.elements.namedItem('name').required,true);assert.equal(cf.elements.phone.required,true);assert.equal(cf.elements.phone.type,'tel');
 cf.elements.namedItem('name').value='New customer';cf.elements.phone.value='9111111111';cf.elements.amount.value='250';
 cf.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,0));
 const create=calls.find(c=>c.name==='manage_customer_credits');assert.equal(create.args.p_action,'CUSTOMER');assert.equal(create.args.p_payload.name,'New customer');assert.equal(create.args.p_payload.phone,'9111111111');assert.equal(create.args.p_payload.amount,250);
 view.querySelector('[data-credit-edit]').click();cf=view.querySelector('#creditCustomerForm');assert.equal(cf.elements.namedItem('name').value,'Ankit');cf.elements.namedItem('name').value='Ankit Kumar';
 cf.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,0));
 assert.equal(calls.find(c=>c.args.p_action==='EDIT_CUSTOMER').args.p_payload.customer_id,c);
 view.querySelector('#creditOpenMovement').click();const mf=view.querySelector('#creditMovementForm');mf.elements.customer_id.value=c;mf.elements.kind.value='RECEIVE_CUSTOMER';mf.elements.amount.value='100';mf.elements.note.value='UPI payment';
 mf.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,0));
 const payment=calls.find(c=>c.args.p_action==='MOVEMENT');assert.equal(payment.name,'manage_customer_credits');assert.equal(payment.args.p_payload.customer_id,c);assert.equal(payment.args.p_payload.kind,'RECEIVE_CUSTOMER');
 assert.equal(view.querySelectorAll('table').length,0);dom.window.close();
});
