import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {onboardingDetailsHtml,renderMyProfile,deleteUserDialog,bindProfileDocuments} from '../src/employeeProfiles.js';
let dom;
afterEach(()=>{dom?.window.close();delete globalThis.document;delete globalThis.window;});
const setup=()=>{dom=new JSDOM('<main id="view"></main>',{url:'https://example.test'});globalThis.document=dom.window.document;globalThis.window=dom.window;return document.querySelector('#view');};
const impact={name:'Employee',staff_id:1,joining_date:'2025-01-01',attendance_records:5,salary_records:2,unpaid_salary:15000,advance_balance:800,transfer_earnings_due:150,pending_advances:0,pending_leave:0,unfinished_transfers:0};
test('full profile renders collected details safely and never shows supplied PIN fields',()=>{
 const root=setup();root.innerHTML=onboardingDetailsHtml({full_legal_name:'<img src=x onerror=alert(1)>',father_name:'Father',date_of_birth:'1990-01-01',identity_number:'ID-123',emergency_contact_phone:'555',pin_hash:'SECRET-PIN',profile_photo_path:'path'});
 assert.equal(root.querySelector('img'),null);assert.match(root.textContent,/Father/);assert.match(root.textContent,/ID-123/);assert.doesNotMatch(root.textContent,/SECRET-PIN/);assert.ok(root.querySelector('[data-profile-document]'));
});
test('staff My profile asks the backend for the authenticated employee, not an arbitrary ID',async()=>{
 const root=setup();let args;await renderMyProfile(root,{rpc:async(name,a)=>{args={name,a};return {data:{name:'Employee',identity_number:'ID-123'}};}},{staff_id:999});
 assert.equal(args.name,'get_employee_profile_data');assert.equal(args.a.p_staff_id,null);assert.match(root.textContent,/ID-123/);
});
test('deletion requires exact name, confirmation checkbox and working date before invoking backend',async()=>{
 setup();const calls=[];const client={rpc:async()=>({data:impact}),functions:{invoke:async(name,args)=>{calls.push({name,args});return {data:{success:true}};}}};
 const result=deleteUserDialog(client,'employee');await new Promise(setImmediate);
 const button=document.querySelector('[data-delete-submit]');assert.equal(button.disabled,true);
 const name=document.querySelector('[data-delete-name]');name.value='Wrong';name.dispatchEvent(new window.Event('input'));assert.equal(button.disabled,true);
 name.value='Employee';name.dispatchEvent(new window.Event('input'));const check=document.querySelector('[data-delete-confirm]');check.checked=true;check.dispatchEvent(new window.Event('change'));assert.equal(button.disabled,false);
 await button.onclick();assert.equal((await result).success,true);assert.equal(calls[0].args.body.user_id,'employee');assert.equal(calls[0].args.body.confirmation,'Employee');assert.ok(calls[0].args.body.last_working_date);assert.equal(document.querySelector('[role=dialog]'),null);
});
test('pending handover blocks deletion even when confirmation is complete; cancel does not invoke delete',async()=>{
 setup();let invoked=false;const result=deleteUserDialog({rpc:async()=>({data:{...impact,unfinished_transfers:1}}),functions:{invoke:async()=>{invoked=true;}}},'employee');await new Promise(setImmediate);
 const name=document.querySelector('[data-delete-name]');name.value='Employee';name.oninput();const check=document.querySelector('[data-delete-confirm]');check.checked=true;check.onchange();assert.equal(document.querySelector('[data-delete-submit]').disabled,true);
 document.querySelector('[data-delete-cancel]').click();assert.equal(await result,null);assert.equal(invoked,false);
});
test('document links are generated on demand with a short expiration',async()=>{
 const root=setup();root.innerHTML=onboardingDetailsHtml({identity_document_path:'employee/id.pdf'});let options,opened;
 window.open=()=>({opener:null,location:{replace:url=>opened=url},close(){}});
 bindProfileDocuments(root,{storage:{from:bucket=>({createSignedUrl:async(path,ttl)=>{options={bucket,path,ttl};return {data:{signedUrl:'https://example.test/private.pdf'}};}})}},{identity_document_path:'employee/id.pdf'});
 await root.querySelector('[data-profile-document]').onclick();assert.deepEqual(options,{bucket:'employee-documents',path:'employee/id.pdf',ttl:60});assert.equal(opened,'https://example.test/private.pdf');
});
