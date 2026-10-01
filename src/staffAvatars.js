const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const photoUrls=new Map();

export async function loadStaffAvatars(supabase,ids=null){
  const{data,error}=await supabase.rpc('get_staff_avatar_data',{p_staff_ids:ids});
  if(error)throw new Error(error.message);
  const rows=Array.isArray(data)?data:[];
  await Promise.all(rows.map(async row=>{
    if(!row.photo_path)return;
    const cached=photoUrls.get(row.photo_path);
    if(cached&&cached.expires>Date.now()){row.photo_url=cached.url;return;}
    const{data:signed,error:signError}=await supabase.storage.from('employee-photos').createSignedUrl(row.photo_path,3600);
    if(!signError&&signed?.signedUrl){row.photo_url=signed.signedUrl;photoUrls.set(row.photo_path,{url:row.photo_url,expires:Date.now()+55*60000});}
  }));
  return new Map(rows.map(row=>[Number(row.staff_id),row]));
}

export function staffAvatar(staff,avatar,size=''){
  const id=Number(staff.staff_id??staff.id),name=staff.name||staff.staff_name||'?';
  const status=avatar?avatar.checked_in?'checked-in':'not-checked-in':'unknown';
  const label=name+' · '+(avatar?avatar.checked_in?'Checked in':'Not checked in':'Profile picture');
  return `<span class="staff-avatar ${status} ${size}" data-avatar-staff="${id}" data-avatar-size="${escape(size)}" role="img" aria-label="${escape(label)}" title="${escape(label+(avatar?.business_date?' · '+avatar.business_date:''))}"><span class="staff-avatar-content"><span>${escape(name.trim().charAt(0).toUpperCase())}</span>${avatar?.photo_url?`<img data-avatar-image src="${escape(avatar.photo_url)}" alt="" loading="lazy">`:''}</span></span>`;
}

export function bindAvatarImages(root=document){
  root.querySelectorAll('[data-avatar-image]').forEach(img=>{
    if(img.complete&&img.naturalWidth===0){img.remove();return;}
    img.addEventListener('error',()=>img.remove(),{once:true});
  });
}

export async function refreshStaffAvatarElements(supabase,ids){
  const avatars=await loadStaffAvatars(supabase,ids);
  for(const [id,avatar] of avatars){
    document.querySelectorAll(`[data-avatar-staff="${id}"]`).forEach(el=>{
      // Attendance history uses each row's date; current profile rings use the café day.
      if(el.closest('.attendance-row'))return;
      el.outerHTML=staffAvatar(avatar,avatar,el.dataset.avatarSize||'');
    });
  }
  bindAvatarImages();
  return avatars;
}

export async function editProfilePhoto(supabase,staff){
  const id=Number(staff.staff_id??staff.id),avatars=await loadStaffAvatars(supabase,[id]),avatar=avatars.get(id);
  if(!avatar?.user_id)throw new Error('Staff login profile not found.');
  return new Promise(resolve=>{
    const overlay=document.createElement('div');overlay.className='profile-photo-overlay';
    overlay.innerHTML=`<section class="profile-photo-dialog" role="dialog" aria-modal="true" aria-labelledby="profilePhotoTitle"><h2 id="profilePhotoTitle">Profile picture</h2><p>${escape(staff.name||avatar.name)}</p><div class="profile-photo-preview">${staffAvatar(avatar,avatar,'large')}</div><div class="profile-photo-choose"><button type="button" data-photo-camera>Take selfie</button><button type="button" data-photo-file>Choose photo</button></div><input type="file" data-photo-camera-input accept="image/jpeg,image/png,image/webp" capture="user" hidden><input type="file" data-photo-file-input accept="image/jpeg,image/png,image/webp" hidden><p data-photo-error class="form-error" role="status"></p><div class="profile-photo-actions"><button type="button" data-photo-cancel>Cancel</button><button type="button" data-photo-save class="primary" disabled>Save picture</button></div></section>`;
    document.body.append(overlay);
    let chosen=null,previewUrl=null,busy=false;
    const previousFocus=document.activeElement,previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
    const close=saved=>{if(previewUrl)URL.revokeObjectURL(previewUrl);overlay.remove();document.body.style.overflow=previousOverflow;previousFocus?.focus();resolve(saved);};
    overlay.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&!busy){event.preventDefault();close(false);}
      if(event.key==='Tab'){
        const focusable=[...overlay.querySelectorAll('button:not(:disabled)')],first=focusable[0],last=focusable.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }
    });
    const save=overlay.querySelector('[data-photo-save]'),cancel=overlay.querySelector('[data-photo-cancel]'),error=overlay.querySelector('[data-photo-error]');
    const choose=file=>{
      if(!file)return;
      if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>5242880){error.textContent='Choose a JPG, PNG or WebP image up to 5 MB.';return;}
      error.textContent='';chosen=file;save.disabled=false;
      if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(file);
      const preview=overlay.querySelector('.profile-photo-preview');preview.innerHTML=staffAvatar(avatar,{...avatar,photo_url:previewUrl},'large');bindAvatarImages(preview);
    };
    for(const source of ['camera','file']){
      const input=overlay.querySelector(`[data-photo-${source}-input]`);
      overlay.querySelector(`[data-photo-${source}]`).onclick=()=>input.click();
      input.onchange=()=>choose(input.files?.[0]);
    }
    cancel.onclick=()=>{if(!busy)close(false);};
    save.onclick=async()=>{
      if(!chosen||busy)return;
      busy=true;save.disabled=true;cancel.disabled=true;save.textContent='Saving…';
      const ext=({'image/jpeg':'jpg','image/png':'png','image/webp':'webp'})[chosen.type];
      const path=`${avatar.user_id}/profile-${crypto.randomUUID()}.${ext}`;
      try{
        const{error:uploadError}=await supabase.storage.from('employee-photos').upload(path,chosen,{contentType:chosen.type,upsert:false});
        if(uploadError)throw uploadError;
        const{error:updateError}=await supabase.rpc('set_employee_profile_photo',{p_staff_id:id,p_path:path});
        if(updateError){await supabase.storage.from('employee-photos').remove([path]);throw updateError;}
        await refreshStaffAvatarElements(supabase,[id]);close(true);
      }catch(err){error.textContent=err.message||'Could not save the profile picture.';busy=false;save.disabled=false;cancel.disabled=false;save.textContent='Save picture';}
    };
    bindAvatarImages(overlay);overlay.querySelector('[data-photo-camera]').focus();
  });
}
