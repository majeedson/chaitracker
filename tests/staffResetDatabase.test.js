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
