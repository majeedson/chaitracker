import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 if(req.method!=='POST')return json({error:'Method not allowed'},405);
 const url=Deno.env.get('SUPABASE_URL')!,key=Deno.env.get('SUPABASE_ANON_KEY')!;
 const client=createClient(url,key,{global:{headers:{Authorization:req.headers.get('Authorization')||''}},auth:{persistSession:false}});
 const {data:auth,error:authError}=await client.auth.getUser();if(authError||!auth.user)return json({error:'Sign in as the Super User.'},401);
 try{
  const body=await req.json();
  if(typeof body.user_id!=='string'||typeof body.confirmation!=='string')return json({error:'Choose a user and type their name to confirm.'},400);
  const {data,error}=await client.rpc('superuser_archive_user',{p_user_id:body.user_id,p_confirmation:body.confirmation,p_last_working_date:body.last_working_date||null});
  if(error)return json({error:error.message},400);
  // The transaction has already detached auth and disabled all application access.
  const admin=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
  let cleanupPending=false,authRetained=false;
  if(data.auth_user_id){
   const banned=await admin.auth.admin.updateUserById(data.auth_user_id,{password:crypto.randomUUID()+crypto.randomUUID(),ban_duration:'876000h'});
   if(banned.error&&!banned.error.message?.toLowerCase().includes('not found'))console.error('Auth disable failed',banned.error.message);
  }
  for(const bucket of ['employee-documents','employee-photos']){
   const paths=(data.files||[]).filter((f:{bucket_id:string})=>f.bucket_id===bucket).map((f:{name:string})=>f.name);
   for(let start=0;start<paths.length;start+=100){const result=await admin.storage.from(bucket).remove(paths.slice(start,start+100));if(result.error){cleanupPending=true;console.error('Personal-file cleanup failed',result.error.message);}}
  }
  if(data.auth_user_id){
   const removed=await admin.auth.admin.deleteUser(data.auth_user_id);
   // Business/attendance uploads must remain even if their ownership prevents Auth deletion.
   if(removed.error&&!removed.error.message?.toLowerCase().includes('not found')){authRetained=true;console.error('Detached Auth retained for historical uploads',removed.error.message);}
  }
  return json({success:true,cleanup_pending:cleanupPending,auth_retained:authRetained});
 }catch(error){console.error(error);return json({error:'Unable to delete this account. Reload and check its status before retrying.'},500);}
});
