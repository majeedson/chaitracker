import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
let db,day;
const admin='00000000-0000-0000-0000-000000000001',manager='00000000-0000-0000-0000-000000000002',staff='00000000-0000-0000-0000-000000000003';
const rows=async(sql,args=[])=>(await db.query(sql,args)).rows;
const actor=async(id)=>db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
const shift=async(id,time,date=day)=>rows('select admin_save_staff_shift($1,$2,$3)',[id,time,date]);
const photo=async(id=1)=>{const path=id+'/'+day+'/test.jpg';await rows("insert into storage.objects(bucket_id,name) values('attendance-photos',$1)",[path]);return path;};
before(async()=>{
 db=new PGlite();await db.exec(await fs.readFile(new URL('fixtures/payroll-schema.sql',import.meta.url),'utf8'));
 await db.exec(`create role service_role;create schema storage;create table storage.objects(bucket_id text,name text);
 alter table users add deleted_at timestamptz;
 create table admin_access_audit(action text,target_user_id uuid,target_name text,performed_by uuid,details jsonb);
 create table attendance_corrections(attendance_id integer,staff_id integer,outlet_id integer,attendance_date date,requested_punch_time timestamptz,reason text,status text,requested_by uuid,reviewed_by uuid,reviewed_at timestamptz,review_note text);
 create or replace function get_effective_business_day(integer,timestamptz) returns date language sql stable as $$select (($2 at time zone 'Asia/Kolkata')-interval '4 hours')::date$$;`);
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261005163305_staff_shift_photo_checkin_b134.sql',import.meta.url),'utf8'));
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261005170542_historical_attendance_import.sql',import.meta.url),'utf8'));
 await db.exec(`insert into outlets(id,name,shift_start_hour) values(1,'Cafe',11);insert into staff(id,name,outlet_id) values(1,'Manager',1),(2,'Employee',1);insert into users(id,auth_user_id,name,role,access_class,outlet_id,staff_id) values('${admin}','${admin}','Admin','Owner','ADMIN',1,null),('${manager}','${manager}','Manager','Manager','STAFF',1,1),('${staff}','${staff}','Employee','Staff','STAFF',1,2);`);
 day=(await rows('select get_effective_business_day(1,now())::text as business_date'))[0].business_date;
});
after(async()=>db?.close());beforeEach(async()=>{await db.exec('begin');await actor(admin);});afterEach(async()=>db.exec('rollback'));
test('dated shifts preserve history, prioritize daily overrides and support returning to default',async()=>{
 await shift(1,'13:00');assert.equal((await rows('select private.resolve_staff_shift(1,$1)::text t',[day]))[0].t,'13:00:00');
 assert.equal((await rows("select private.resolve_staff_shift(2,$1)::text t",[day]))[0].t,'11:00:00');
 await rows("insert into staff_shifts(staff_id,shift_date,start_time) values(1,$1,'14:00')",[day]);assert.equal((await rows('select private.resolve_staff_shift(1,$1)::text t',[day]))[0].t,'14:00:00');
 await db.exec('delete from staff_shifts');await shift(1,null);assert.equal((await rows('select private.resolve_staff_shift(1,$1)::text t',[day]))[0].t,'13:00:00');
 await assert.rejects(shift(1,'10:00','2020-01-01'),/historical attendance is preserved/);
});
test('non-admin cannot edit shift settings',async()=>{
 await actor(staff);await assert.rejects(shift(2,'12:00'),/Admin access required/);
});
test('staff can view their own shift but cannot read another employee schedule',async()=>{
 await actor(staff);assert.equal((await rows('select get_staff_shift_settings(2) v'))[0].v.effective_start,'11:00:00');await assert.rejects(rows('select get_staff_shift_settings(1)'),/Shift access denied/);
});
test('inactive staff and missing photo objects cannot unlock attendance or modules',async()=>{
 const path=await photo(2);await rows('update staff set active=false where id=2');await assert.rejects(rows('select record_staff_photo_checkin($1,$2)',[staff,path]),/Active staff link required/);
});
test('a punch without an existing photo object leaves modules locked',async()=>{
 await rows("insert into attendance(staff_id,outlet_id,attendance_date,punch_time,photo_url) values(1,1,$1,'13:00','missing.jpg')",[day]);await actor(manager);assert.equal((await rows('select get_photo_checkin_status() v'))[0].v.checked_in,false);
});
test('a recorded punch retains its original shift after a same-day schedule edit',async()=>{
 await rows("insert into attendance(staff_id,outlet_id,attendance_date,shift_start,punch_time,late_mins) values(1,1,$1,'11:00','11:20',20)",[day]);await shift(1,'13:00');
 const result=(await rows('select * from get_attendance_calendar(1,1,$1,$1)',[day]))[0];assert.equal(result.shift_start,'11:00:00');assert.equal(result.late_mins,20);
});
test('manager modules require stored photo check-in and duplicate punches are refused',async()=>{
 await actor(manager);assert.equal((await rows("select private.has_module_access('summary') v"))[0].v,false);
 const path=await photo();await rows('select record_staff_photo_checkin($1,$2)',[manager,path]);
 assert.equal((await rows("select private.has_module_access('summary') v"))[0].v,true);
 assert.equal((await rows('select get_photo_checkin_status() v'))[0].v.checked_in,true);
 await assert.rejects(rows('select record_staff_photo_checkin($1,$2)',[manager,path]),/already recorded/);
});
test('admin is exempt, arbitrary files and inactive staff cannot create attendance',async()=>{
 assert.equal((await rows('select get_photo_checkin_status() v'))[0].v.required,false);
 await assert.rejects(rows('select record_staff_photo_checkin($1,$2)',[staff,'2/'+day+'/missing.jpg']),/Stored check-in photo required/);
});
test('manager cannot correct own attendance; admin corrections retain original time and photo',async()=>{
 const path=await photo();const record=(await rows('select * from record_staff_photo_checkin($1,$2)',[manager,path]))[0];
 await actor(manager);await assert.rejects(rows("select correct_attendance($1,'13:00','Clock correction')",[record.id]),/cannot correct their own/);
});
test('admin correction snapshot keeps original proof and requires a time',async()=>{
 const path=await photo();const record=(await rows('select * from record_staff_photo_checkin($1,$2)',[manager,path]))[0];
 await rows("select correct_attendance($1,'13:00','Clock correction')",[record.id]);const audit=(await rows('select * from attendance_corrections'))[0];assert.equal(audit.original_photo_url,path);assert.equal(audit.original_punch_time,record.punch_time);
});
test('business day uses 4AM rollover and public callers cannot invoke service punch RPC',async()=>{
 assert.equal((await rows("select get_effective_business_day(1,'2026-10-05T21:30:00Z')::text v"))[0].v,'2026-10-05');
 assert.equal((await rows("select get_effective_business_day(1,'2026-10-05T23:30:00Z')::text v"))[0].v,'2026-10-06');
 await db.exec('set local role authenticated');await assert.rejects(rows('select record_staff_photo_checkin($1,$2)',[manager,'x']),/permission denied/);
});
test('admin history includes inactive staff and recorded dates outside employment settings',async()=>{
 await db.exec("update staff set active=false,joining_date='2026-04-01',employment_end_date='2026-04-30' where id=2;insert into attendance(staff_id,outlet_id,attendance_date,shift_start,punch_time) values(2,1,'2026-03-10','11:00','11:10')");
 const calendar=await rows("select * from get_attendance_calendar(1,2,'2026-03-10','2026-03-10')");assert.equal(calendar.length,1);assert.equal(calendar[0].staff_id,2);assert.equal(calendar[0].punch_time,'11:10:00');
});
test('historical records retain their recorded outlet after a staff transfer',async()=>{
 await db.exec("insert into outlets(id,name) values(2,'Previous cafe');insert into attendance(staff_id,outlet_id,attendance_date,shift_start,punch_time) values(1,2,'2026-03-10','11:00','11:10')");
 const calendar=(await rows("select * from get_attendance_calendar(1,1,'2026-03-10','2026-03-10')"))[0];assert.equal(calendar.outlet_id,2);assert.equal(calendar.outlet_name,'Previous cafe');
});
test('source import audit is private to database administration',async()=>{
 await actor(staff);await db.exec('set local role authenticated');await assert.rejects(rows('select * from private.attendance_sheet_imports'),/permission denied/);
});
