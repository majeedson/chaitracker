import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
let db;
const owner='00000000-0000-0000-0000-000000000001',staff='00000000-0000-0000-0000-000000000002',fresh='00000000-0000-0000-0000-000000000003';
const query=async(sql,args=[])=>(await db.query(sql,args)).rows;
const actor=async(id)=>query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
const reset=async(type)=>(await query('select admin_reset_staff_access(1,$1) value',[type]))[0].value;
const user=async()=>(await query('select * from users where staff_id=1'))[0];
before(async()=>{
 db=new PGlite();await db.exec(await fs.readFile(new URL('fixtures/payroll-schema.sql',import.meta.url),'utf8'));
 await db.exec(`create role service_role;create schema extensions;create schema storage;
 create function extensions.digest(text,text) returns bytea language sql as $$select decode(case when $1='1234' then '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4' else '00' end,'hex')$$;
 create table storage.objects(bucket_id text,name text);
 create table pin_reset_audit(target_user_id uuid,reset_by uuid,reset_type text);
 create function superuser_reset_staff_pin_setup(integer) returns void language sql as $$select$$;
 create function owner_reset_staff_pin_setup(integer) returns void language sql as $$select$$;
 create table employee_profiles(user_id uuid unique,full_legal_name text,date_of_birth date,father_name text,nationality text,mobile_phone text,home_address text,emergency_contact_name text,emergency_contact_relation text,emergency_contact_phone text,identity_type text,identity_number text,identity_document_path text,profile_photo_path text,onboarding_status text,onboarding_started_at timestamptz,onboarding_completed_at timestamptz,details_confirmed_at timestamptz,updated_at timestamptz);
 insert into outlets(id,name) values(1,'Cafe');insert into staff(id,name,outlet_id,basic_salary,joining_date) values(1,'Employee',1,15000,'2025-01-01');
 insert into users(id,auth_user_id,name,role,access_class,staff_id,active) values('${owner}','${owner}','Admin','Owner','ADMIN',null,true),('${staff}','${staff}','Employee','Staff','STAFF',1,true);
 insert into employee_profiles(user_id,full_legal_name,identity_number,profile_photo_path,identity_document_path,onboarding_status) values('${staff}','Old legal name','secret','${staff}/old.jpg','${staff}/old.pdf','complete');
 insert into storage.objects values('employee-documents','${staff}/old.pdf'),('employee-photos','${staff}/old.jpg'),('employee-photos','someone-else/photo.jpg');
 insert into attendance(staff_id) values(1);insert into salary_records(id,staff_id,net_salary) values('OLD',1,15000);`);
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261003053222_staff_access_reset_b129.sql',import.meta.url),'utf8'));
 await db.exec(`create table admin_access_audit(action text,target_user_id uuid,target_name text,performed_by uuid,details jsonb);update users set is_super_user=true where id='${owner}';create policy attendance_photos_authenticated_read on storage.objects for select to authenticated using(bucket_id='attendance-photos');`);
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261003065117_employee_profiles_archive_b130.sql',import.meta.url),'utf8'));
});
after(async()=>db.close());beforeEach(async()=>{await db.exec('begin');await actor(owner);});afterEach(async()=>db.exec('rollback'));
test('PIN reset keeps profile, detaches old session and requires temporary PIN',async()=>{
 const profile=(await query('select * from employee_profiles'))[0];await reset('PIN');assert.deepEqual((await query('select * from employee_profiles'))[0],profile);
 const u=await user();assert.equal(u.auth_user_id,null);assert.equal(u.pin_set_at,null);assert.equal(u.pin_setup_hash,'03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4');
 await actor(staff);assert.equal((await query('select private.actor_id() value'))[0].value,null);
 await db.exec('savepoint invalid');await assert.rejects(query('select complete_staff_onboarding($1,$2,$3,null,$4)',[staff,u.setup_revision,fresh,'9999']),/Temporary PIN/);await db.exec('rollback to savepoint invalid');
 await query('select complete_staff_onboarding($1,$2,$3,null,$4)',[staff,u.setup_revision,fresh,'1234']);assert.equal((await user()).auth_user_id,fresh);assert.deepEqual((await query('select * from employee_profiles'))[0],profile);
 assert.equal((await query('select private.actor_id() value'))[0].value,null);
 await actor(fresh);assert.equal((await query('select private.actor_id() value'))[0].value,staff);
});
test('profile reset clears onboarding only and enumerates all owned uploads',async()=>{
 const employment=(await query('select * from staff'))[0],r=await reset('PROFILE');assert.equal((await query('select * from employee_profiles')).length,0);
 assert.equal(r.files.length,2);assert.ok(r.files.every(f=>f.name.startsWith(staff+'/')));assert.equal((await query('select * from attendance')).length,1);assert.equal((await query('select * from salary_records')).length,1);assert.deepEqual((await query('select * from staff'))[0],employment);
 const login=(await query('select * from login_directory where staff_id=1'))[0];assert.equal(login.onboarding_status,'invited');assert.equal(login.pin_set,false);assert.equal(login.pin_reset_pending,false);
 const u=await user();await assert.rejects(query('select complete_staff_onboarding($1,$2,$3,null,null)',[staff,u.setup_revision,fresh]),/Complete your staff profile/);
});
test('staff cannot reset accounts and service completion cannot be called directly',async()=>{
 await actor(staff);await assert.rejects(reset('PROFILE'),/Admin access required/);
 await db.exec('rollback;begin;set local role authenticated');await assert.rejects(query('select complete_staff_onboarding($1,$2,$3,null,null)',[staff,fresh,fresh]),/permission denied/);
});
test('expired temporary PIN and stale onboarding completion are rejected',async()=>{
 await reset('PIN');let u=await user();await db.exec("update users set pin_setup_expires_at=now()-interval '1 minute' where staff_id=1");
 await db.exec('savepoint expired');await assert.rejects(query('select complete_staff_onboarding($1,$2,$3,null,$4)',[staff,u.setup_revision,fresh,'1234']),/Temporary PIN/);await db.exec('rollback to savepoint expired');
 await reset('PROFILE');await assert.rejects(query('select complete_staff_onboarding($1,$2,$3,null,null)',[staff,u.setup_revision,fresh]),/Account setup changed/);
});

const archive=async(date='2026-10-03',name='Employee')=>(await query('select superuser_archive_user($1,$2,$3) value',[staff,name,date]))[0].value;
test('full onboarding fields are available to admin/self, never to another staff member',async()=>{
 const data=(await query('select get_employee_profile_data(1) value'))[0].value;assert.equal(data.identity_number,'secret');assert.equal(data.full_legal_name,'Old legal name');assert.equal(data.pin_hash,undefined);assert.equal(data.auth_user_id,undefined);
 await actor(staff);assert.equal((await query('select get_employee_profile_data(null) value'))[0].value.identity_number,'secret');
 await db.exec(`insert into staff(id,name,outlet_id) values(2,'Other',1);insert into users(id,auth_user_id,name,role,staff_id,active) values('${fresh}','${fresh}','Other','Manager',2,true);`);
 await actor(fresh);await assert.rejects(query('select get_employee_profile_data(1)'),/only view your own/);
});
test('identity document access is admin/self only, not other managers or anonymous sessions',async()=>{
 const path=staff+'/old.pdf';assert.equal((await query('select private.employee_identity_access($1) value',[path]))[0].value,true);
 await actor(staff);assert.equal((await query('select private.employee_identity_access($1) value',[path]))[0].value,true);
 await actor(fresh);assert.equal((await query('select private.employee_identity_access($1) value',[path]))[0].value,false);
 await actor('');assert.equal((await query('select private.employee_identity_access($1) value',[path]))[0].value,false);
});
test('delete preserves payroll, EMI balance and transfer attribution while removing profile/access',async()=>{
 await db.exec(`insert into staff_advance_requests(id,staff_id,amount,status) values('${fresh}',1,1000,'PAID');insert into staff_advance_deductions(advance_id,period_start,amount) values('${fresh}','2026-09-01',200);insert into extra_time_payments(id,staff_user_id,amount,status) values(1,'${staff}',150,'READY');`);
 const r=await archive();assert.equal(r.impact.advance_balance,800);assert.equal(r.impact.transfer_earnings_due,150);assert.equal(r.impact.unpaid_salary,15000);assert.equal(r.files.length,2);assert.equal(r.auth_user_id,staff);
 const u=await user();assert.equal(u.active,false);assert.equal(u.auth_user_id,null);assert.ok(u.deleted_at);assert.equal(u.staff_id,1);assert.equal(u.name,'Employee');assert.equal((await query('select * from employee_profiles')).length,0);
 assert.equal((await query('select * from attendance')).length,1);assert.equal((await query('select net_salary from salary_records'))[0].net_salary,'15000');assert.equal((await query('select amount from staff_advance_deductions'))[0].amount,'200');assert.equal((await query('select u.staff_id from extra_time_payments p join users u on u.id=p.staff_user_id'))[0].staff_id,1);
 assert.equal((await query('select * from login_directory where staff_id=1')).length,0);assert.equal((await query('select * from admin_access_audit')).length,1);
 await actor(staff);assert.equal((await query('select private.actor_id() value'))[0].value,null);
});
test('deleted accounts cannot be reactivated, reset or onboarded through legacy APIs',async()=>{
 await archive();
 const rejected=async(sql,args,pattern)=>{await db.exec('savepoint blocked');await assert.rejects(query(sql,args),pattern);await db.exec('rollback to savepoint blocked');};
 await rejected('update users set active=true where staff_id=1',[],/cannot be reactivated/);
 await rejected("select owner_set_staff_status(1,'ACTIVE')",[],/read-only/);
 await rejected("select admin_reset_staff_access(1,'PIN')",[],/cannot be reactivated/);
 await rejected('insert into employee_profiles(user_id,onboarding_status) values($1,\'complete\')',[staff],/cannot collect/);
 await rejected("insert into staff_advance_requests(staff_id,amount,status) values(1,500,'REQUESTED')",[],/New requests/);
 await rejected("insert into leave_requests(staff_id,status) values(1,'PENDING')",[],/New requests/);
 assert.equal((await query('select private.employee_identity_access($1) value',[staff+'/old.pdf']))[0].value,false);
});
test('pending advances, pending leave and unfinished transfers each block deletion atomically',async()=>{
 for(const insertion of ["insert into staff_advance_requests(staff_id,amount,status) values(1,500,'REQUESTED')","insert into leave_requests(staff_id,status) values(1,'PENDING')",`insert into extra_time_requests(requested_by,status) values('${staff}','DISPATCHED')`]){
  await db.exec('savepoint pending');await db.exec(insertion);await assert.rejects(archive(),/Resolve pending/);await db.exec('rollback to savepoint pending');assert.equal((await user()).active,true);assert.equal((await query('select * from employee_profiles')).length,1);
 }
});
test('only superuser can delete; self/superuser deletion and wrong confirmation are blocked',async()=>{
 await db.exec('savepoint no_super');await db.exec(`update users set is_super_user=false where id='${owner}'`);await assert.rejects(archive(),/Super User access required/);await db.exec('rollback to savepoint no_super');
 await db.exec('savepoint self');await assert.rejects(query('select superuser_archive_user($1,$2,null)',[owner,'Admin']),/cannot delete yourself/);await db.exec('rollback to savepoint self');
 await db.exec('savepoint name');await assert.rejects(archive('2026-10-03','Wrong name'),/exact user name/);await db.exec('rollback to savepoint name');assert.equal((await user()).active,true);
});
test('existing last working date is preserved and cleanup retries do not duplicate history/audit',async()=>{
 await db.exec("update staff set employment_end_date='2026-09-15' where id=1");await archive('2026-10-03');assert.equal((await query('select employment_end_date from staff'))[0].employment_end_date.toISOString().slice(0,10),'2026-09-15');
 await archive();assert.equal((await query('select * from admin_access_audit')).length,1);assert.equal((await query('select * from staff_status_history')).length,1);
});
