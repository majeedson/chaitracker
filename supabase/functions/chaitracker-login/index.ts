import { withSupabase } from "npm:@supabase/server";

const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const staffPassword=(userId:string,pin:string)=>`CafeTracker!${userId}!${pin}`;
async function sha256(value:string){const bytes=new TextEncoder().encode(value);const hash=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,"0")).join("");}

export default {fetch:withSupabase({auth:"none"},async(req,ctx)=>{
 if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
 if(req.method!=="POST") return json({error:"Method not allowed"},405);
 try{
  const body=await req.json(); const userId=String(body?.user_id??""); const mode=String(body?.mode??"login");
  if(!userId)return json({error:"Account not specified."},400);
  const {data:user,error:userError}=await ctx.supabaseAdmin.from("users").select("id,name,role,outlet_id,can_switch_outlet,active,pin_hash,auth_user_id,failed_login_attempts,locked_until,pin_setup_hash,pin_setup_expires_at,access_class,is_super_user").eq("id",userId).maybeSingle();
  if(userError||!user||!user.active)return json({error:"Account not available."},401);

  if(mode==="setup")return json({error:"Use Complete setup on the sign-in screen."},400);

  const pin=String(body?.pin??"");
  if(!/^\d{4,8}$/.test(pin))return json({error:"Enter a valid PIN."},400);

  // Admin first-login bootstrap. Jazeel keeps 123456 as a permanent recovery/sign-in route.
  if(user.access_class==="ADMIN"&&pin==="123456"){
   const isJazeel=user.is_super_user===true&&String(user.name).toLowerCase()==="jazeel";
   const mayBootstrap=!user.auth_user_id;
   if(!isJazeel&&!mayBootstrap)return json({error:"Incorrect PIN."},401);
   const email=`${user.id}@login.chaitracker.local`;
   let authUserId=user.auth_user_id??null;
   if(!authUserId){
    const created=await ctx.supabaseAdmin.auth.admin.createUser({email,password:pin,email_confirm:true,user_metadata:{chaitracker_user_id:user.id}});
    if(created.error&&!created.error.message?.toLowerCase().includes("already"))return json({error:"Could not create admin account."},500);
    authUserId=created.data?.user?.id??null;
    if(!authUserId){const existing=await ctx.supabaseAdmin.auth.admin.listUsers({page:1,perPage:1000});authUserId=existing.data?.users?.find((u:any)=>u.email===email)?.id??null;}
    if(!authUserId)return json({error:"Could not establish admin account."},500);
    await ctx.supabaseAdmin.from("users").update({auth_user_id:authUserId,pin_set_at:new Date().toISOString()}).eq("id",user.id);
   }
   // Only the permanent Super User route may deliberately restore 123456.
   if(isJazeel){const changed=await ctx.supabaseAdmin.auth.admin.updateUserById(authUserId,{password:pin});if(changed.error)return json({error:"Could not prepare Super User PIN."},500);}
   const {data:sessionData,error:signInError}=await ctx.supabase.auth.signInWithPassword({email,password:pin});
   if(signInError||!sessionData.session)return json({error:"Admin sign-in failed."},401);
   return json({session:sessionData.session,user:{id:user.id,auth_user_id:authUserId,name:user.name,role:user.role,outlet_id:user.outlet_id,can_switch_outlet:user.can_switch_outlet,access_class:user.access_class,is_super_user:user.is_super_user}});
  }
  if(!user.pin_hash&&!user.auth_user_id)return json({error:"PIN not set. Use first-time PIN setup."},409);
  if(user.locked_until&&new Date(user.locked_until).getTime()>Date.now())return json({error:"Too many attempts. Please try again later."},429);

  if(!user.auth_user_id){
   if(String(user.pin_hash??"")!==pin)return json({error:"Incorrect PIN."},401);
   const email=`${user.id}@login.chaitracker.local`;
   const created=await ctx.supabaseAdmin.auth.admin.createUser({email,password:staffPassword(user.id,pin),email_confirm:true,user_metadata:{chaitracker_user_id:user.id}});
   if(created.error)return json({error:"Could not create the secure account."},500);
   const authUserId=created.data.user?.id;if(!authUserId)return json({error:"Could not establish the secure account."},500);
   await ctx.supabaseAdmin.from("users").update({auth_user_id:authUserId,pin_set_at:new Date().toISOString()}).eq("id",user.id);
   user.auth_user_id=authUserId;
  }
  const linked=await ctx.supabaseAdmin.auth.admin.getUserById(user.auth_user_id);
  const email=linked.data?.user?.email;
  if(linked.error||!email)return json({error:"Login account unavailable. Ask an administrator to reset your PIN."},409);
  const staffPass=staffPassword(user.id,pin);
  const {data:sessionData,error:signInError}=await ctx.supabase.auth.signInWithPassword({email,password:staffPass});
  if(signInError||!sessionData.session)return json({error:"Incorrect PIN or secure sign-in failed."},401);
  await ctx.supabaseAdmin.from("users").update({last_login_at:new Date().toISOString(),failed_login_attempts:0,locked_until:null}).eq("id",user.id);
  return json({session:sessionData.session,user:{id:user.id,auth_user_id:user.auth_user_id,name:user.name,role:user.role,outlet_id:user.outlet_id,can_switch_outlet:user.can_switch_outlet}});
 }catch(error){console.error(error);return json({error:"Unable to sign in."},500);}
})};
