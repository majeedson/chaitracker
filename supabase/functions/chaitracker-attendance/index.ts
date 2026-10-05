import {createClient} from 'npm:@supabase/supabase-js@2.117.2';
import jpeg from 'npm:jpeg-js@0.4.4';
import {PNG} from 'npm:pngjs@7.0.0';
import {Buffer} from 'node:buffer';

const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,x-client-info,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'};
const reply=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
export function validatePhoto(bytes:Uint8Array,type:string){
  if(!bytes.length||bytes.length>5*1024*1024)throw new Error('Use a JPEG or PNG photo between 1 byte and 5 MB.');
  if(type==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255){
    const image=jpeg.decode(bytes,{useTArray:true,maxResolutionInMP:20,maxMemoryUsageInMB:96});
    if(image.width<32||image.height<32)throw new Error('Take a clear check-in photo.');
    return 'jpg';
  }
  if(type==='image/png'&&bytes.length>=24&&[137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n)){
    const input=Buffer.from(bytes),width=input.readUInt32BE(16),height=input.readUInt32BE(20);
    if(width<32||height<32||width*height>20_000_000)throw new Error('Use a clear photo up to 20 megapixels.');
    PNG.sync.read(input,{checkCRC:true});return 'png';
  }
  throw new Error('Take a valid JPEG or PNG photo.');
}

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return reply(405,{error:'POST required'});
  const url=Deno.env.get('SUPABASE_URL')!,key=Deno.env.get('SUPABASE_ANON_KEY')!;
  const authorization=req.headers.get('Authorization');
  if(!authorization)return reply(401,{error:'Sign in to check in.'});
  const client=createClient(url,key,{global:{headers:{Authorization:authorization}},auth:{persistSession:false}});
  const admin=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
  let uploaded:string|null=null;
  try{
    const {data:auth,error:authError}=await client.auth.getUser();
    if(authError||!auth.user)return reply(401,{error:'Sign in to check in.'});
    const {data:account,error:accountError}=await admin.from('users').select('id,staff_id,outlet_id,access_class,active,deleted_at').eq('auth_user_id',auth.user.id).maybeSingle();
    if(accountError||!account?.active||account.deleted_at||!account.staff_id||account.access_class==='ADMIN')return reply(403,{error:'An active employee account linked to a staff profile is required.'});
    const {data:status,error:statusError}=await client.rpc('get_photo_checkin_status');
    if(statusError)throw statusError;
    if(status?.checked_in)return reply(409,{error:'You are already checked in for this café day.'});
    const form=await req.formData(),photo=form.get('photo');
    if(!(photo instanceof File))return reply(400,{error:'Take a photo to check in.'});
    if(!photo.size||photo.size>5*1024*1024)return reply(400,{error:'Use a JPEG or PNG photo up to 5 MB.'});
    const extension=validatePhoto(new Uint8Array(await photo.arrayBuffer()),photo.type);
    const path=account.staff_id+'/'+status.business_date+'/'+crypto.randomUUID()+'.'+extension;
    const {error:uploadError}=await admin.storage.from('attendance-photos').upload(path,photo,{contentType:photo.type,upsert:false});
    if(uploadError)throw uploadError;uploaded=path;
    const {data:attendance,error:recordError}=await admin.rpc('record_staff_photo_checkin',{p_user_id:account.id,p_photo_path:path});
    if(recordError)throw recordError;
    uploaded=null;return reply(200,{ok:true,attendance});
  }catch(error){
    if(uploaded)await admin.storage.from('attendance-photos').remove([uploaded]);
    return reply(400,{error:error instanceof Error?error.message:(error as {message?:string})?.message||'Check-in failed. Please retry.'});
  }
});
