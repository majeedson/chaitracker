import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 if(req.method!=='POST')return json({error:'Method not allowed'},405);
 const url=Deno.env.get('SUPABASE_URL')!,key=Deno.env.get('SUPABASE_ANON_KEY')!;
 const authorization=req.headers.get('Authorization')||'';
 const client=createClient(url,key,{global:{headers:{Authorization:authorization}},auth:{persistSession:false}});
 const {data:auth,error:authError}=await client.auth.getUser();
 if(authError||!auth.user)return json({error:'Sign in as an administrator.'},401);
 try{
  const body=await req.json();
  if(!Number.isInteger(body.staff_id)||!['PIN','PROFILE'].includes(body.reset_type))return json({error:'Choose a staff member and reset type.'},400);
  const {data,error}=await client.rpc('admin_reset_staff_access',{p_staff_id:body.staff_id,p_reset_type:body.reset_type});
  if(error)return json({error:error.message},400);
  const admin=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
  let cleanupPending=false;
  // Delete blobs via Storage API, never by deleting storage.objects metadata.
  for(const bucket of ['employee-documents','employee-photos']){
   const paths=(data.files||[]).filter((file:{bucket_id:string})=>file.bucket_id===bucket).map((file:{name:string})=>file.name);
   for(let start=0;start<paths.length;start+=100){
    const removed=await admin.storage.from(bucket).remove(paths.slice(start,start+100));
    if(removed.error){cleanupPending=true;console.error('Reset file cleanup failed',removed.error.message);}
   }
  }
  return json({success:true,reset_type:body.reset_type,cleanup_pending:cleanupPending});
 }catch(error){console.error(error);return json({error:'Unable to reset staff access.'},500);}
});
