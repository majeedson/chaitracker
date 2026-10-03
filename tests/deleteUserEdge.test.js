import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {webcrypto} from 'node:crypto';
async function harness({authError=null,rpcError=null,storageError=null,deleteError=null}={}){
 const calls=[];let handler;
 const client={auth:{getUser:async()=>({data:{user:authError?null:{id:'actor'}},error:authError})},rpc:async(name,args)=>{calls.push({name,args});return {error:rpcError,data:{auth_user_id:'target-auth',files:[{bucket_id:'employee-documents',name:'target/id.pdf'},{bucket_id:'employee-photos',name:'target/profile.jpg'}]}};}};
 const admin={auth:{admin:{updateUserById:async(id,args)=>{calls.push({name:'ban',id,args});return {};},deleteUser:async(id)=>{calls.push({name:'deleteAuth',id});return {error:deleteError};}}},storage:{from:bucket=>({remove:async(paths)=>{calls.push({name:'remove',bucket,paths});return {error:storageError};}})}};
 const source=(await fs.readFile(new URL('../supabase/functions/chaitracker-delete-user/index.ts',import.meta.url),'utf8')).replace(/^import .*;\n/,'');
 vm.runInNewContext(stripTypeScriptTypes(source),{createClient:(url,key)=>key==='secret'?admin:client,Deno:{env:{get:name=>name==='SUPABASE_SERVICE_ROLE_KEY'?'secret':'key'},serve:fn=>handler=fn},Response,crypto:webcrypto,console:{error(){}}});
 const request=()=>new Request('https://example.test',{method:'POST',body:JSON.stringify({user_id:'target',confirmation:'Employee',last_working_date:'2026-10-03'})});
 return {handler,calls,request};
}
test('delete endpoint authenticates and delegates authorization before touching auth/files',async()=>{
 const unauth=await harness({authError:{message:'No token'}});assert.equal((await unauth.handler(unauth.request())).status,401);assert.equal(unauth.calls.length,0);
 const staff=await harness({rpcError:{message:'Super User access required'}});assert.equal((await staff.handler(staff.request())).status,400);assert.equal(staff.calls.length,1);assert.equal(staff.calls[0].name,'superuser_archive_user');
});
test('deletion cleans only onboarding files, detaches first, and reports historical auth retention',async()=>{
 const h=await harness({deleteError:{message:'User owns historical storage objects'}});const response=await h.handler(h.request()),data=await response.json();assert.equal(response.status,200);assert.equal(data.success,true);assert.equal(data.auth_retained,true);assert.equal(data.cleanup_pending,false);
 assert.equal(h.calls[0].name,'superuser_archive_user');assert.equal(h.calls[1].name,'ban');assert.ok(h.calls[1].args.ban_duration);assert.deepEqual(h.calls.filter(c=>c.name==='remove').map(c=>c.bucket),['employee-documents','employee-photos']);assert.equal(h.calls.at(-1).name,'deleteAuth');
});
test('personal file cleanup failure is reported and can be retried without erasing business records',async()=>{
 const h=await harness({storageError:{message:'Temporary failure'}});const response=await h.handler(h.request());assert.equal((await response.json()).cleanup_pending,true);assert.equal(h.calls.some(c=>c.bucket==='attendance-photos'),false);
});
