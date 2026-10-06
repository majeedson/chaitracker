import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {JSDOM} from 'jsdom';
import {creditTotals,renderVendorCredits} from '../src/vendorCredits.js';
import {hasModuleAccess} from '../src/moduleAccess.js';
let db;let seq=0;
const admin='00000000-0000-0000-0000-000000000001',staff='00000000-0000-0000-0000-000000000002';
const actor=id=>db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
const read=async(outlet=1,month=null)=>(await db.query('select public.get_vendor_credits($1,$2) data',[outlet,month])).rows[0].data;
const id=()=>`10000000-0000-0000-0000-${String(++seq).padStart(12,'0')}`;
const action=async(type,payload={},outlet=1)=>{const p={outlet_id:outlet,request_id:id(),expected_revision:(await read(outlet)).revision,note:'Verified supplier statement',...payload};return (await db.query('select public.manage_vendor_credits($1,$2) result',[type,JSON.stringify(p)])).rows[0].result;};
const closing=(month='2026-09-01',balances=[{vendor_id:1,balance:1000},{vendor_id:2,balance:-300}])=>action('CLOSE',{month,balances});
const movement=(overrides={})=>action('MOVEMENT',{vendor_id:1,business_date:'2026-10-05',amount:100,kind:'PAY_VENDOR',...overrides});
const rejects=async(fn,pattern)=>{await db.exec('savepoint expected_failure');try{await assert.rejects(fn(),pattern);}finally{await db.exec('rollback to expected_failure;release savepoint expected_failure');}};
before(async()=>{
 db=new PGlite();await db.exec(await fs.readFile(new URL('fixtures/payroll-schema.sql',import.meta.url),'utf8'));
 await db.exec(`create table public.vendors(id integer primary key,name varchar);insert into vendors values(1,'Kini'),(2,'Provit');insert into outlets(id,name) values(1,'Teapot'),(2,'Chai');
 insert into users(id,auth_user_id,name,access_class,active) values('${admin}','${admin}','Owner','ADMIN',true),('${staff}','${staff}','Manager','STAFF',true);
 create or replace function public.get_effective_business_day(integer,timestamptz) returns date language sql stable as $$select date '2026-10-06'$$;`);
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261006053554_vendor_credits_b138.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());beforeEach(async()=>{await db.exec('begin');await actor(admin);});afterEach(async()=>db.exec('rollback;reset role'));
test('unknown supplier balances stay unavailable; all vendors and cafés appear without netting debts against credits',async()=>{
 const initial=await read();assert.equal(initial.accounts.length,2);assert.ok(initial.accounts.every(a=>a.balance===null));assert.equal(creditTotals(initial.accounts).toPay,null);
 await closing();const data=await read(null);assert.equal(data.accounts.length,4);const t=creditTotals(data.accounts);assert.equal(t.toPay,1000);assert.equal(t.toReceive,300);assert.equal(t.unknown,2);
 assert.ok(data.accounts.filter(a=>a.outlet_id===2).every(a=>a.balance===null));
});
test('monthly confirmed balances carry forward with payment and receipt effects; receipts do not create café sales',async()=>{
 await closing();await movement();await movement({vendor_id:2,kind:'RECEIVE_VENDOR',amount:50});
 const d=await read();assert.equal(d.accounts.find(a=>a.vendor_id===1).balance,900);assert.equal(d.accounts.find(a=>a.vendor_id===2).balance,-250);
 const september=await read(1,'2026-09-01');assert.equal(september.accounts[0].balance,1000);assert.equal(september.movements.length,0);
 assert.equal((await db.query('select count(*) n from daily_summaries')).rows[0].n,0);
});
test('closing requires all vendor balances once, completed months only, and rejects older/closed periods atomically',async()=>{
 await rejects(()=>closing('2026-09-01',[{vendor_id:1,balance:100}]),/every vendor exactly once/);
 await rejects(()=>closing('2026-10-01'),/completed calendar month/);
 await closing();await rejects(()=>closing(),/already closed/);await rejects(()=>closing('2026-08-01'),/older than/);
 await rejects(()=>movement({business_date:'2026-09-30'}),/closed period/);await rejects(()=>movement({business_date:'2026-10-07'}),/future/);
 assert.equal((await read()).revision,1);
});
test('retries are idempotent; concurrent edits and reused request IDs with different data are rejected',async()=>{
 await closing();const revision=(await read()).revision,request=id(),p={outlet_id:1,request_id:request,expected_revision:revision,note:'Bank payment confirmed',vendor_id:1,business_date:'2026-10-05',amount:100,kind:'PAY_VENDOR'};
 const call=p=>db.query('select public.manage_vendor_credits($1,$2)',['MOVEMENT',JSON.stringify(p)]);
 await call(p);await call(p);assert.equal((await read()).movements.length,1);
 await rejects(()=>call({...p,amount:200}),/Request ID already used/);
 await rejects(()=>call({...p,request_id:id()}),/Credits changed/);assert.equal((await read()).accounts[0].balance,900);
});
test('corrections retain audit history, closed movements are locked and only the latest closing can reopen',async()=>{
 await movement({business_date:'2026-09-25'});await closing('2026-08-01');await closing();
 const september=await read(1,'2026-09-01'),old=september.movements[0];await rejects(()=>action('VOID',{movement_id:old.id}),/Reopen the closed period/);
 await rejects(()=>action('REOPEN',{month:'2026-08-01'}),/latest closed month/);
 const m=await movement();await action('VOID',{movement_id:m.movement_id});assert.equal((await read()).accounts[0].balance,1000);assert.ok((await read()).movements[0].voided_at);
 await action('REOPEN',{month:'2026-09-01'});await action('VOID',{movement_id:old.id});await closing('2026-09-01',[{vendor_id:1,balance:700},{vendor_id:2,balance:0}]);
 assert.equal((await read()).accounts[0].balance,700);const audit=(await db.query("select before_record from private.vendor_credit_audit where action='REOPEN'")).rows[0].before_record;assert.equal(audit.state.status,'CLOSED');assert.equal(audit.balances.length,2);
});
test('only active administrators can read/write credit accounts; private tables are inaccessible to app roles',async()=>{
 await actor(staff);await rejects(()=>read(),/Admin access required/);await rejects(()=>action('MOVEMENT'),/Admin access required/);
 await actor('');await rejects(()=>read(),/Admin access required/);await actor(admin);await db.exec(`update users set active=false where id='${admin}'`);await rejects(()=>read(),/Admin access required/);
 await db.exec('set role authenticated');await rejects(()=>db.query('select * from private.vendor_credit_balances'),/permission denied/);await db.exec('set role anon');await rejects(()=>read(),/permission denied/);
 assert.equal(hasModuleAccess({access_class:'ADMIN'},'credits'),true);assert.equal(hasModuleAccess({access_class:'STAFF',role:'Manager',permissions:{module_access:{credits:true}}},'credits'),false);
});
test('Credits UI filters vendors, requires a confirmed closing and submits vendor-specific payment directions',async()=>{
 await closing();const d=await read(),dom=new JSDOM('<main></main>'),view=dom.window.document.querySelector('main'),calls=[];
 const client={rpc:async(name,args)=>{calls.push({name,args});return {data:name==='get_vendor_credits'?args.p_month==='2026-08-01'?{...d,month:'2026-08-01',month_states:[]}:d:{action:'MOVEMENT'}};}};
 await renderVendorCredits(view,client,{access_class:'ADMIN',context_outlet_id:1});assert.equal(view.querySelectorAll('#creditVendorRows tr').length,2);
 view.querySelector('[data-credit-tab="receive"]').click();assert.equal(view.querySelectorAll('#creditVendorRows tr').length,1);assert.match(view.querySelector('#creditVendorRows').textContent,/Provit/);
 view.querySelector('#creditOpenMovement').click();const form=view.querySelector('#creditMovementForm');form.elements.vendor_id.value='2';form.elements.kind.value='RECEIVE_VENDOR';form.elements.amount.value='50';form.elements.note.value='Vendor refund';form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
 await new Promise(resolve=>setTimeout(resolve,0));const write=calls.find(c=>c.name==='manage_vendor_credits');assert.equal(write.args.p_payload.vendor_id,2);assert.equal(write.args.p_payload.kind,'RECEIVE_VENDOR');assert.equal(write.args.p_payload.expected_revision,1);
 view.querySelector('#creditOpenClosing').click();await new Promise(resolve=>setTimeout(resolve,0));assert.match(view.querySelector('#creditClosingPanel').textContent,/is closed/);
 view.querySelector('#creditClosingMonth').value='2026-08';view.querySelector('#creditClosingMonth').dispatchEvent(new dom.window.Event('change'));await new Promise(resolve=>setTimeout(resolve,0));const closingForm=view.querySelector('#creditClosingForm');assert.equal(closingForm.elements.confirmed.required,true);assert.equal(closingForm.elements.amount_1.required,true);
 const beforeWrites=calls.filter(c=>c.name==='manage_vendor_credits').length;closingForm.elements.note.value='Verified';closingForm.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await new Promise(resolve=>setTimeout(resolve,0));assert.equal(calls.filter(c=>c.name==='manage_vendor_credits').length,beforeWrites);
 dom.window.close();
});
