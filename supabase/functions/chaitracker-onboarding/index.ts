import { withSupabase } from "npm:@supabase/server";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
async function sha256(value:string){const bytes=new TextEncoder().encode(value);const hash=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,"0")).join("");}
const clean=(v:FormDataEntryValue|null)=>String(v??"").trim();
const staffPassword=(userId:string,pin:string)=>`CafeTracker!${userId}!${pin}`;

export default {fetch:withSupabase({auth:"none"},async(req,ctx)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return json({error:"Method not allowed"},405);
 try{
  const form=await req.formData();
  const userId=clean(form.get("user_id")), newPin=clean(form.get("new_pin"));
  if(!userId||!/^[0-9]{4,8}$/.test(newPin))return json({error:"Choose a 4–8 digit private PIN."},400);
  const {data:user}=await ctx.supabaseAdmin.from("users").select("id,name,role,outlet_id,active,auth_user_id,pin_hash,pin_setup_hash,pin_setup_expires_at,access_class,setup_revision").eq("id",userId).maybeSingle();
  if(!user||!user.active)return json({error:"Account not available."},401);
  if(user.access_class==="ADMIN")return json({error:"Owner account does not use staff onboarding."},400);
  if(user.auth_user_id||user.pin_hash)return json({error:"This account is already set up. Sign in with your PIN or ask the owner to reset access."},400);


  const pinOnly=clean(form.get("action"))==="reset_pin";
  if(user.pin_setup_hash||pinOnly){
   if(!user.pin_setup_hash||!user.pin_setup_expires_at||new Date(user.pin_setup_expires_at).getTime()<Date.now()||await sha256(clean(form.get("setup_code")))!==user.pin_setup_hash)return json({error:"Enter the temporary PIN supplied by your administrator, or ask for another reset."},401);
  }
  if(user.pin_setup_hash&&newPin===clean(form.get("setup_code")))return json({error:"Choose a new PIN different from the temporary PIN."},400);
  const fields={
   full_legal_name:clean(form.get("full_legal_name")),date_of_birth:clean(form.get("date_of_birth")),father_name:clean(form.get("father_name")),
   nationality:clean(form.get("nationality")),mobile_phone:clean(form.get("mobile_phone")),home_address:clean(form.get("home_address")),
   emergency_contact_name:clean(form.get("emergency_contact_name")),emergency_contact_relation:clean(form.get("emergency_contact_relation")),
   emergency_contact_phone:clean(form.get("emergency_contact_phone")),identity_type:clean(form.get("identity_type")),identity_number:clean(form.get("identity_number"))
  };
  if(!pinOnly&&Object.values(fields).some(v=>!v))return json({error:"Please complete all required onboarding details."},400);
  const doc=form.get("identity_document"), photo=form.get("profile_photo");
  if(!pinOnly&&(!(doc instanceof File)||doc.size===0))return json({error:"Upload your identity document."},400);
  if(!pinOnly&&(!(photo instanceof File)||photo.size===0))return json({error:"Upload your profile photo."},400);
  if(!pinOnly&&((doc as File).size>6291456||(photo as File).size>5242880))return json({error:"One of the uploaded files is too large."},400);

  const uploaded:{bucket:string,path:string}[]=[];
  let authUserId:string|null=null;
  try{
   let profile:Record<string,unknown>|null=null;
   if(!pinOnly){
    const types:Record<string,string>={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","application/pdf":"pdf"};
    if(!["image/jpeg","image/png","application/pdf"].includes((doc as File).type)||!["image/jpeg","image/png","image/webp"].includes((photo as File).type))return json({error:"Choose a JPG, PNG or PDF identity document and an image profile photo."},400);
    const stamp=crypto.randomUUID();
    const docPath=`${user.id}/identity-${stamp}.${types[(doc as File).type]}`;
    const photoPath=`${user.id}/profile-${stamp}.${types[(photo as File).type]}`;
    for(const [bucket,path,file] of [["employee-documents",docPath,doc],["employee-photos",photoPath,photo]] as [string,string,File][]){
     const {error}=await ctx.supabaseAdmin.storage.from(bucket).upload(path,file,{contentType:file.type,upsert:false});
     if(error)throw new Error("Document upload failed. Please try again.");
     uploaded.push({bucket,path});
    }
    profile={...fields,identity_document_path:docPath,profile_photo_path:photoPath};
   }
   // A new Auth identity keeps old reset sessions detached and avoids duplicate-email failures.
   const email=`${crypto.randomUUID()}@login.chaitracker.local`;
   const internalPassword=staffPassword(user.id,newPin);
   const created=await ctx.supabaseAdmin.auth.admin.createUser({email,password:internalPassword,email_confirm:true});
   authUserId=created.data?.user?.id??null;
   if(created.error||!authUserId)throw new Error("Could not create your secure PIN account. Please try again.");
   const saved=await ctx.supabaseAdmin.rpc("complete_staff_onboarding",{p_user_id:user.id,p_revision:user.setup_revision,p_auth_id:authUserId,p_profile:profile,p_setup_code:clean(form.get("setup_code"))||null});
   if(saved.error)throw new Error(saved.error.message);
   return json({success:true,message:"Setup complete. Sign in with your new PIN."});
  }catch(error){
   for(const file of uploaded)await ctx.supabaseAdmin.storage.from(file.bucket).remove([file.path]);
   if(authUserId)await ctx.supabaseAdmin.auth.admin.deleteUser(authUserId);
   return json({error:(error as Error).message||"Unable to complete setup."},400);
  }
 }catch(e){console.error(e);return json({error:"Unable to complete onboarding."},500);}
})};
