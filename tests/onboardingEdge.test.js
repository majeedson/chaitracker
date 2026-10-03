import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {webcrypto} from 'node:crypto';
async function handler(slug){
 let source=await fs.readFile(new URL(`../supabase/functions/${slug}/index.ts`,import.meta.url),'utf8');source=source.replace(/^import .*;\n/,'').replace('export default {fetch:withSupabase','globalThis.handler={fetch:withSupabase');
 const ctx=vm.createContext({withSupabase:(_,fn)=>fn,Request,Response,FormData,File,TextEncoder,crypto:webcrypto,console,Date});vm.runInContext(stripTypeScriptTypes(source),ctx);return ctx.handler.fetch;
}
const user={id:'00000000-0000-0000-0000-000000000001',active:true,access_class:'STAFF',auth_user_id:null,pin_hash:null,pin_setup_hash:'03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4',pin_setup_expires_at:'2099-01-01',setup_revision:'revision'};
function service({error=null,profile=user}={}){
 const calls=[];
 const ctx={supabaseAdmin:{from(){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:profile}),update(){return q;},then(resolve){resolve({});}};return q;},rpc:async(name,args)=>{calls.push({name,args});return {error};},auth:{admin:{createUser:async(args)=>{calls.push({name:'createUser',args});return {data:{user:{id:'new-auth'}}};},deleteUser:async(id)=>{calls.push({name:'deleteUser',id});return {};},getUserById:async(id)=>({data:{user:{id,email:'reset-generation@login.chaitracker.local'}}})}}},supabase:{auth:{signInWithPassword:async(args)=>{calls.push({name:'signIn',args});return {data:{session:{access_token:'test'}}};}}}};
 return {ctx,calls};
}
function pinRequest(code='1234',newPin='5678'){
 const form=new FormData();for(const [k,v] of Object.entries({user_id:user.id,action:'reset_pin',setup_code:code,new_pin:newPin}))form.append(k,v);return new Request('https://example.test',{method:'POST',body:form});
}
test('PIN onboarding uses a fresh auth identity and completes without re-uploading personal data',async()=>{
 const fn=await handler('chaitracker-onboarding'),h=service();assert.equal((await fn(pinRequest(),h.ctx)).status,200);assert.equal((await fn(pinRequest(),h.ctx)).status,200);
 const accounts=h.calls.filter(c=>c.name==='createUser');assert.notEqual(accounts[0].args.email,accounts[1].args.email);assert.ok(accounts.every(c=>c.args.email.split('@')[0].length<=64));
 const complete=h.calls.find(c=>c.name==='complete_staff_onboarding');assert.equal(complete.args.p_profile,null);assert.equal(complete.args.p_setup_code,'1234');assert.equal(complete.args.p_revision,'revision');
});
test('wrong temporary PIN and unchanged PIN fail before account creation',async()=>{
 const fn=await handler('chaitracker-onboarding'),h=service();assert.equal((await fn(pinRequest('9999'),h.ctx)).status,401);assert.equal((await fn(pinRequest('1234','1234'),h.ctx)).status,400);assert.equal(h.calls.length,0);
});
test('failed atomic completion removes newly created auth account so a retry can succeed',async()=>{
 const fn=await handler('chaitracker-onboarding'),h=service({error:{message:'Account setup changed'}});assert.equal((await fn(pinRequest(),h.ctx)).status,400);assert.equal(h.calls.at(-1).name,'deleteUser');assert.equal(h.calls.at(-1).id,'new-auth');
});
test('sign in resolves the linked auth email after re-onboarding',async()=>{
 const fn=await handler('chaitracker-login'),h=service({profile:{...user,auth_user_id:'new-auth'}});const response=await fn(new Request('https://example.test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:user.id,pin:'5678'})}),h.ctx);assert.equal(response.status,200);assert.equal(h.calls.find(c=>c.name==='signIn').args.email,'reset-generation@login.chaitracker.local');
});
