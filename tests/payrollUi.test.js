import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import * as rules from '../src/payrollRules.js';
import * as access from '../src/moduleAccess.js';
import {loadSalaryTransfers} from '../src/payrollData.js';
import {onboardingDetailsHtml,bindProfileDocuments,renderMyProfile} from '../src/employeeProfiles.js';
const source=(await fs.readFile(new URL('../src/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export async function renderApp','async function renderApp').replaceAll('import.meta.env','({})');
const person={id:2,name:'Selected employee',outlet_id:2,basic_salary:15000,joining_date:'2025-01-31',active:true,employment_status:'ACTIVE',notes:null,status_effective_from:null,status_note:null,users:{id:'employee',role:'Staff',permissions:{module_access:{summary:true,'extra-time':false}}}};
const owner={id:'owner',access_class:'ADMIN',role:'Owner',context_outlet_id:1};
const est={basic_salary:15000,period_days:30,present_equivalent_days:27,absent_days:3,leave_days:0,half_days:0,late_mins:48,deductible_late_hours:1.5,late_deduction:63,half_day_deduction:0,holiday_duty_days:0,data_complete:true,advance_deduction:0,advance_installment_deduction:500};
function harness({staffRows=[structuredClone(person)],current=null,saveError=null,emptyActive=false,estimate=est,userRow={staff_id:null,outlet_id:1},employeeProfile=null,peopleError=null}={}) {
 const dom=new JSDOM('<section id="view"></section>',{url:'https://example.test'}),calls=[];
 class Clock extends Date {constructor(...args){super(...(args.length?args:['2026-10-02T12:00:00Z']));}}
 const context=vm.createContext({...rules,...access,loadSalaryTransfers,onboardingDetailsHtml,bindProfileDocuments,renderMyProfile,deleteUserDialog:async()=>null,document:dom.window.document,CustomEvent:dom.window.CustomEvent,Intl,Date:Clock,Map,Set,console,setTimeout,clearTimeout,confirm:()=>true,loadStaffAvatars:async()=>new Map(),staffAvatar:()=>'',bindAvatarImages:()=>{},refreshStaffAvatarElements:()=>{},editProfilePhoto:async()=>false});
 vm.runInContext(source,context);
 const client={from(table){const filters=[];const result=()=>{
  if(table==='users'&&peopleError)return {data:null,error:{message:peopleError}};
  let data=table==='staff'?staffRows:table==='outlets'?[{id:1,name:'Current café'},{id:2,name:'Selected café'}]:table==='users'?[userRow]:[];
  if(table==='staff'&&filters.some(([k,v])=>k==='active'&&v===true)&&emptyActive)data=[];
  for(const [key,value] of filters)data=data.filter(row=>row[key]===value||table==='users');return {data};
 };const query={select(){return query;},eq(k,v){filters.push([k,v]);return query;},order(){return query;},limit(){return query;},in(){return query;},maybeSingle:async()=>({data:result().data[0]||null}),then(resolve,reject){return Promise.resolve(result()).then(resolve,reject);}};return query;},
 async rpc(name,args){calls.push({name,args});if(name==='get_employee_profile_data')return {data:employeeProfile};if(name==='get_salary_estimate_v2')return {data:{...estimate}};if(name==='get_salary_payroll_context')return {data:{current,prior:null}};if(name==='owner_save_staff_profile')return saveError?{error:{message:saveError}}:{data:{staff_id:args.p_staff_id}};return {data:[]};}};
 return {dom,context,client,calls,view:dom.window.document.querySelector('#view')};
}
test('People query failures display a retry action instead of leaving Loading',async()=>{
 const h=harness({peopleError:'permission denied for table users'});h.view.innerHTML='<div class="loading">Loading…</div>';await h.context.renderPeople(h.view,h.client,owner);
 assert.match(h.view.textContent,/Unable to load People/);assert.match(h.view.textContent,/permission denied/);assert.doesNotMatch(h.view.textContent,/Loading/);assert.equal(typeof h.view.querySelector('#retryPeople').onclick,'function');h.dom.window.close();
});
test('administrator controls have a message target for validation errors',async()=>{
 const h=harness({userRow:{id:'admin',name:'Admin',active:true,is_super_user:false,access_class:'ADMIN'}});await h.context.renderPeople(h.view,h.client,{...owner,is_super_user:true});await h.view.querySelector('.admin-pin-update').onclick();assert.match(h.view.querySelector('#adminMessage').textContent,/Enter a 4–8 digit/);h.dom.window.close();
});
test('staff Access checkbox saves visibility immediately and reverts on error',async()=>{
 const h=harness();await h.context.renderPeople(h.view,h.client,{...owner,context_outlet_id:null});await h.view.querySelector('.manage-staff').onclick();const input=h.view.querySelector('#editLoginVisible');assert.equal(input.checked,true);input.checked=false;await input.onchange();assert.equal(h.calls.find(x=>x.name==='admin_set_login_visibility').args.p_visible,false);assert.match(h.view.querySelector('#loginVisibilityMsg').textContent,/saved/);h.client.rpc=async()=>({error:{message:'Permission denied'}});input.checked=true;await input.onchange();assert.equal(input.checked,false);assert.equal(input.disabled,false);assert.match(h.view.querySelector('#loginVisibilityMsg').textContent,/Permission denied/);h.dom.window.close();
});
test('Employment saves status for legacy staff without a joining date',async()=>{
 const selected={...structuredClone(person),joining_date:null,active:false,employment_status:'INACTIVE'},h=harness({staffRows:[selected]});await h.context.renderPeople(h.view,h.client,{...owner,context_outlet_id:null});h.view.querySelector('[data-status="INACTIVE"]').click();await h.view.querySelector('.manage-staff').onclick();h.view.querySelector('[data-profile-tab="employment"]').click();assert.equal(h.view.querySelector('#saveStaff').textContent,'Save employment status');h.view.querySelector('#editEmploymentStatus').value='ACTIVE';h.view.querySelector('#editStatusDate').value='2026-10-05';await h.view.querySelector('#saveStaff').onclick();const save=h.calls.find(x=>x.name==='owner_set_staff_status');assert.equal(save.args.p_status,'ACTIVE');assert.equal(save.args.p_effective_from,'2026-10-05');assert.equal(h.calls.some(x=>x.name==='owner_save_staff_profile'),false);h.dom.window.close();
});
test('profile saves salary and access before opening the selected employee',async()=>{
 const h=harness();await h.context.renderPeople(h.view,h.client,{...owner,context_outlet_id:null});await h.view.querySelector('.manage-staff').onclick();
 h.view.querySelector('#editSalary').value='16000';h.view.querySelector('[data-access-domain="summary"][data-access-prefix="edit"]').checked=false;
 let navigation;h.view.addEventListener('app:navigate',e=>navigation=e.detail);await h.view.querySelector('[data-module="salary"].profile-open-module').onclick();
 const save=h.calls.find(x=>x.name==='owner_save_staff_profile');assert.equal(save.args.p_changes.basic_salary,16000);assert.equal(save.args.p_changes.permissions.module_access.summary,false);assert.equal(save.args.p_expected.basic_salary,15000);assert.equal(save.args.p_changes.status_effective_from,null);assert.equal(navigation.staffId,2);assert.equal(navigation.module,'salary');h.dom.window.close();
});
test('staff and owner estimates use the same full rolling period before the joining day',async()=>{
 const selected={...structuredClone(person),joining_date:'2025-01-07'},h=harness({staffRows:[selected],userRow:{staff_id:2,outlet_id:2}});await h.context.renderSalary(h.view,h.client,{id:'employee',access_class:'STAFF',role:'Staff'});
 const args=h.calls.find(x=>x.name==='get_salary_estimate_v2').args;assert.equal(args.p_start,'2026-09-07');assert.equal(args.p_end,'2026-10-06');h.dom.window.close();
});
test('approved leave without any punches displays the calculated staff estimate',async()=>{
 const selected={...structuredClone(person),joining_date:'2025-01-01'},estimate={...est,present_equivalent_days:0,leave_days:4,absent_days:0,late_mins:0,deductible_late_hours:0,advance_installment_deduction:0,estimated_net:13000,absent_deduction:2000,data_complete:false,unrecorded_days:26};
 const h=harness({staffRows:[selected],userRow:{staff_id:2,outlet_id:2},estimate});await h.context.renderSalary(h.view,h.client,{id:'employee',access_class:'STAFF',role:'Staff'});
 assert.match(h.view.querySelector('#salaryEstimate').textContent,/13,000/);assert.match(h.view.querySelector('#salaryEstimate').textContent,/Days off · 4/);assert.doesNotMatch(h.view.querySelector('#salaryEstimate').textContent,/Not enough records/);h.dom.window.close();
});
test('a stale or invalid profile cannot navigate away with unsaved salary',async()=>{
 const h=harness({saveError:'This profile changed'});await h.context.renderPeople(h.view,h.client,{...owner,context_outlet_id:null});await h.view.querySelector('.manage-staff').onclick();h.view.querySelector('#editSalary').value='16000';let navigation=false;h.view.addEventListener('app:navigate',()=>navigation=true);await h.view.querySelector('[data-module="salary"].profile-open-module').onclick();assert.equal(navigation,false);assert.match(h.view.querySelector('#editMsg').textContent,/profile changed/);h.dom.window.close();
});
test('Salary opens the selected inactive employee from another café with an empty active roster',async()=>{
 const selected={...structuredClone(person),active:false,employment_status:'LEFT'},h=harness({staffRows:[selected],emptyActive:true});await h.context.renderSalary(h.view,h.client,owner,'salary',2);
 assert.equal(h.view.querySelector('#salaryStaff').value,'2');assert.equal(h.calls.find(x=>x.name==='get_salary_estimate_v2').args.p_staff_id,2);
 const form=h.view.querySelector('#payrollForm');assert.equal(form.elements.late_hours.value,'1.5');assert.equal(form.elements.late_penalty.value,'63');assert.equal(form.elements.late_mins.readOnly,true);form.elements.late_hours.value='2';form.elements.late_hours.dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));assert.equal(form.elements.late_penalty.value,'83');assert.equal(form.elements.late_hours.dataset.auto,'false');h.dom.window.close();
});
test('payment recording refuses unsaved payroll changes',async()=>{
 const current={id:'SAL',period_start:'2026-10-01',period_end:'2026-10-30',pay_date:'2026-11-09',payroll_status:'FINALIZED',net_salary:14500,payroll_details:{basic_salary:15000,present_days:27,absent_days:3,late_mins:0,late_hours:0,half_days:0,holiday_days:0,holiday_pay:0,advance_installment_deduction:500,extra_earnings:[],extra_deductions:[],included_transfer_ids:[]}};
 const h=harness({current});await h.context.renderOwnerSalaryProcessor(h.view,h.client,owner,{},[person],2);const form=h.view.querySelector('#payrollForm');form.elements.ot_credit.value='250';form.elements.ot_credit.dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));h.view.querySelector('#markPayrollPaid').click();assert.match(h.view.querySelector('#payrollMessage').textContent,/Update finalized payroll/);assert.equal(h.calls.filter(x=>x.name==='save_salary_payroll').length,0);h.dom.window.close();
});

test('ordinary admin has distinct reset controls inside Access and cancellation makes no request',async()=>{
 const h=harness();await h.context.renderPeople(h.view,h.client,{...owner,is_super_user:false,context_outlet_id:null});await h.view.querySelector('.manage-staff').onclick();
 const panel=h.view.querySelector('[data-profile-panel="access"]');assert.equal(panel.querySelector('#resetPin').textContent,'Reset PIN');assert.equal(panel.querySelector('#resetProfile').textContent,'Reset profile');
 h.context.confirm=()=>false;await panel.querySelector('#resetProfile').onclick();assert.equal(h.view.querySelector('#resetAccessMsg').textContent,'');h.dom.window.close();
});
test('profile reset submits correct employee and clears stale editor after success',async()=>{
 const h=harness();let request;
 h.client.functions={invoke:async(name,args)=>{request={name,...args};return {data:{success:true}};}};
 await h.context.renderPeople(h.view,h.client,{...owner,context_outlet_id:null});await h.view.querySelector('.manage-staff').onclick();h.view.querySelector('#editSalary').value='999';
 await h.view.querySelector('#resetProfile').onclick();assert.equal(request.name,'chaitracker-admin-reset');assert.equal(request.body.reset_type,'PROFILE');assert.equal(request.body.staff_id,2);assert.equal(h.view.querySelector('#editSalary').value,'15000');assert.match(h.view.querySelector('#resetAccessMsg').textContent,/Profile cleared/);h.dom.window.close();
});

test('admin sees complete onboarding details inside Profile and deletion stays superuser-only',async()=>{
 const h=harness({employeeProfile:{full_legal_name:'Legal Name',identity_number:'ID-123',emergency_contact_name:'Parent'}});await h.context.renderPeople(h.view,h.client,{...owner,is_super_user:false,context_outlet_id:null});await h.view.querySelector('.manage-staff').onclick();
 assert.match(h.view.querySelector('[data-profile-panel="profile"]').textContent,/Legal Name/);assert.match(h.view.querySelector('[data-profile-panel="profile"]').textContent,/ID-123/);assert.equal(h.view.querySelector('#deleteUser'),null);h.dom.window.close();
});
test('superuser gets Delete user but archived staff open read-only history and settlement links',async()=>{
 const h=harness();await h.context.renderPeople(h.view,h.client,{...owner,is_super_user:true,context_outlet_id:null});await h.view.querySelector('.manage-staff').onclick();assert.equal(h.view.querySelector('#deleteUser').textContent,'Delete user');h.dom.window.close();
 const archived={...structuredClone(person),active:false,employment_status:'LEFT'};archived.users.deleted_at='2026-10-03';const a=harness({staffRows:[archived]});await a.context.renderPeople(a.view,a.client,{...owner,context_outlet_id:null});assert.equal(a.view.querySelector('.manage-staff'),null);a.view.querySelector('[data-status="DELETED"]').click();await a.view.querySelector('.manage-staff').onclick();assert.equal(a.view.querySelector('#saveStaff'),null);assert.ok(a.view.querySelector('[data-archive-module="salary"]'));let navigation;a.view.addEventListener('app:navigate',e=>navigation=e.detail);a.view.querySelector('[data-archive-module="salary"]').click();assert.equal(navigation.staffId,2);a.dom.window.close();
});
