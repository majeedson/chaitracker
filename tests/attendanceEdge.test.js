import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import jpeg from 'jpeg-js';
import {PNG} from 'pngjs';
import {webcrypto} from 'node:crypto';
const source=(await fs.readFile(new URL('../supabase/functions/chaitracker-attendance/index.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export function validatePhoto','function validatePhoto');
function harness({recordError=false,account={id:'employee',staff_id:1,active:true,access_class:'STAFF'},checked=false,unauthorized=false}={}){
 const calls=[];let handler;
 const client={auth:{getUser:async()=>({data:{user:unauthorized?null:{id:'auth'}}})},rpc:async()=>({data:{business_date:'2026-10-05',checked_in:checked}})};
 const admin={from(){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:account})};return q;},storage:{from:()=>({upload:async(path)=>{calls.push({action:'upload',path});return {};},remove:async(paths)=>{calls.push({action:'remove',paths});return {};}})},rpc:async(name,args)=>{calls.push({action:name,args});return recordError?{error:{message:'Attendance already recorded'}}:{data:{id:1}};}};
 const context=vm.createContext({jpeg,PNG,Buffer,Uint8Array,File,Request,Response,crypto:webcrypto,createClient:(_,key)=>key==='service'?admin:client,Deno:{env:{get:name=>name==='SUPABASE_SERVICE_ROLE_KEY'?'service':'public'},serve:fn=>{handler=fn;}}});vm.runInContext(stripTypeScriptTypes(source),context);return {context,calls,handler};
}
const png=()=>{const p=new PNG({width:32,height:32});p.data.fill(128);return PNG.sync.write(p);};
const request=(bytes=png(),type='image/png')=>{const body=new FormData();body.append('photo',new File([bytes],'photo.png',{type}));return new Request('https://example.test',{method:'POST',headers:{Authorization:'Bearer test'},body});};
test('actual JPEG and PNG decode; empty, spoofed and corrupt photo files fail',()=>{
 const h=harness();assert.equal(h.context.validatePhoto(png(),'image/png'),'png');const bytes=jpeg.encode({width:32,height:32,data:Buffer.alloc(32*32*4,128)},80).data;assert.equal(h.context.validatePhoto(bytes,'image/jpeg'),'jpg');
 for(const bytes of [Buffer.alloc(0),Buffer.from('not an image'),png().subarray(0,30)])assert.throws(()=>h.context.validatePhoto(bytes,'image/png'));
});
test('valid manager photo delegates server time/day/shift to atomic service RPC',async()=>{
 const h=harness();assert.equal((await h.handler(request())).status,200);assert.equal(h.calls[1].action,'record_staff_photo_checkin');assert.equal(h.calls[1].args.p_user_id,'employee');assert.match(h.calls[0].path,/^1\/2026-10-05\/.+\.png$/);assert.deepEqual(Object.keys(h.calls[1].args).sort(),['p_photo_path','p_user_id']);
});
test('record race/failure removes uploaded image and returns a retryable error',async()=>{
 const h=harness({recordError:true});const result=await h.handler(request());assert.equal(result.status,400);assert.equal((await result.json()).error,'Attendance already recorded');assert.equal(h.calls.at(-1).action,'remove');
});
test('unauthenticated, inactive, admin, unlinked and duplicate accounts do not upload',async()=>{
 for(const options of [{unauthorized:true},{account:{active:false}},{account:{active:true,staff_id:1,access_class:'ADMIN'}},{account:{active:true,access_class:'STAFF'}},{checked:true}]){const h=harness(options);assert.ok((await h.handler(request())).status>=400);assert.equal(h.calls.length,0);}
});
