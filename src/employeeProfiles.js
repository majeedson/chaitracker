const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const field=(label,value)=>`<div><dt>${escape(label)}</dt><dd>${escape(value||'—')}</dd></div>`;
export function onboardingDetailsHtml(data={}){
 if(data.deleted_at)return '<div class="notice">Account deleted. Personal onboarding data and files have been cleared; employment and financial history are retained.</div>';
 const groups=[['Personal details',[['Full legal name','full_legal_name'],['Date of birth','date_of_birth'],["Father’s name",'father_name'],['Nationality','nationality'],['Mobile number','mobile_phone'],['Home address','home_address']]],
  ['Emergency contact',[['Contact name','emergency_contact_name'],['Relationship','emergency_contact_relation'],['Phone number','emergency_contact_phone']]],
  ['Identity',[['Document type','identity_type'],['Document number','identity_number']]],
  ['Setup confirmation',[['Onboarding status','onboarding_status'],['Started','onboarding_started_at'],['Completed','onboarding_completed_at'],['Details confirmed','details_confirmed_at']]]];
 return groups.map(([title,fields])=>`<section class="onboarding-detail-group"><h4>${title}</h4><dl class="onboarding-details">${fields.map(([label,key])=>field(label,data[key])).join('')}</dl></section>`).join('')+
 `<div class="profile-document-actions">${[['identity_document_path','Identity document'],['profile_photo_path','Profile photo']].map(([key,label])=>data[key]?`<button type="button" class="secondary" data-profile-document="${key}">View ${label.toLowerCase()}</button>`:`<span class="hint">${label}: not uploaded</span>`).join('')}</div><p class="section-help">Personal details and identity documents are visible only to administrators and the employee. PINs are never displayed.</p><p data-document-error class="form-error" role="status"></p>`;
}
export function bindProfileDocuments(root,supabase,data){
 root.querySelectorAll('[data-profile-document]').forEach(button=>button.onclick=async()=>{
  const error=root.querySelector('[data-document-error]');error.textContent='';button.disabled=true;
  // Open synchronously so mobile popup protection does not block the document.
  const popup=window.open('about:blank','_blank');if(popup)popup.opener=null;
  try{
   const key=button.dataset.profileDocument,bucket=key==='identity_document_path'?'employee-documents':'employee-photos';
   const {data:signed,error:failure}=await supabase.storage.from(bucket).createSignedUrl(data[key],60);
   if(failure||!signed?.signedUrl)throw new Error(failure?.message||'Document unavailable.');
   const url=new URL(signed.signedUrl);if(!['https:','http:'].includes(url.protocol))throw new Error('Invalid document link.');
   if(popup)popup.location.replace(url.href);else{error.innerHTML=`Popup blocked. <a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">Open document</a> (link expires in 60 seconds).`;}
  }catch(failure){popup?.close();error.textContent=failure.message||'Unable to open document.';}finally{button.disabled=false;}
 });
}
export async function renderMyProfile(view,supabase,profile){
 const {data,error}=await supabase.rpc('get_employee_profile_data',{p_staff_id:null});
 if(error||!data){view.innerHTML='<h2>My profile</h2><p class="form-error">'+escape(error?.message||'No employee profile is linked to this account.')+'</p>';return;}
 view.innerHTML=`<span class="eyebrow">My profile</span><h2>${escape(data.name)}</h2><p class="section-help">${escape(data.role)} · ${escape(data.outlet_name)}</p><dl class="onboarding-details">${field('Joining date',data.joining_date)}${field('Employment status',data.employment_status)}</dl>${onboardingDetailsHtml(data)}`;
 bindProfileDocuments(view,supabase,data);
}
export async function deleteUserDialog(supabase,userId){
 const {data:impact,error}=await supabase.rpc('superuser_user_deletion_impact',{p_user_id:userId});
 if(error)throw new Error(error.message);
 if(!impact)throw new Error('User not found.');
 return new Promise(resolve=>{
  const overlay=document.createElement('div');overlay.className='profile-photo-overlay';
  const blocked=Number(impact.pending_advances)>0||Number(impact.pending_leave)>0||Number(impact.unfinished_transfers)>0;
  const rupees=value=>'₹'+Number(value||0).toLocaleString('en-IN');
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
  overlay.innerHTML=`<section class="profile-photo-dialog user-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="deleteUserTitle"><h2 id="deleteUserTitle">${impact.deleted_at?'Finish deletion cleanup':'Delete user'}</h2><p><strong>${escape(impact.name)}</strong></p><p>Login access, personal onboarding data and uploaded ID/profile files are removed. The historical employee reference, attendance, salaries, advances, transfers and audit records remain.</p><dl class="onboarding-details">${field('Attendance records',String(impact.attendance_records||0))}${field('Salary records',String(impact.salary_records||0))}${field('Unpaid finalized salary',rupees(impact.unpaid_salary))}${field('Transfer earnings due',rupees(impact.transfer_earnings_due))}${field('Advance/EMI balance',rupees(impact.advance_balance))}${field('Legacy loan balance',rupees(impact.legacy_loan_balance))}${field('Draft payrolls',String(impact.draft_payrolls||0))}${field('Pending advance requests',String(impact.pending_advances||0))}${field('Pending leave requests',String(impact.pending_leave||0))}${field('Unfinished transfers',String(impact.unfinished_transfers||0))}</dl>${blocked?'<p class="form-error">Resolve pending requests and hand over unfinished transfers before deleting this user.</p>':''}${impact.staff_id&&!impact.deleted_at?`<label>Actual last working date<input data-delete-date type="date" min="${escape(impact.joining_date||'')}" max="${today}" value="${escape(impact.employment_end_date||today)}" ${impact.employment_end_date?'disabled':''}></label>`:''}<label>Type <strong>${escape(impact.name)}</strong> to confirm<input data-delete-name autocomplete="off"></label><label class="confirm-row"><input type="checkbox" data-delete-confirm> I understand this does not settle or forgive outstanding amounts, and cleared personal data must be collected again if they rejoin.</label><p data-delete-error class="form-error" role="status"></p><div class="profile-photo-actions"><button type="button" data-delete-cancel>Cancel</button><button type="button" class="danger" data-delete-submit disabled>${impact.deleted_at?'Retry cleanup':'Delete user'}</button></div></section>`;
  document.body.append(overlay);
  const previousFocus=document.activeElement,previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
  let busy=false;
  const close=result=>{overlay.remove();document.body.style.overflow=previousOverflow;previousFocus?.focus();resolve(result);};
  const submit=overlay.querySelector('[data-delete-submit]'),cancel=overlay.querySelector('[data-delete-cancel]'),name=overlay.querySelector('[data-delete-name]'),check=overlay.querySelector('[data-delete-confirm]'),date=overlay.querySelector('[data-delete-date]'),message=overlay.querySelector('[data-delete-error]');
  const validate=()=>submit.disabled=busy||blocked||name.value!==impact.name||!check.checked||(date&&!date.checkValidity());
  name.oninput=validate;check.onchange=validate;if(date)date.onchange=validate;
  cancel.onclick=()=>{if(!busy)close(null);};
  overlay.onkeydown=event=>{
   if(event.key==='Escape'&&!busy)close(null);
   if(event.key==='Tab'){const focusable=[...overlay.querySelectorAll('button:not(:disabled),input:not(:disabled)')],first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
  };
  submit.onclick=async()=>{
   validate();if(submit.disabled)return;busy=true;validate();cancel.disabled=true;message.textContent='Deleting…';
   try{
    const {data,error}=await supabase.functions.invoke('chaitracker-delete-user',{body:{user_id:userId,confirmation:name.value,last_working_date:date?.value||null}});
    if(error){let detail=error.message;try{detail=(await error.context.json()).error||detail;}catch{}throw new Error(detail);}
    if(!data?.success)throw new Error(data?.error||'Deletion failed.');close(data);
   }catch(failure){message.textContent=failure.message||'Deletion failed.';busy=false;cancel.disabled=false;validate();}
  };
  name.focus();
 });
}
