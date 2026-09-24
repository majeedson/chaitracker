const APP_BUILD = 47;
const modules = [
  ['dashboard', 'Dashboard'],
  ['attendance', 'Attendance'],
  ['salary', 'Salary'],
  ['stock', 'Stock'],
  ['purchase', 'Purchase'],
  ['summary', 'Daily Summary'],
  ['po', 'Purchase Order'],
  ['delta', 'Delta'],
  ['people', 'People']
];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function icon(name, size=20) {
  const paths={
    home:'<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/><path d="M9 20v-6h6v6"/>',
    attendance:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    stock:'<path d="m4 7 8-4 8 4-8 4-8-4Z"/><path d="m4 7v10l8 4 8-4V7"/><path d="M12 11v10"/>',
    purchase:'<path d="M6 7h15l-2 8H8L6 3H3"/><circle cx="9" cy="19" r="1"/><circle cx="18" cy="19" r="1"/>',
    po:'<path d="M6 3h12v18H6z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    summary:'<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
    delta:'<path d="m7 7 5-4 5 4M12 3v8"/><path d="m17 17-5 4-5-4M12 21v-8"/>',
    salary:'<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M7 9H5v6h2M17 9h2v6h-2"/>',
    dashboard:'<path d="M4 13a8 8 0 1 1 16 0"/><path d="m12 13 4-4"/><path d="M5 18h14"/>',
    people:'<circle cx="9" cy="8" r="3"/><path d="M3 20c0-4 2-7 6-7s6 3 6 7"/><circle cx="17" cy="9" r="2"/><path d="M16 14c3 0 5 2 5 5"/>',
    user:'<circle cx="12" cy="8" r="4"/><path d="M4 21c0-5 3-8 8-8s8 3 8 8"/>',
    heart:'<path d="M20.8 5.8c-2-2-5.2-2-7.2 0L12 7.4l-1.6-1.6a5.1 5.1 0 0 0-7.2 7.2L12 21l8.8-8a5.1 5.1 0 0 0 0-7.2Z"/>',
    id:'<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M5.5 16c.7-2 4.3-2 5 0M13 10h5M13 14h5"/>',
    camera:'<path d="M4 8h4l2-3h4l2 3h4v11H4z"/><circle cx="12" cy="13" r="3"/>',
    check:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    menu:'<path d="M4 7h16M4 12h16M4 17h16"/>',
    close:'<path d="m6 6 12 12M18 6 6 18"/>',
    logout:'<path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9"/>',
    lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'
  };
  return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.home}</svg>`;
}

function applyTheme(outlet) {
  const color=outlet?.theme_color||'#CB202D';
  document.documentElement.style.setProperty('--accent',color);
  document.documentElement.style.setProperty('--accent-soft',color+'18');
}

export async function renderApp(root, supabase) {
  const { data: sessionData } = await supabase.auth.getSession();
  const authSession = sessionData?.session;

  if (!authSession) {
    await renderLogin(root, supabase);
    return;
  }

  const { data: authUser } = await supabase.auth.getUser();
  const authId = authUser?.user?.id;
  const { data: profile } = await supabase
    .from('users')
    .select('id,name,role,outlet_id,can_switch_outlet,active,access_class,is_super_user,outlets(name,theme_key,theme_color)')
    .eq('auth_user_id', authId)
    .maybeSingle();

  if (!profile?.active) {
    await supabase.auth.signOut();
    await renderLogin(root, supabase);
    return;
  }

  applyTheme(profile.outlets);
  renderWorkspace(root, supabase, profile);
}

async function renderLogin(root, supabase) {
  const [{ data: outlets }, { data: directory, error }] = await Promise.all([
    supabase.from('outlets').select('id,name,theme_key,theme_color').order('id'),
    supabase.from('login_directory').select('id,name,role,outlet_id,outlet_name,can_switch_outlet,auth_enrolled,pin_set,theme_key,theme_color,onboarding_status,access_class,is_super_user,staff_id').order('name')
  ]);
  if (error) { root.innerHTML='<main class="login-shell"><section class="login-card"><h1>CafeTracker</h1><p>Login setup unavailable.</p></section></main>'; return; }

  root.innerHTML=`
    <main class="login-shell">
      <section class="login-card">
        <div class="brand-lockup"><div class="brand-mark">${icon('home',22)}</div><div><div class="login-brand">CafeTracker</div><div class="login-subtitle">Your café. Your day. · Build ${APP_BUILD}</div></div></div>
        <div id="login-picker">
          <div class="login-mode-tabs"><button type="button" class="active" data-login-mode="staff">Staff</button><button type="button" data-login-mode="admin">Admin</button></div>
          <div class="login-step" id="login-cafe-step"><label>Café</label><select id="outlet-select"><option value="">Select your café</option>${(outlets||[]).map(o=>`<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}</select></div>
          <div class="login-step"><label>Your name</label><select id="name-select" disabled><option value="">Select your café first</option></select></div>
          <div id="pin-login-area"><div class="login-step"><label>PIN</label><div class="input-with-icon">${icon('lock',19)}<input id="pin" inputmode="numeric" autocomplete="current-password" maxlength="8" type="password" placeholder="Enter PIN" disabled></div></div><button id="login-btn" type="button" class="primary full" disabled>Sign in <span>→</span></button></div>
          <div id="onboarding-start" hidden>
            <div class="onboard-invite"><div class="feature-icon">${icon('user',22)}</div><div><strong>First time here?</strong><span>Use PIN 1234 to set up your account.</span></div></div>
            <button id="start-onboarding" type="button" class="primary full">Set up my account <span>→</span></button>
          </div>
          <p id="login-error" class="login-status" hidden></p>
        </div>
        <div id="onboarding-shell" hidden></div>
      </section>
    </main>`;

  const outletSelect=root.querySelector('#outlet-select'),nameSelect=root.querySelector('#name-select'),pin=root.querySelector('#pin'),loginBtn=root.querySelector('#login-btn');
  const loginArea=root.querySelector('#pin-login-area'),onboardingStart=root.querySelector('#onboarding-start'),picker=root.querySelector('#login-picker'),onboardingShell=root.querySelector('#onboarding-shell'),errorBox=root.querySelector('#login-error'),cafeStep=root.querySelector('#login-cafe-step');
  let selectedPerson=null,loginMode='staff';
  const resetLoginState=()=>{selectedPerson=null;pin.value='';pin.disabled=true;loginBtn.disabled=true;loginArea.hidden=false;onboardingStart.hidden=true;errorBox.hidden=true;};
  const renderLoginMode=()=>{
    resetLoginState();
    const isAdmin=loginMode==='admin';cafeStep.hidden=isAdmin;
    if(isAdmin){outletSelect.value='';applyTheme(null);const admins=(directory||[]).filter(u=>u.access_class==='ADMIN');nameSelect.disabled=false;nameSelect.innerHTML='<option value="">Select your name</option>'+admins.map(u=>`<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');}
    else{nameSelect.disabled=true;nameSelect.innerHTML='<option value="">Select your café first</option>';}
  };
  root.querySelectorAll('[data-login-mode]').forEach(btn=>btn.onclick=()=>{loginMode=btn.dataset.loginMode;root.querySelectorAll('[data-login-mode]').forEach(b=>b.classList.toggle('active',b===btn));renderLoginMode();});

  outletSelect.onchange=()=>{
    const outlet=(outlets||[]).find(o=>Number(o.id)===Number(outletSelect.value)); applyTheme(outlet);
    selectedPerson=null; const people=(directory||[]).filter(u=>u.access_class!=='ADMIN'&&Number(u.outlet_id)===Number(outletSelect.value));
    nameSelect.disabled=!outletSelect.value;
    const duplicateNames=new Map();people.forEach(u=>{const k=(u.name||'').trim().toLowerCase();duplicateNames.set(k,(duplicateNames.get(k)||0)+1);});
    nameSelect.innerHTML=outletSelect.value?'<option value="">Select your name</option>'+people.map(u=>{const duplicate=(duplicateNames.get((u.name||'').trim().toLowerCase())||0)>1;const label=duplicate&&u.staff_id?`${u.name} · Staff ID ${u.staff_id}`:u.name;return `<option value="${u.id}">${escapeHtml(label)}</option>`;}).join(''):'<option value="">Select your café first</option>';
    pin.value='';pin.disabled=true;loginBtn.disabled=true;loginArea.hidden=false;onboardingStart.hidden=true;errorBox.hidden=true;
  };

  nameSelect.onchange=()=>{
    selectedPerson=(directory||[]).find(u=>u.id===nameSelect.value)||null;
    if(selectedPerson)applyTheme(selectedPerson);
    const isAdminAccount=selectedPerson?.access_class==='ADMIN';
    const needsOnboarding=!!selectedPerson&&!selectedPerson.pin_set&&!isAdminAccount;
    loginArea.hidden=needsOnboarding; onboardingStart.hidden=!needsOnboarding;
    pin.disabled=!selectedPerson||needsOnboarding; loginBtn.disabled=!selectedPerson||needsOnboarding; errorBox.hidden=true;
    if(selectedPerson&&!needsOnboarding)pin.focus();
  };

  pin.oninput=()=>{pin.value=pin.value.replace(/\\D/g,'').slice(0,8);};
  const submitLogin=async()=>{
    const enteredPin=pin.value.replace(/\\D/g,'').slice(0,8);
    if(enteredPin.length<4){errorBox.textContent='Enter at least 4 digits.';errorBox.hidden=false;return;}
    errorBox.textContent='Signing you in…';errorBox.hidden=false;loginBtn.disabled=true;
    try{
      const response=await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chaitracker-login`,{method:'POST',headers:{'Content-Type':'application/json',apikey:import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY},body:JSON.stringify({user_id:selectedPerson.id,pin:enteredPin})});
      const payload=await response.json();if(!response.ok||!payload.session)throw new Error(payload.error||'Sign-in failed.');
      const {error:sessionError}=await supabase.auth.setSession({access_token:payload.session.access_token,refresh_token:payload.session.refresh_token});if(sessionError)throw sessionError;
      await renderApp(root,supabase);
    }catch(err){errorBox.textContent=err.message||'Unable to sign in.';errorBox.hidden=false;loginBtn.disabled=false;}
  };
  loginBtn.onclick=submitLogin;pin.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();submitLogin();}};

  root.querySelector('#start-onboarding').onclick=()=>renderOnboarding();

  function renderOnboarding(){
    picker.hidden=true;onboardingShell.hidden=false;
    const steps=[
      {key:'welcome',label:'Welcome',icon:'user'},
      {key:'personal',label:'About you',icon:'user'},
      {key:'emergency',label:'Emergency',icon:'heart'},
      {key:'identity',label:'Identity',icon:'id'},
      {key:'photo',label:'Photo',icon:'camera'},
      {key:'review',label:'Review',icon:'check'},
      {key:'pin',label:'PIN',icon:'lock'}
    ];
    let step=0; const state={};
    const draw=()=>{
      const progress=Math.round((step/(steps.length-1))*100);
      let body='';
      if(step===0)body=`<div class="onboard-hero"><div class="feature-icon large">${icon('user',28)}</div><span class="eyebrow">Welcome to CafeTracker</span><h2>Hi, ${escapeHtml(selectedPerson.name)}</h2><p>Enter your first-time PIN to continue. For new or reset staff accounts, this is 1234.</p><label>First-time PIN<div class="input-with-icon">${icon('lock',19)}<input id="ob-setup" inputmode="numeric" maxlength="4" placeholder="Enter 1234" value="${escapeHtml(state.setup_code||'')}"></div></label></div>`;
      if(step===1)body=`<div class="onboard-title"><div class="feature-icon">${icon('user',22)}</div><div><span class="eyebrow">About you</span><h2>Personal details</h2></div></div><div class="form-stack"><label>Display name<input value="${escapeHtml(selectedPerson.name)}" disabled><small>Set by your employer</small></label><label>Full name as shown on your ID<input id="ob-full" value="${escapeHtml(state.full_legal_name||'')}" placeholder="Your full legal name"></label><div class="two-col"><label>Date of birth<input id="ob-dob" type="date" value="${escapeHtml(state.date_of_birth||'')}"></label><label>Nationality<input id="ob-nationality" value="${escapeHtml(state.nationality||'')}" placeholder="Nationality"></label></div><label>Father's name<input id="ob-father" value="${escapeHtml(state.father_name||'')}" placeholder="Father's full name"></label><label>Mobile number<input id="ob-mobile" inputmode="tel" value="${escapeHtml(state.mobile_phone||'')}" placeholder="Phone number"></label><label>Home address<textarea id="ob-address" rows="3" placeholder="Permanent/home address">${escapeHtml(state.home_address||'')}</textarea></label></div>`;
      if(step===2)body=`<div class="onboard-title"><div class="feature-icon">${icon('heart',22)}</div><div><span class="eyebrow">Emergency contact</span><h2>Who should we contact?</h2></div></div><div class="form-stack"><label>Contact name<input id="ob-ec-name" value="${escapeHtml(state.emergency_contact_name||'')}" placeholder="Full name"></label><label>Relationship<input id="ob-ec-rel" value="${escapeHtml(state.emergency_contact_relation||'')}" placeholder="e.g. Parent, spouse, sibling"></label><label>Phone number<input id="ob-ec-phone" inputmode="tel" value="${escapeHtml(state.emergency_contact_phone||'')}" placeholder="Emergency phone number"></label></div>`;
      if(step===3)body=`<div class="onboard-title"><div class="feature-icon">${icon('id',22)}</div><div><span class="eyebrow">Identity</span><h2>Verify your ID</h2></div></div><div class="form-stack"><label>Document type<select id="ob-id-type"><option value="">Choose document</option><option ${state.identity_type==='Aadhaar'?'selected':''}>Aadhaar</option><option ${state.identity_type==='Passport'?'selected':''}>Passport</option><option ${state.identity_type==='Other'?'selected':''}>Other</option></select></label><label>Document number<input id="ob-id-number" value="${escapeHtml(state.identity_number||'')}" placeholder="ID document number"></label><label class="upload-card">${icon('id',26)}<strong>Upload identity document</strong><span>JPG, PNG or PDF · max 6 MB</span><input id="ob-id-file" type="file" accept="image/jpeg,image/png,application/pdf"></label><div id="id-file-name" class="file-name">${state.identity_document?.name?escapeHtml(state.identity_document.name):''}</div></div>`;
      if(step===4)body=`<div class="onboard-title"><div class="feature-icon">${icon('camera',22)}</div><div><span class="eyebrow">Profile photo</span><h2>Add a clear photo</h2></div></div><label class="upload-card photo-upload">${icon('camera',30)}<strong>Take or upload photo</strong><span>Clear front-facing photo · max 5 MB</span><input id="ob-photo" type="file" accept="image/jpeg,image/png,image/webp" capture="user"></label><div id="photo-file-name" class="file-name">${state.profile_photo?.name?escapeHtml(state.profile_photo.name):''}</div>`;
      if(step===5)body=`<div class="onboard-title"><div class="feature-icon">${icon('check',22)}</div><div><span class="eyebrow">Almost done</span><h2>Review your details</h2></div></div><div class="review-list"><div><span>Employee</span><strong>${escapeHtml(selectedPerson.name)}</strong></div><div><span>Full legal name</span><strong>${escapeHtml(state.full_legal_name||'—')}</strong></div><div><span>Nationality</span><strong>${escapeHtml(state.nationality||'—')}</strong></div><div><span>Emergency contact</span><strong>${escapeHtml(state.emergency_contact_name||'—')} · ${escapeHtml(state.emergency_contact_relation||'')}</strong></div><div><span>Identity</span><strong>${escapeHtml(state.identity_type||'—')} · on file</strong></div></div><label class="confirm-row"><input id="ob-confirm" type="checkbox"> I confirm these details are correct.</label>`;
      if(step===6)body=`<div class="onboard-hero"><div class="feature-icon large">${icon('lock',28)}</div><span class="eyebrow">Secure your account</span><h2>Create your private PIN</h2><p>Use 4–8 digits. Your employer does not need to know this PIN.</p><label>New PIN<input id="ob-pin" type="password" inputmode="numeric" maxlength="8" placeholder="4–8 digits"></label><label>Confirm PIN<input id="ob-pin2" type="password" inputmode="numeric" maxlength="8" placeholder="Repeat PIN"></label></div>`;
      onboardingShell.innerHTML=`<div class="onboard-progress"><div><button id="ob-close" class="icon-button" aria-label="Back to login">←</button><span>${step+1} of ${steps.length}</span></div><div class="progress-track"><i style="width:${progress}%"></i></div></div><div class="onboard-body">${body}<p id="ob-error" class="form-error" hidden></p></div><div class="onboard-actions">${step>0?'<button id="ob-back" class="secondary">Back</button>':''}<button id="ob-next" class="primary">${step===steps.length-1?'Finish & create PIN':'Continue'} <span>→</span></button></div>`;
      onboardingShell.querySelector('#ob-close').onclick=()=>{onboardingShell.hidden=true;picker.hidden=false;};
      if(step>0)onboardingShell.querySelector('#ob-back').onclick=()=>{saveStep();step--;draw();};
      const idf=onboardingShell.querySelector('#ob-id-file');if(idf)idf.onchange=()=>{state.identity_document=idf.files[0];onboardingShell.querySelector('#id-file-name').textContent=state.identity_document?.name||'';};
      const pf=onboardingShell.querySelector('#ob-photo');if(pf)pf.onchange=()=>{state.profile_photo=pf.files[0];onboardingShell.querySelector('#photo-file-name').textContent=state.profile_photo?.name||'';};
      onboardingShell.querySelector('#ob-next').onclick=async()=>{if(!validateStep())return;saveStep();if(step===0){const btn=onboardingShell.querySelector('#ob-next'),err=onboardingShell.querySelector('#ob-error');btn.disabled=true;btn.textContent='Verifying…';try{const response=await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chaitracker-onboarding`,{method:'POST',headers:{apikey:import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},body:JSON.stringify({action:'validate_setup',user_id:selectedPerson.id,setup_code:state.setup_code})});const payload=await response.json();if(!response.ok||!payload.success)throw new Error(payload.error||'First-time PIN could not be verified.');step++;draw();return;}catch(e){err.textContent=e.message||'First-time PIN could not be verified.';err.hidden=false;btn.disabled=false;btn.innerHTML='Verify & continue <span>→</span>';return;}}if(step<steps.length-1){step++;draw();}else await submitOnboarding();};
    };
    const saveStep=()=>{
      const get=id=>onboardingShell.querySelector(id)?.value?.trim();
      if(step===0)state.setup_code=get('#ob-setup')||state.setup_code;
      if(step===1)Object.assign(state,{full_legal_name:get('#ob-full'),date_of_birth:get('#ob-dob'),nationality:get('#ob-nationality'),father_name:get('#ob-father'),mobile_phone:get('#ob-mobile'),home_address:get('#ob-address')});
      if(step===2)Object.assign(state,{emergency_contact_name:get('#ob-ec-name'),emergency_contact_relation:get('#ob-ec-rel'),emergency_contact_phone:get('#ob-ec-phone')});
      if(step===3)Object.assign(state,{identity_type:get('#ob-id-type'),identity_number:get('#ob-id-number')});
    };
    const validateStep=()=>{
      const err=onboardingShell.querySelector('#ob-error');let msg='';
      if(step===0&&!/^\\d{4}$/.test(onboardingShell.querySelector('#ob-setup').value))msg='Enter the 4-digit first-time PIN.';
      if(step===1&&['#ob-full','#ob-dob','#ob-nationality','#ob-father','#ob-mobile','#ob-address'].some(id=>!onboardingShell.querySelector(id).value.trim()))msg='Please complete all personal details.';
      if(step===2&&['#ob-ec-name','#ob-ec-rel','#ob-ec-phone'].some(id=>!onboardingShell.querySelector(id).value.trim()))msg='Please complete the emergency contact details.';
      if(step===3&&(!onboardingShell.querySelector('#ob-id-type').value||!onboardingShell.querySelector('#ob-id-number').value.trim()||!state.identity_document))msg='Choose an ID type, enter its number and upload the document.';
      if(step===4&&!state.profile_photo)msg='Please add a profile photo.';
      if(step===5&&!onboardingShell.querySelector('#ob-confirm').checked)msg='Please confirm that your details are correct.';
      if(step===6){const a=onboardingShell.querySelector('#ob-pin').value,b=onboardingShell.querySelector('#ob-pin2').value;if(!/^\\d{4,8}$/.test(a))msg='Choose a 4–8 digit PIN.';else if(a!==b)msg='The PINs do not match.';}
      if(msg){err.textContent=msg;err.hidden=false;return false;}return true;
    };
    const submitOnboarding=async()=>{
      const btn=onboardingShell.querySelector('#ob-next'),err=onboardingShell.querySelector('#ob-error');btn.disabled=true;btn.textContent='Creating your account…';
      try{
        const fd=new FormData();Object.entries(state).forEach(([k,v])=>{if(v instanceof File)fd.append(k==='identity_document'?'identity_document':'profile_photo',v);else if(v!=null)fd.append(k,String(v));});
        fd.append('user_id',selectedPerson.id);fd.append('new_pin',onboardingShell.querySelector('#ob-pin').value);
        const response=await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chaitracker-onboarding`,{method:'POST',headers:{apikey:import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY},body:fd});
        const payload=await response.json();if(!response.ok||!payload.success)throw new Error(payload.error||'Onboarding failed.');
        if(payload.session){await supabase.auth.setSession({access_token:payload.session.access_token,refresh_token:payload.session.refresh_token});await renderApp(root,supabase);return;}
        onboardingShell.innerHTML='<div class="onboard-success">'+icon('check',34)+'<h2>You’re all set</h2><p>Your CafeTracker profile is ready. Sign in with your new PIN.</p><button id="return-login" class="primary full">Back to sign in</button></div>';
        onboardingShell.querySelector('#return-login').onclick=()=>renderLogin(root,supabase);
      }catch(e){err.textContent=e.message||'Unable to complete onboarding.';err.hidden=false;btn.disabled=false;btn.innerHTML='Finish & create PIN <span>→</span>';}
    };
    draw();
  }
}
function renderWorkspace(root, supabase, profile) {
  const outletContextKey='cafetracker.adminOutlet';
  if(profile.access_class==='ADMIN'){const saved=localStorage.getItem(outletContextKey);profile.context_outlet_id=saved&&saved!=='all'?Number(saved):null;}
  const isAdmin = profile.access_class === 'ADMIN';
  const isManager = ['Manager','Ops Manager'].includes(profile.role);
  const allowedIds = isAdmin
    ? ['dashboard','attendance','salary','stock','purchase','summary','po','delta','people']
    : isManager
      ? ['attendance','salary','stock','purchase','summary']
      : ['attendance','salary','stock','purchase'];
  const visibleModules = modules.filter(([id]) => allowedIds.includes(id));
  const landing = isAdmin ? 'dashboard' : 'attendance';

  root.innerHTML = `
    <div class="app-shell">
      <header class="topbar app-topbar">
        <div class="topbar-leading">
          <button id="drawer-open" class="nav-icon-button" aria-label="Open app menu">${icon('menu',22)}</button>
          <button id="brand-home" class="brand-button" aria-label="Go to landing page">
            <span class="brand">CafeTracker</span>
            <span class="subtitle">${escapeHtml(profile.name)} · ${isAdmin?'Admin':escapeHtml(profile.role)}</span>
          </button>
        </div>
        <div class="topbar-actions">
          ${isAdmin?'<select id="global-outlet" class="outlet-badge global-outlet"><option value="all">All cafés</option></select>':`<span class="outlet-badge">${escapeHtml(profile.outlets?.name||'Assigned outlet')}</span>`}
          <button id="logout" class="nav-icon-button" aria-label="Logout">${icon('logout',20)}</button>
        </div>
      </header>
      <div id="drawer-scrim" class="drawer-scrim" hidden></div>
      <aside id="app-drawer" class="app-drawer" aria-hidden="true">
        <div class="drawer-head"><div><div class="drawer-brand">CafeTracker</div><div class="drawer-caption">${isAdmin?'Administration':'Your workspace'}</div></div><button id="drawer-close" class="nav-icon-button" aria-label="Close menu">${icon('close',22)}</button></div>
        <nav class="drawer-nav">${visibleModules.map(([id,label])=>`<button class="drawer-item" data-module="${id}"><span class="drawer-item-icon">${icon(id,21)}</span><span>${label}</span><span class="drawer-chevron">›</span></button>`).join('')}</nav>
        <div class="drawer-footer"><span class="outlet-dot"></span><div><strong>${escapeHtml(profile.outlets?.name || (isAdmin?'All cafés':'CafeTracker'))}</strong><small>${escapeHtml(profile.name)}</small></div></div>
      </aside>
      <main class="content app-content"><section id="module-view" class="card module-view"></section></main>
    </div>`;

  const drawer=root.querySelector('#app-drawer'),scrim=root.querySelector('#drawer-scrim'),view=root.querySelector('#module-view');
  let currentModule=landing;
  if(isAdmin){const sel=root.querySelector('#global-outlet');supabase.from('outlets').select('id,name,theme_key,theme_color').order('id').then(({data})=>{(data||[]).forEach(o=>sel.insertAdjacentHTML('beforeend',`<option value="${o.id}">${escapeHtml(o.name)}</option>`));sel.value=profile.context_outlet_id?String(profile.context_outlet_id):'all';if(profile.context_outlet_id){const o=(data||[]).find(x=>Number(x.id)===profile.context_outlet_id);if(o)applyTheme(o);}sel.onchange=()=>{localStorage.setItem(outletContextKey,sel.value);profile.context_outlet_id=sel.value==='all'?null:Number(sel.value);const o=(data||[]).find(x=>Number(x.id)===profile.context_outlet_id);applyTheme(o||null);openModule(currentModule);};});}
  const openDrawer=()=>{drawer.classList.add('open');drawer.setAttribute('aria-hidden','false');scrim.hidden=false;requestAnimationFrame(()=>scrim.classList.add('show'));};
  const closeDrawer=()=>{drawer.classList.remove('open');drawer.setAttribute('aria-hidden','true');scrim.classList.remove('show');setTimeout(()=>{scrim.hidden=true;},180);};
  const openModule=async module=>{
    currentModule=module;
    root.querySelectorAll('.drawer-item').forEach(b=>b.classList.toggle('active',b.dataset.module===module));
    closeDrawer();window.scrollTo({top:0,behavior:'instant'});await loadModule(view,supabase,profile,module);view.scrollIntoView({block:'start',behavior:'instant'});
  };
  root.querySelector('#drawer-open').onclick=openDrawer;root.querySelector('#drawer-close').onclick=closeDrawer;scrim.onclick=closeDrawer;
  root.querySelector('#brand-home').onclick=()=>openModule(landing);
  root.querySelector('#logout').addEventListener('click',async()=>{await supabase.auth.signOut();await renderApp(root,supabase);});
  root.querySelectorAll('.drawer-item').forEach(button=>button.addEventListener('click',()=>openModule(button.dataset.module)));
  document.onkeydown=e=>{if(e.key==='Escape')closeDrawer();};
  openModule(landing);
}
async function loadModule(view, supabase, profile, module) {
  view.innerHTML = '<div class="loading">Loading…</div>';

  if (module === 'dashboard') { await renderDashboard(view, supabase, profile); return; }
  if (module === 'attendance') { await renderAttendance(view, supabase, profile); return; }
  if (module === 'summary') { await renderDailySummary(view, supabase, profile); return; }
  if (module === 'salary') { await renderSalary(view, supabase, profile); return; }
  if (module === 'purchase') { await renderPurchases(view, supabase, profile); return; }
  if (module === 'people') { await renderPeople(view, supabase, profile); return; }

  const labels = {
    stock: ['Stock', 'Inventory workflow is the next operations module.'],
    purchase: ['Purchases', 'Purchase entry will connect to vendors, items and business dates.'],
    po: ['Purchase Order', 'Purchase orders will be generated from stock intelligence.'],
    summary: ['Daily Summary', 'Sales, expenses, vendor payments and cash closing will live here.'],
    delta: ['Delta', 'Owner stock delta review will compare business days.'],
    salary: ['Salary', 'Payroll will use attendance, leave and approved adjustments.'],
    dashboard: ['Dashboard', 'The owner dashboard will aggregate operational performance.']
  };

  const [title, copy] = labels[module] || ['CafeTracker','Module unavailable.'];
  view.innerHTML = `
    <span class="eyebrow">CafeTracker</span>
    <h2>${title}</h2>
    <p class="muted">${copy}</p>
    <div class="coming-soon">Module foundation connected</div>
  `;
}

async function renderDashboard(view, supabase, profile) {
  if(profile.access_class!=='ADMIN'){view.innerHTML='<span class="eyebrow">Dashboard</span><h2>Admin access required</h2>';return;}
  const [{data:outlets,error:outletError},{data:stockRows,error:stockError},{data:staffRows,error:staffError}]=await Promise.all([
    supabase.from('outlets').select('id,name,theme_color').order('id'),
    supabase.from('current_stock').select('outlet_id,item_id,item_name,minimum_stock,count_now,business_date'),
    supabase.from('staff').select('id,outlet_id,employment_status,active')
  ]);
  if(outletError||stockError||staffError){view.innerHTML='<span class="eyebrow">Dashboard</span><h2>Dashboard unavailable</h2><p class="form-error">'+escapeHtml((outletError||stockError||staffError)?.message||'Unable to load dashboard.')+'</p>';return;}
  const scopedOutlets=profile.context_outlet_id?(outlets||[]).filter(o=>Number(o.id)===Number(profile.context_outlet_id)):(outlets||[]);
  const outletMap=new Map(scopedOutlets.map(o=>[Number(o.id),o]));
  const todayByOutlet=new Map();
  await Promise.all(scopedOutlets.map(async o=>{const {data}=await supabase.rpc('get_effective_business_day',{p_outlet_id:o.id,p_timestamp:new Date().toISOString()});if(data)todayByOutlet.set(Number(o.id),String(data));}));
  const attendanceSets=await Promise.all(scopedOutlets.map(async o=>{const date=todayByOutlet.get(Number(o.id));if(!date)return {outlet:o,rows:[]};const {data,error}=await supabase.rpc('get_attendance_calendar',{p_outlet_id:o.id,p_start_date:date,p_end_date:date,p_staff_id:null});return {outlet:o,rows:error?[]:(data||[])};}));
  const dateValues=[...todayByOutlet.values()];
  let summaries=[];
  if(dateValues.length){const min=dateValues.slice().sort()[0],max=dateValues.slice().sort().at(-1);const {data}=await supabase.from('daily_summaries').select('outlet_id,business_date,summary_status,short_excess').gte('business_date',min).lte('business_date',max);summaries=data||[];}
  const alerts=[];
  attendanceSets.forEach(({outlet,rows})=>{
    const review=rows.filter(r=>r.day_status==='NEEDS_REVIEW').length;
    const notIn=rows.filter(r=>r.day_status==='NOT_CHECKED_IN').length;
    if(review)alerts.push({kind:'attendance',outlet:outlet.name,text:`${review} attendance record${review===1?'':'s'} need review`,module:'attendance'});
    if(notIn)alerts.push({kind:'attendance',outlet:outlet.name,text:`${notIn} ${notIn===1?'person has':'people have'} not checked in`,module:'attendance'});
  });
  scopedOutlets.forEach(o=>{const date=todayByOutlet.get(Number(o.id));const row=summaries.find(x=>Number(x.outlet_id)===Number(o.id)&&String(x.business_date)===date);if(row&&row.summary_status!=='CLOSED')alerts.push({kind:'summary',outlet:o.name,text:'Daily Summary is open',module:'summary'});});
  const latestStock=new Map();
  (stockRows||[]).forEach(r=>{const key=Number(r.outlet_id)+'|'+r.item_id,old=latestStock.get(key);if(!old||String(r.business_date)>String(old.business_date))latestStock.set(key,r);});
  const lowByOutlet=new Map();
  [...latestStock.values()].filter(r=>!profile.context_outlet_id||Number(r.outlet_id)===Number(profile.context_outlet_id)).forEach(r=>{const min=Number(r.minimum_stock||0),count=Number(r.count_now||0);if(min>0&&count<min)lowByOutlet.set(Number(r.outlet_id),(lowByOutlet.get(Number(r.outlet_id))||0)+1);});
  lowByOutlet.forEach((count,id)=>alerts.push({kind:'stock',outlet:outletMap.get(id)?.name||'Café',text:`${count} stock item${count===1?' is':'s are'} below minimum`,module:'stock'}));
  const scopedStaff=profile.context_outlet_id?(staffRows||[]).filter(s=>Number(s.outlet_id)===Number(profile.context_outlet_id)):(staffRows||[]);const activeStaff=scopedStaff.filter(s=>s.active&&s.employment_status==='ACTIVE').length;
  const awayStaff=scopedStaff.filter(s=>['VACATION','LEAVE'].includes(s.employment_status)).length;
  const closedSummaries=scopedOutlets.filter(o=>{const d=todayByOutlet.get(Number(o.id));return summaries.some(x=>Number(x.outlet_id)===Number(o.id)&&String(x.business_date)===d&&x.summary_status==='CLOSED');}).length;
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',hour12:false}).format(new Date()));
  const greeting=hour<12?'Good morning':hour<17?'Good afternoon':'Good evening';
  view.innerHTML=`
    <div class="dashboard-head"><div><span class="eyebrow">${profile.context_outlet_id?escapeHtml(outletMap.get(Number(profile.context_outlet_id))?.name||'Selected café'):'All cafés'}</span><h2>${greeting}, ${escapeHtml(profile.name)}</h2><p class="muted">Here’s what needs attention across CafeTracker.</p></div><span class="soft-badge">${alerts.length} needing attention</span></div>
    <section class="dashboard-attention"><div class="section-heading"><div><h3>Needs Attention</h3><span class="hint">Live from current CafeTracker records</span></div></div>
      <div class="attention-list">${alerts.length?alerts.map(a=>`<button type="button" class="attention-row" data-open-module="${a.module}"><span class="attention-icon">${icon(a.kind==='summary'?'summary':a.kind==='stock'?'stock':'attendance',20)}</span><span class="attention-copy"><strong>${escapeHtml(a.outlet)}</strong><small>${escapeHtml(a.text)}</small></span><span class="person-chevron">›</span></button>`).join(''):`<div class="all-caught-up">${icon('check',24)}<div><strong>All caught up</strong><span>No current records need Admin attention.</span></div></div>`}</div>
    </section>
    <section class="dashboard-today"><div class="section-heading"><div><h3>Today across cafés</h3><span class="hint">Database records only</span></div></div>
      <div class="today-grid">
        <div class="today-stat"><strong>${scopedOutlets.length}</strong><span>Cafés</span></div>
        <div class="today-stat"><strong>${activeStaff}</strong><span>Active staff</span></div>
        <div class="today-stat"><strong>${awayStaff}</strong><span>On leave / vacation</span></div>
        <div class="today-stat"><strong>${closedSummaries}</strong><span>Summaries closed</span></div>
      </div>
    </section>`;
  view.querySelectorAll('[data-open-module]').forEach(btn=>btn.onclick=()=>document.querySelector('.drawer-item[data-module="'+btn.dataset.openModule+'"]')?.click());
}

async function renderDailySummary(view, supabase, profile) {
  const isOwner=profile.access_class==='ADMIN';
  const canManageSummary=isOwner||['Manager','Ops Manager'].includes(profile.role);
  if(!canManageSummary){view.innerHTML='<span class="eyebrow">Daily Summary</span><h2>Manager access required</h2><p class="section-help">Daily Summary is available to Managers and Admins only.</p>';return;}
  let outletId=Number(profile.outlet_id||1);
  let outlets=[];
  if(isOwner){const {data}=await supabase.from('outlets').select('id,name,theme_key,theme_color').order('id');outlets=data||[];outletId=Number(profile.context_outlet_id||profile.outlet_id||outlets[0]?.id||1);}
  const {data:businessDay,error:businessDayError}=await supabase.rpc('get_effective_business_day',{p_outlet_id:outletId,p_timestamp:new Date().toISOString()});
  if(businessDayError||!businessDay){view.innerHTML='<span class="eyebrow">Daily Summary</span><h2>Business day unavailable</h2><p class="form-error">'+escapeHtml(businessDayError?.message||'Could not determine the café business day.')+'</p>';return;}
  const businessDate=String(businessDay);
  const [{data:vendors},{data:staff},{data:existing},{data:previous},{data:outlet}]=await Promise.all([
    supabase.from('vendors').select('id,name').order('name'),
    supabase.from('staff').select('id,name,outlet_id').eq('active',true).eq('outlet_id',outletId).order('name'),
    supabase.from('daily_summaries').select('*').eq('outlet_id',outletId).eq('business_date',businessDate).maybeSingle(),
    supabase.from('daily_summaries').select('business_date,physical_cash').eq('outlet_id',outletId).lt('business_date',businessDate).order('business_date',{ascending:false}).limit(1).maybeSingle(),
    supabase.from('outlets').select('name,swiggy_payout_rate,zomato_payout_rate,theme_key,theme_color').eq('id',outletId).maybeSingle()
  ]);
  applyTheme(outlet);
  const swRate=Number(outlet?.swiggy_payout_rate??.5),zoRate=Number(outlet?.zomato_payout_rate??.5);
  const systemOpening=Number(existing?.opening_cash_system??previous?.physical_cash??0);
  const actualOpening=Number(existing?.opening_cash_actual??systemOpening);
  const money=n=>'₹'+Number(n||0).toLocaleString('en-IN',{maximumFractionDigits:2});
  const statusText=existing?('Editing · '+businessDate):('New summary · '+businessDate);

  view.innerHTML=`
    <div class="summary-page">
      <div class="summary-title-row">
        <div><span class="eyebrow">Daily closing</span><h2>Daily Summary</h2><p>${escapeHtml(outlet?.name||'')} · ${businessDate}</p></div>
        <span class="summary-state">${escapeHtml(statusText)}</span>
      </div>


      <section class="summary-section">
        <div class="summary-section-title"><span></span><h3>Opening cash</h3></div>
        <div class="summary-two">
          <label class="summary-label">From previous closing<input value="${systemOpening}" disabled></label>
          <label class="summary-label">Actual opening ₹<input id="sOpen" type="number" inputmode="decimal" value="${actualOpening}"></label>
        </div>
        <div id="openingVariance" class="summary-inline-status"></div>
      </section>

      <section class="summary-section">
        <div class="summary-section-title"><span></span><h3>Sales</h3></div>
        <div class="summary-two">
          <label class="summary-label">Cash ₹<input id="sCash" type="number" inputmode="decimal" value="${existing?.cash_sale??0}"></label>
          <label class="summary-label">UPI ₹<input id="sUpi" type="number" inputmode="decimal" value="${existing?.upi_sale??0}"></label>
          <label class="summary-label">Swiggy on app ₹<input id="sSwGross" type="number" inputmode="decimal" value="${existing?.swiggy_gross??0}"></label>
          <label class="summary-label">Swiggy payout ₹ <small>(${Math.round(swRate*100)}%)</small><input id="sSwPay" type="number" inputmode="decimal" value="${existing?.swiggy_payout??0}"></label>
          <label class="summary-label">Zomato on app ₹<input id="sZoGross" type="number" inputmode="decimal" value="${existing?.zomato_gross??0}"></label>
          <label class="summary-label">Zomato payout ₹ <small>(${Math.round(zoRate*100)}%)</small><input id="sZoPay" type="number" inputmode="decimal" value="${existing?.zomato_payout??0}"></label>
        </div>
        <label class="summary-label full-field">Own digital ₹<input id="sOwn" type="number" inputmode="decimal" value="${existing?.own_digital??0}"></label>
        <label class="summary-label full-field">Discount ₹<input id="sDisc" type="number" inputmode="decimal" value="${existing?.discount??0}"></label>
        <div class="summary-total accent"><span>Net sale</span><strong id="netSale">₹0</strong></div>
      </section>

      <section class="summary-section">
        <div class="summary-section-title"><span></span><h3>Expenses</h3></div>
        <div class="entry-head"><span>Category</span><span>Amount</span><span>Mode</span><i></i></div>
        <div id="expenseRows"></div>
        <button id="addExpense" class="summary-add" type="button">＋ Add expense</button>
      </section>

      <section class="summary-section">
        <div class="summary-section-title"><span></span><h3>Vendor payments</h3></div>
        <div class="entry-head"><span>Vendor</span><span>Amount</span><span>Mode</span><i></i></div>
        <div id="vendorRows"></div>
        <button id="addVendor" class="summary-add" type="button">＋ Add vendor payment</button>
      </section>

      <section class="summary-section">
        <div class="summary-section-title"><span></span><h3>Staff payments</h3></div>
        <div id="staffRows"></div>
        <button id="addStaff" class="summary-add" type="button">＋ Add staff payment</button>
      </section>

      <section class="summary-section">
        <div class="summary-section-title"><span></span><h3>Cash counter</h3></div>
        <p class="section-help">Count the cash drawer by denomination. The total becomes Physical Cash in Hand.</p>
        <div class="cash-counter">
          ${[500,200,100,50,20,10].map(d=>`<label><span>₹${d}</span><span class="cash-multiply">×</span><input class="denom-count" data-value="${d}" type="number" min="0" step="1" inputmode="numeric" placeholder="0"><strong class="denom-total">₹0</strong></label>`).join('')}
        </div>
        <div class="summary-total neutral"><span>Counted cash</span><strong id="countedCash">₹0</strong></div>
        <button id="useCountedCash" class="summary-add full" type="button">Use counted total as physical cash</button>
      </section>

      <section class="summary-section">
        <div class="summary-section-title"><span></span><h3>Cash position</h3></div>
        <label class="summary-label full-field">Physical cash in hand ₹<input id="sPhysical" type="number" inputmode="decimal" value="${existing?.physical_cash??0}"></label>
        <div class="cash-position-grid"><div><span>Expected cash</span><strong id="expectedCash">₹0</strong></div><div id="differenceCard"><span>Short / excess</span><strong id="cashDiff">₹0</strong></div></div>
        <div id="cashStatus" class="summary-inline-status"></div>
      </section>

      <div class="summary-actions">
        <button id="saveSummary" class="primary" type="button">Save Summary</button>
        <button id="closeSummary" class="close-day" type="button">Close Day</button>\n        <button id="whatsappSummary" class="summary-add full" type="button">Generate WhatsApp message</button>\n        <div id="whatsappPreview" class="whatsapp-preview" hidden><div class="whatsapp-preview-head"><strong>WhatsApp message</strong><button id="copyWhatsappSummary" type="button" class="summary-add">Copy</button></div><textarea id="whatsappText" readonly></textarea><p id="copyStatus" class="summary-inline-status" hidden></p></div>
      </div>
      <p id="summaryMessage" class="form-error" hidden></p>
      ${existing?.is_closed?'<div class="notice warning">This day is closed and cannot be edited.</div>':''}
    </div>`;



  function n(id){return Number(view.querySelector('#'+id)?.value||0);}
  function calc(){
    const net=n('sCash')+n('sUpi')+n('sSwPay')+n('sZoPay')+n('sOwn')-n('sDisc');
    const cashExpenses=[...view.querySelectorAll('#expenseRows .summary-entry-row')].reduce((sum,r)=>sum+(r.querySelector('.row-mode')?.value==='Cash'?Number(r.querySelector('.e-amt')?.value||0):0),0);
    const cashVendors=[...view.querySelectorAll('#vendorRows .summary-entry-row')].reduce((sum,r)=>sum+(r.querySelector('.row-mode')?.value==='Cash'?Number(r.querySelector('.v-amt')?.value||0):0),0);
    const cashStaff=[...view.querySelectorAll('#staffRows .summary-entry-row')].reduce((sum,r)=>sum+(r.querySelector('.row-mode')?.value==='Cash'?Number(r.querySelector('.p-amt')?.value||0):0),0);
    const expected=n('sOpen')+n('sCash')-cashExpenses-cashVendors-cashStaff;
    const diff=n('sPhysical')-expected,openDiff=n('sOpen')-systemOpening;
    view.querySelector('#netSale').textContent=money(net);view.querySelector('#expectedCash').textContent=money(expected);view.querySelector('#cashDiff').textContent=money(Math.abs(diff));
    const dc=view.querySelector('#differenceCard');dc.classList.toggle('negative',diff<0);dc.classList.toggle('positive',diff>0);
    view.querySelector('#cashStatus').innerHTML=diff===0?'<span class="ok">Cash matches expected</span>':`<span class="${diff<0?'bad':'warn'}">${diff<0?'Short':'Excess'} ${money(Math.abs(diff))}</span>`;
    view.querySelector('#openingVariance').innerHTML=openDiff===0?'<span class="ok">Matches previous closing</span>':`<span class="warn">${openDiff<0?'Opening short':'Opening excess'} ${money(Math.abs(openDiff))}</span>`;
  }

  const addRow=(container,type,data={})=>{
    const row=document.createElement('div');row.className='summary-entry-row '+type;
    const mode=v=>`<select class="row-mode"><option value="Cash" ${v!=='UPI'?'selected':''}>Cash</option><option value="UPI" ${v==='UPI'?'selected':''}>UPI</option></select>`;
    if(type==='expense')row.innerHTML=`<input class="row-name e-cat" placeholder="Category" value="${escapeHtml(data.category||'')}" ${data.fixed?'readonly':''}><input class="row-amount e-amt" type="number" inputmode="decimal" placeholder="₹0" value="${data.amount||''}">${mode(data.mode)}<button class="remove-row" type="button" aria-label="Remove">×</button>`;
    if(type==='vendor')row.innerHTML=`<select class="row-name v-name"><option value="">Select vendor</option>${(vendors||[]).map(v=>`<option value="${escapeHtml(v.name)}" ${v.name===(data.vendor_name||'')?'selected':''}>${escapeHtml(v.name)}</option>`).join('')}</select><input class="row-amount v-amt" type="number" inputmode="decimal" placeholder="₹0" value="${data.amount||''}">${mode(data.mode)}<button class="remove-row" type="button" aria-label="Remove">×</button>`;
    if(type==='staff')row.innerHTML=`<div class="staff-payment-grid"><select class="p-name"><option value="">Select staff</option>${(staff||[]).map(p=>`<option value="${p.id}" ${Number(p.id)===Number(data.staff_id)?'selected':''}>${escapeHtml(p.name)}${staff.filter(x=>x.name.trim().toLowerCase()===p.name.trim().toLowerCase()).length>1?' · Staff ID '+p.id:''}</option>`).join('')}</select><select class="p-type"><option ${data.payout_type==='Salary'?'selected':''}>Salary</option><option ${data.payout_type==='Advance'?'selected':''}>Advance</option><option ${data.payout_type==='Reimbursement'?'selected':''}>Reimbursement</option><option ${data.payout_type==='Other'?'selected':''}>Other</option></select><input class="p-amt" type="number" inputmode="decimal" placeholder="₹ Amount" value="${data.amount||''}">${mode(data.mode)}</div><button class="remove-row" type="button" aria-label="Remove">×</button>`;
    row.querySelector('.remove-row').onclick=()=>{row.remove();calc();};
    row.querySelectorAll('input,select').forEach(el=>el.addEventListener('input',calc));
    container.appendChild(row);
  };

  const [ev,vv,sv]=await Promise.all([
    supabase.from('summary_expenses').select('*').eq('summary_id',existing?.id||'__none__'),
    supabase.from('summary_vendor_payouts').select('*').eq('summary_id',existing?.id||'__none__'),
    supabase.from('summary_staff_payouts').select('*').eq('summary_id',existing?.id||'__none__')
  ]);
  const fixedExpenseCategories=['Pigmy','Petrol','Utility','Maintenance','Other'];
  const savedExpenses=ev.data||[];
  fixedExpenseCategories.forEach(category=>{
    const found=savedExpenses.find(x=>String(x.category||'').toLowerCase()===category.toLowerCase() || (category==='Maintenance'&&String(x.category||'').toLowerCase()==='mainten'));
    addRow(view.querySelector('#expenseRows'),'expense',found?{...found,fixed:true}:{category,amount:0,mode:'Cash',fixed:true});
  });
  savedExpenses.filter(x=>!fixedExpenseCategories.some(category=>String(x.category||'').toLowerCase()===category.toLowerCase() || (category==='Maintenance'&&String(x.category||'').toLowerCase()==='mainten'))).forEach(x=>addRow(view.querySelector('#expenseRows'),'expense',x));
  (vv.data||[]).forEach(x=>addRow(view.querySelector('#vendorRows'),'vendor',x));
  (sv.data||[]).forEach(x=>addRow(view.querySelector('#staffRows'),'staff',x));

  view.querySelectorAll('#sOpen,#sCash,#sUpi,#sSwGross,#sSwPay,#sZoGross,#sZoPay,#sOwn,#sDisc,#sPhysical').forEach(el=>el.addEventListener('input',calc));
  view.querySelector('#sSwGross').addEventListener('input',e=>{view.querySelector('#sSwPay').value=(Number(e.target.value||0)*swRate).toFixed(2);calc();});
  view.querySelector('#sZoGross').addEventListener('input',e=>{view.querySelector('#sZoPay').value=(Number(e.target.value||0)*zoRate).toFixed(2);calc();});
  view.querySelector('#addExpense').textContent='＋ Add other expense';
  view.querySelector('#addExpense').onclick=()=>addRow(view.querySelector('#expenseRows'),'expense');
  view.querySelector('#addVendor').onclick=()=>addRow(view.querySelector('#vendorRows'),'vendor');
  view.querySelector('#addStaff').onclick=()=>addRow(view.querySelector('#staffRows'),'staff');

  let counted=0;
  const calcCounter=()=>{counted=0;view.querySelectorAll('.denom-count').forEach(input=>{const subtotal=Number(input.dataset.value)*Math.max(0,Number(input.value||0));counted+=subtotal;input.closest('label').querySelector('.denom-total').textContent=money(subtotal);});view.querySelector('#countedCash').textContent=money(counted);view.querySelector('#sPhysical').value=counted;calc();};
  view.querySelectorAll('.denom-count').forEach(i=>i.addEventListener('input',calcCounter));
  const useCountedBtn=view.querySelector('#useCountedCash');if(useCountedBtn)useCountedBtn.hidden=true;

  const disabled=!!existing?.is_closed;
  let reopenDeadline=null,canReopen=false;
  if(disabled){
    const {data:deadline}=await supabase.rpc('get_daily_summary_reopen_deadline',{p_summary_id:existing.id});
    reopenDeadline=deadline?new Date(deadline):null;
    canReopen=isOwner||(reopenDeadline&&new Date()<reopenDeadline);
    view.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);
    const shareBtn=view.querySelector('#whatsappSummary');if(shareBtn)shareBtn.disabled=false;
    const actionBar=view.querySelector('.summary-actions')||view.querySelector('#closeSummary')?.parentElement;
    if(actionBar){
      const b=document.createElement('button');b.id='reopenSummary';b.className='primary';b.type='button';
      b.textContent=canReopen?'Reopen Day':'Admin required to reopen';b.disabled=!canReopen;actionBar.appendChild(b);
      if(canReopen)b.onclick=async()=>{b.disabled=true;const {error}=await supabase.rpc('reopen_daily_summary',{p_summary_id:existing.id,p_user_id:profile.id});if(error){const msg=view.querySelector('#summaryMessage');msg.textContent=error.message;msg.hidden=false;b.disabled=false;return;}await renderDailySummary(view,supabase,profile);};
    }
  }
  calc();calcCounter();

  const collect=()=>{
    const expenses=[...view.querySelectorAll('#expenseRows .summary-entry-row')].map(r=>({category:r.querySelector('.e-cat').value.trim(),amount:Number(r.querySelector('.e-amt').value||0),mode:r.querySelector('.row-mode').value})).filter(x=>x.category&&x.amount>0);
    const vendorPayouts=[...view.querySelectorAll('#vendorRows .summary-entry-row')].map(r=>({vendor_name:r.querySelector('.v-name').value,amount:Number(r.querySelector('.v-amt').value||0),mode:r.querySelector('.row-mode').value})).filter(x=>x.vendor_name&&x.amount>0);
    const staffPayouts=[...view.querySelectorAll('#staffRows .summary-entry-row')].map(r=>(()=>{const sel=r.querySelector('.p-name'),staffId=Number(sel.value),person=staff.find(x=>Number(x.id)===staffId);return {staff_id:staffId||null,staff_name:person?.name||'',payout_type:r.querySelector('.p-type').value,amount:Number(r.querySelector('.p-amt').value||0),mode:r.querySelector('.row-mode').value};})()).filter(x=>x.staff_id&&x.staff_name&&x.amount>0);
    return {expenses,vendorPayouts,staffPayouts};
  };
  const save=async()=>{
    const msg=view.querySelector('#summaryMessage'),btn=view.querySelector('#saveSummary');msg.hidden=true;btn.disabled=true;btn.textContent='Saving…';
    try{
      const {expenses,vendorPayouts,staffPayouts}=collect();
      const id=existing?.id||`SUM-${outletId}-${businessDate}`;
      const args={p_summary_id:id,p_outlet_id:outletId,p_business_date:businessDate,p_user_id:profile.id,p_user_name:profile.name,p_role:profile.access_class==='ADMIN'?'Admin':profile.role,p_cash_sale:n('sCash'),p_upi_sale:n('sUpi'),p_swiggy_gross:n('sSwGross'),p_swiggy_payout:n('sSwPay'),p_zomato_gross:n('sZoGross'),p_zomato_payout:n('sZoPay'),p_own_digital:n('sOwn'),p_discount:n('sDisc'),p_opening_cash_system:systemOpening,p_opening_cash_actual:n('sOpen'),p_physical_cash:n('sPhysical'),p_expenses:expenses,p_vendor_payouts:vendorPayouts,p_staff_payouts:staffPayouts};
      const {error}=await supabase.rpc('save_daily_summary',args);if(error)throw error;
      await renderDailySummary(view,supabase,profile);return true;
    }catch(e){msg.textContent=e.message||'Could not save summary.';msg.hidden=false;return false;}finally{if(btn.isConnected){btn.disabled=false;btn.textContent='Save Summary';}}
  };
  const whatsappSummary=()=>{
    calc();
    const {expenses,vendorPayouts,staffPayouts}=collect();
    const fmt=v=>'₹'+Math.round(Number(v||0)).toLocaleString('en-IN');
    const displayDate=new Date(businessDate+'T12:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
    const expected=Number(view.querySelector('#expectedCash').textContent.replace(/[^0-9.-]/g,'')||0);
    const physical=n('sPhysical'),cashDiff=physical-expected;
    const expenseTotal=expenses.reduce((a,x)=>a+Number(x.amount||0),0);
    const vendorTotal=vendorPayouts.reduce((a,x)=>a+Number(x.amount||0),0);
    const staffTotal=staffPayouts.reduce((a,x)=>a+Number(x.amount||0),0);
    const cashOut=[...expenses,...vendorPayouts,...staffPayouts].filter(x=>x.mode==='Cash').reduce((a,x)=>a+Number(x.amount||0),0);
    const lines=['*DAILY SUMMARY — '+outlet.name.toUpperCase()+'*',displayDate,'Saved by '+profile.name,'','*SALES*','Cash — '+fmt(n('sCash')),'UPI — '+fmt(n('sUpi'))];
    if(n('sSwGross')||n('sSwPay'))lines.push('Swiggy — '+fmt(n('sSwGross'))+' · Payout '+fmt(n('sSwPay')));
    if(n('sZoGross')||n('sZoPay'))lines.push('Zomato — '+fmt(n('sZoGross'))+' · Payout '+fmt(n('sZoPay')));
    if(n('sOwn'))lines.push('Own Digital — '+fmt(n('sOwn')));
    if(n('sDisc'))lines.push('Discount — '+fmt(n('sDisc')));
    lines.push('','*NET SALE — '+fmt(n('sCash')+n('sUpi')+n('sSwPay')+n('sZoPay')+n('sOwn')-n('sDisc'))+'*','','*EXPENSES*');
    if(expenses.length){lines.push(...expenses.map(x=>x.category+' — '+fmt(x.amount)+' · '+x.mode),'*Total Expenses — '+fmt(expenseTotal)+'*');}else lines.push('None');
    lines.push('','*VENDOR PAYMENTS*');
    if(vendorPayouts.length){lines.push(...vendorPayouts.map(x=>x.vendor_name+' — '+fmt(x.amount)+' · '+x.mode),'*Total Vendor Payments — '+fmt(vendorTotal)+'*');}else lines.push('None');
    if(staffPayouts.length)lines.push('','*STAFF PAYMENTS*',...staffPayouts.map(x=>x.staff_name+' — '+x.payout_type+' · '+fmt(x.amount)+' · '+x.mode),'*Total Staff Payments — '+fmt(staffTotal)+'*');
    lines.push('','*CASH POSITION*','Opening Cash — '+fmt(systemOpening),'Cash Sales — '+fmt(n('sCash')),'Cash Out — '+fmt(cashOut),'Expected Cash — '+fmt(expected),'Physical Cash — '+fmt(physical),'',cashDiff<0?'🔴 *SHORT — '+fmt(Math.abs(cashDiff))+'*':cashDiff>0?'🟠 *EXCESS — '+fmt(cashDiff)+'*':'🟢 *MATCHED*','','_CafeTracker · '+displayDate+'_');
    const text=lines.join('\n');
    const preview=view.querySelector('#whatsappPreview'),box=view.querySelector('#whatsappText');
    box.value=text;preview.hidden=false;box.style.height='auto';box.style.height=Math.min(box.scrollHeight,520)+'px';
    preview.scrollIntoView({behavior:'smooth',block:'center'});
  };
  view.querySelector('#whatsappSummary').onclick=whatsappSummary;
  view.querySelector('#copyWhatsappSummary').onclick=async()=>{
    const box=view.querySelector('#whatsappText'),status=view.querySelector('#copyStatus');
    try{
      if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(box.value);
      else{box.focus();box.select();document.execCommand('copy');box.setSelectionRange(0,0);}
      status.textContent='Copied to clipboard';status.className='summary-inline-status ok';status.hidden=false;
      setTimeout(()=>{if(status.isConnected)status.hidden=true;},2200);
    }catch(e){status.textContent='Could not copy. Press and hold the message to copy it.';status.className='summary-inline-status bad';status.hidden=false;}
  };
  view.querySelector('#saveSummary').onclick=save;
  view.querySelector('#closeSummary').onclick=async()=>{if(!confirm('Close this business day? Once closed, editing stops until the day is reopened.'))return;if(!existing){const ok=await save();if(!ok)return;await renderDailySummary(view,supabase,profile);return;}const {error}=await supabase.rpc('close_daily_summary',{p_summary_id:existing.id,p_user_id:profile.id});if(error){const msg=view.querySelector('#summaryMessage');msg.textContent=error.message;msg.hidden=false;return;}await renderDailySummary(view,supabase,profile);};
}

function staffWelcomeMessage(name, setupCode) {
  return [
    '*Welcome to CafeTracker*',
    '',
    'Hi '+name+', welcome on board! 👋',
    '',
    '*First-time PIN:* '+setupCode,
    '',
    'Open CafeTracker, select your café and your name, then choose Set up my account and enter 1234.',
    '',
    'Then:',
    '1. Complete your onboarding form',
    '2. Upload the requested details',
    '3. Create your own private PIN',
    '',
    '1234 is only for first-time setup or after an Admin resets your login. You will create your own private PIN during setup.',
    '',
    'Welcome to the team!'
  ].join('\n');
}
async function copyStaffWelcomeMessage(name, setupCode, button) {
  const message=staffWelcomeMessage(name,setupCode);
  try{await navigator.clipboard.writeText(message);const old=button.textContent;button.textContent='Copied ✓';setTimeout(()=>button.textContent=old,1600);}
  catch{window.prompt('Copy this message:',message);}
}
function openStaffWelcomeWhatsApp(name, setupCode) {
  window.open('https://wa.me/?text='+encodeURIComponent(staffWelcomeMessage(name,setupCode)),'_blank','noopener,noreferrer');
}

async function renderPeople(view, supabase, profile) {
  if (profile.access_class !== 'ADMIN') {
    view.innerHTML = '<span class="eyebrow">People</span><h2>Admin access required</h2>';
    return;
  }

  const loadData = async () => {
    const [{ data: outlets, error: outletError }, { data: staffRows, error: staffError }, { data: adminRows, error: adminError }] = await Promise.all([
      supabase.from('outlets').select('id,name').order('id'),
      supabase.from('staff').select('id,name,outlet_id,basic_salary,joining_date,active,employment_status,status_effective_from,status_note,notes,users:users!staff_id(id,role,pin_set_at,permissions)').order('name'),
      supabase.from('login_directory').select('id,name,active,is_super_user,access_class').eq('access_class','ADMIN').order('name')
    ]);
    if(outletError)throw outletError;if(staffError)throw staffError;if(adminError)throw adminError;
    return { outlets: outlets || [], staffRows: staffRows || [], adminRows: adminRows || [] };
  };

  let { outlets, staffRows, adminRows } = await loadData();

  view.innerHTML = `
    <div class="section-heading"><div><span class="eyebrow">People</span><h2>Staff & Users</h2></div><span class="soft-badge" id="staffCount"></span></div>
    <div class="people-tabs three"><button type="button" class="active" data-people-tab="staff">Staff</button><button type="button" data-people-tab="admins">Admins</button><button type="button" data-people-tab="add">Add staff</button></div>
    <div id="peopleAdd" class="subsection" hidden>
      <div class="section-heading"><h3>Add staff member</h3><span class="hint">Employee completes onboarding, then creates a private PIN</span></div>
      <div class="form-grid">
        <label>Display name<input id="staffName" placeholder="Name used in CafeTracker"></label>
        <label>Outlet<select id="staffOutlet">${outlets.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}</select></label>
        <label>Role<select id="staffRole"><option>Staff</option><option>Manager</option><option>Ops Manager</option></select></label>
        <label>Joining date<input id="staffJoining" type="date" value="${new Date().toISOString().slice(0,10)}"></label>
        <label>Agreed basic salary<input id="staffSalary" type="number" min="0" step="0.01" placeholder="0.00"></label>
      </div>
      <div class="permissions-box"><div class="card-label">Access permissions</div><div class="permission-grid">
        <label><input type="checkbox" id="permAttendance" checked> Attendance</label>
        <label><input type="checkbox" id="permPurchase" checked> Purchases</label>
        <label><input type="checkbox" id="permSummary" checked> Daily Summary</label>
        <label><input type="checkbox" id="permStock" checked> Stock</label>
      </div></div>
      <button id="addStaffBtn" class="primary">Add staff member</button><div id="staffFormMsg"></div>
    </div>
    <div id="peopleAdmins" class="subsection" hidden>
      <div class="section-heading"><div><h3>Administrators</h3><span class="hint">Admin accounts are separate from employee records</span></div>${profile.is_super_user?'<button type="button" id="showAddAdmin" class="primary">Add Admin</button>':''}</div>
      ${profile.is_super_user?`<div id="addAdminPanel" class="card admin-add-panel" hidden><div class="section-heading"><h3>Add administrator</h3><button type="button" id="cancelAddAdmin" class="ghost">Cancel</button></div><div class="form-grid"><label>Name<input id="adminName" placeholder="Administrator name"></label><label>Home café<select id="adminOutlet">${outlets.map(o=>`<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}</select></label></div><p class="hint">Initial Admin PIN: 123456. The Admin can use it for first sign-in; later PIN changes do not restore this default.</p><div id="adminFormMsg"></div><button type="button" id="addAdminBtn" class="primary">Create Admin</button></div>`:''}
      <div class="admin-list" id="adminList"></div>
    </div>
    <div id="peopleStaff" class="subsection"><div class="section-heading"><h3>Current staff</h3><span class="hint">Select a person to manage their employment and access</span></div><div id="staffList"></div></div>
  `;

  const renderAdmins=()=>{
    const list=view.querySelector('#adminList');if(!list)return;const message=view.querySelector('#adminMessage');const showAdminMessage=(text,type='error')=>{message.textContent=text;message.className='purchase-message '+(type==='success'?'success':'error');message.hidden=false;if(type==='success')setTimeout(()=>{if(message.isConnected)message.hidden=true;},2200);};
    list.innerHTML=adminRows.map(a=>`<div class="admin-row admin-manage-row"><div class="admin-identity"><strong>${escapeHtml(a.name)}</strong>${a.is_super_user?'<span class="soft-badge">Super User</span>':''}<span class="${a.active?'status-ok':'status-warn'}">${a.active?'Active':'Inactive'}</span></div>${profile.is_super_user&&!a.is_super_user?`<div class="admin-controls"><label>New PIN<input type="password" inputmode="numeric" autocomplete="new-password" maxlength="8" class="admin-new-pin" data-id="${a.id}" placeholder="4–8 digits"></label><button type="button" class="secondary admin-pin-update" data-id="${a.id}">Update PIN</button><button type="button" class="ghost admin-active-toggle" data-id="${a.id}" data-active="${a.active}">${a.active?'Deactivate':'Reactivate'}</button></div>`:''}</div>`).join('');
    list.querySelectorAll('.admin-pin-update').forEach(btn=>btn.onclick=async()=>{const id=btn.dataset.id,input=list.querySelector('.admin-new-pin[data-id="'+id+'"]'),pin=input?.value||'';if(!/^\\d{4,8}$/.test(pin))return showAdminMessage('Enter a 4–8 digit numeric PIN.');btn.disabled=true;btn.textContent='Updating…';const {data,error}=await supabase.functions.invoke('chaitracker-admin-pin',{body:{target_user_id:id,new_pin:pin}});if(error||!data?.ok){showAdminMessage(data?.error||error?.message||'Unable to update PIN.');btn.disabled=false;btn.textContent='Update PIN';return;}input.value='';btn.disabled=false;btn.textContent='Updated';showAdminMessage('Admin PIN updated.','success');setTimeout(()=>btn.textContent='Update PIN',1200);});
    list.querySelectorAll('.admin-active-toggle').forEach(btn=>btn.onclick=async()=>{const id=btn.dataset.id,next=btn.dataset.active!=='true';if(!confirm((next?'Reactivate':'Deactivate')+' this Admin account?'))return;btn.disabled=true;const {error}=await supabase.rpc('superuser_set_admin_active',{p_user_id:id,p_active:next});if(error){showAdminMessage(error.message);btn.disabled=false;return;}({outlets,staffRows,adminRows}=await loadData());renderAdmins();});
  };
  renderAdmins();

  let peopleOutlet = profile.access_class==='ADMIN' ? (profile.context_outlet_id?String(profile.context_outlet_id):'all') : (profile.outlet_id ? String(profile.outlet_id) : 'all');
  let peopleStatus = 'ALL';
  let peopleSearch = '';

  const staffStatus = s => s.employment_status || (s.active ? 'ACTIVE' : 'INACTIVE');
  const statusText = status => ({ACTIVE:'Active',VACATION:'Vacation',LEAVE:'On leave',INACTIVE:'Inactive',LEFT:'Left'}[status] || status);

  const renderList = () => {
    const outletMap = new Map(outlets.map(o => [Number(o.id), o.name]));
    const outletRows = peopleOutlet === 'all' ? staffRows : staffRows.filter(s => String(s.outlet_id) === peopleOutlet);
    const counts = outletRows.reduce((a,s)=>{const st=staffStatus(s);a.ALL++;a[st]=(a[st]||0)+1;return a;},{ALL:0,ACTIVE:0,VACATION:0,LEAVE:0,INACTIVE:0,LEFT:0});
    const q=peopleSearch.trim().toLowerCase();
    const visible=outletRows.filter(s=>(peopleStatus==='ALL'||staffStatus(s)===peopleStatus)&&(!q||s.name.toLowerCase().includes(q)));
    view.querySelector('#staffCount').textContent = `${counts.ACTIVE} active`;
    view.querySelector('#staffList').innerHTML = `
      <div class="people-tools">
        <label class="people-outlet-label">Outlet<select id="peopleOutlet"><option value="all">All cafés</option>${outlets.map(o=>`<option value="${o.id}" ${String(o.id)===peopleOutlet?'selected':''}>${escapeHtml(o.name)}</option>`).join('')}</select></label>
        <label class="people-search"><span>${icon('search',18)}</span><input id="peopleSearch" type="search" placeholder="Search staff by name…" value="${escapeHtml(peopleSearch)}"></label>
      </div>
      <div class="people-filter-row">
        ${[['ALL','All'],['ACTIVE','Active'],['VACATION','Vacation'],['LEAVE','Leave'],['INACTIVE','Inactive'],['LEFT','Left']].map(([v,l])=>`<button type="button" class="people-filter ${peopleStatus===v?'active':''}" data-status="${v}">${l} <span>${counts[v]||0}</span></button>`).join('')}
      </div>
      <div class="people-compact-list">
        ${visible.length?visible.map(s=>{const u=Array.isArray(s.users)?s.users[0]:s.users,st=staffStatus(s);return `<button type="button" class="person-row manage-staff" data-id="${s.id}"><span class="person-avatar">${escapeHtml((s.name||'?').trim().charAt(0).toUpperCase())}</span><span class="person-main"><strong>${escapeHtml(s.name)}</strong><small>${escapeHtml(u?.role||'Staff')} · ${escapeHtml(outletMap.get(Number(s.outlet_id))||'—')}</small></span><span class="person-status status-${st.toLowerCase()}">${escapeHtml(statusText(st))}</span><span class="person-chevron">›</span></button>`}).join(''):'<div class="notice">No staff match this view.</div>'}
      </div>`;
    const outlet=view.querySelector('#peopleOutlet'); if(outlet)outlet.onchange=e=>{peopleOutlet=e.target.value;peopleStatus='ALL';renderList();};
    const search=view.querySelector('#peopleSearch'); if(search){search.oninput=e=>{peopleSearch=e.target.value;const pos=e.target.selectionStart;renderList();const next=view.querySelector('#peopleSearch');next?.focus();try{next?.setSelectionRange(pos,pos)}catch{}};}
    view.querySelectorAll('.people-filter').forEach(btn=>btn.onclick=()=>{peopleStatus=btn.dataset.status;renderList();});
    view.querySelectorAll('.manage-staff').forEach(btn => btn.onclick = () => openEditor(Number(btn.dataset.id)));
  };

  const openStatusEditor=(staffId)=>{
    const s=staffRows.find(x=>Number(x.id)===staffId);if(!s)return;
    const current=s.employment_status||(s.active?'ACTIVE':'INACTIVE');
    view.querySelector('#staffList').innerHTML=`
      <div class="card staff-editor"><div class="section-heading"><div><span class="eyebrow">Employment status</span><h3>${escapeHtml(s.name)}</h3></div><button id="cancelStatus" class="ghost">Cancel</button></div>
      <div class="form-grid"><label>Status<select id="staffEmploymentStatus">${[['ACTIVE','Active'],['VACATION','Vacation'],['LEAVE','On leave'],['INACTIVE','Inactive'],['LEFT','Left employment']].map(([v,l])=>`<option value="${v}" ${v===current?'selected':''}>${l}</option>`).join('')}</select></label><label>Effective from<input id="staffStatusDate" type="date" value="${escapeHtml(s.status_effective_from||new Date().toISOString().slice(0,10))}"></label></div>
      <label>Note<textarea id="staffStatusNote" rows="3" placeholder="Optional note — e.g. annual vacation">${escapeHtml(s.status_note||'')}</textarea></label>
      <div class="notice subtle">Vacation and leave keep the employee account active. Inactive and Left disable login. Left also records the employment end date.</div>
      <div id="staffStatusMsg"></div><div class="action-row"><button id="saveStaffStatus" class="primary">Save status</button></div></div>`;
    view.querySelector('#cancelStatus').onclick=renderList;
    view.querySelector('#saveStaffStatus').onclick=async()=>{
      const btn=view.querySelector('#saveStaffStatus'),msg=view.querySelector('#staffStatusMsg');btn.disabled=true;btn.textContent='Saving…';
      const {error}=await supabase.rpc('owner_set_staff_status',{p_staff_id:staffId,p_status:view.querySelector('#staffEmploymentStatus').value,p_effective_from:view.querySelector('#staffStatusDate').value,p_note:view.querySelector('#staffStatusNote').value.trim()||null});
      if(error){msg.innerHTML='<p class="form-error">'+escapeHtml(error.message)+'</p>';btn.disabled=false;btn.textContent='Save status';return;}
      ({outlets,staffRows,adminRows}=await loadData());renderList();
    };
  };

  const openEditor = (staffId) => {
    const s=staffRows.find(x=>Number(x.id)===staffId); if(!s)return;
    const u=Array.isArray(s.users)?s.users[0]:s.users;
    const perms=u?.permissions||{};
    const outletName=outlets.find(o=>Number(o.id)===Number(s.outlet_id))?.name||'—', currentStatus=s.employment_status||(s.active?'ACTIVE':'INACTIVE');
    view.querySelector('#staffList').innerHTML=`
      <div class="staff-profile-shell">
        <div class="staff-profile-head"><button id="cancelEdit" class="profile-back" type="button">‹</button><span class="person-avatar large">${escapeHtml((s.name||'?').trim().charAt(0).toUpperCase())}</span><div class="staff-profile-identity"><span class="eyebrow">Employee profile</span><h3>${escapeHtml(s.name)}</h3><p>${escapeHtml(u?.role||'Staff')} · ${escapeHtml(outletName)}</p></div><span class="person-status status-${currentStatus.toLowerCase()}">${escapeHtml(statusText(currentStatus))}</span></div>
        <div class="profile-tabs"><button class="active" data-profile-tab="profile">Profile</button><button data-profile-tab="attendance">Attendance</button><button data-profile-tab="salary">Salary</button><button data-profile-tab="employment">Employment</button><button data-profile-tab="access">Access</button><button data-profile-tab="documents">Documents</button></div>
        <div class="card staff-editor profile-panel" data-profile-panel="profile">
        <div class="section-heading"><div><span class="eyebrow">Profile</span><h3>Employee details</h3></div></div>
        <div class="form-grid">
          <label>Display name<input id="editName" value="${escapeHtml(s.name)}"></label>
          <label>Outlet<select id="editOutlet">${outlets.map(o=>`<option value="${o.id}" ${Number(o.id)===Number(s.outlet_id)?'selected':''}>${escapeHtml(o.name)}</option>`).join('')}</select></label>
          <label>Role<select id="editRole">${['Staff','Manager','Ops Manager'].map(r=>`<option ${r===(u?.role||'Staff')?'selected':''}>${r}</option>`).join('')}</select></label>
          <label>Joining date<input id="editJoining" type="date" value="${escapeHtml(s.joining_date||'')}"></label>
          <label>Basic salary<input id="editSalary" type="number" min="0" step="0.01" value="${Number(s.basic_salary||0)}"></label>
        </div>
        <label>Notes<textarea id="editNotes" rows="3" placeholder="Optional employment notes">${escapeHtml(s.notes||'')}</textarea></div>
        <div class="card staff-editor profile-panel" data-profile-panel="access" hidden><div class="section-heading"><div><span class="eyebrow">Access</span><h3>Role & permissions</h3></div></div>
        <div class="permissions-box"><div class="card-label">Access permissions</div><div class="permission-grid">
          <label><input type="checkbox" id="editAttendance" ${perms.attendance!==false?'checked':''}> Attendance</label>
          <label><input type="checkbox" id="editPurchase" ${perms.purchase!==false?'checked':''}> Purchases</label>
          <label><input type="checkbox" id="editSummary" ${perms.summary!==false?'checked':''}> Daily Summary</label>
          <label><input type="checkbox" id="editStock" ${perms.stock!==false?'checked':''}> Stock</label>
        </div></div></div>
        <div class="card staff-editor profile-panel" data-profile-panel="employment" hidden><div class="section-heading"><div><span class="eyebrow">Employment</span><h3>Status</h3></div></div><div class="form-grid"><label>Employment status<select id="editEmploymentStatus">${[['ACTIVE','Active'],['VACATION','Vacation'],['LEAVE','On leave'],['INACTIVE','Inactive'],['LEFT','Left employment']].map(([v,l])=>`<option value="${v}" ${v===(s.employment_status||(s.active?'ACTIVE':'INACTIVE'))?'selected':''}>${l}</option>`).join('')}</select></label><label>Status effective from<input id="editStatusDate" type="date" value="${escapeHtml(s.status_effective_from||new Date().toISOString().slice(0,10))}"></label></div><label>Status note<textarea id="editStatusNote" rows="2" placeholder="Optional — e.g. annual vacation">${escapeHtml(s.status_note||'')}</textarea></label>
        </div>
        <div class="card profile-panel" data-profile-panel="attendance" hidden><span class="eyebrow">Attendance</span><h3>Attendance history</h3><p class="section-help">Use the Attendance workspace for the full calendar, corrections and daily status.</p><button type="button" class="secondary profile-open-module" data-module="attendance">Open Attendance</button></div>
        <div class="card profile-panel" data-profile-panel="salary" hidden><span class="eyebrow">Salary</span><h3>Payroll</h3><p class="section-help">Salary is calculated from recorded attendance, paid off-days and staff payments.</p><button type="button" class="secondary profile-open-module" data-module="salary">Open Salary</button></div>
        <div class="card profile-panel" data-profile-panel="documents" hidden><span class="eyebrow">Documents</span><h3>Employee documents</h3><p class="section-help">Identity and onboarding documents are kept in the private employee document storage.</p></div>
        <div id="editMsg"></div><div class="profile-actions"><button id="saveStaff" class="primary">Save changes</button>${profile.is_super_user?'<button id="resetPin" class="secondary">Reset login</button>':''}</div>
      </div>`;
    view.querySelector('#cancelEdit').onclick=renderList;
    view.querySelectorAll('[data-profile-tab]').forEach(tab=>tab.onclick=()=>{view.querySelectorAll('[data-profile-tab]').forEach(x=>x.classList.toggle('active',x===tab));view.querySelectorAll('[data-profile-panel]').forEach(p=>p.hidden=p.dataset.profilePanel!==tab.dataset.profileTab);});
    view.querySelectorAll('.profile-open-module').forEach(btn=>btn.onclick=()=>{const nav=document.querySelector('[data-module="'+btn.dataset.module+'"]');if(nav)nav.click();});
    view.querySelector('#saveStaff').onclick=async()=>{
      const msg=view.querySelector('#editMsg'),btn=view.querySelector('#saveStaff');
      const permissions={attendance:view.querySelector('#editAttendance').checked,purchase:view.querySelector('#editPurchase').checked,summary:view.querySelector('#editSummary').checked,stock:view.querySelector('#editStock').checked,salary:false};
      btn.disabled=true;btn.textContent='Saving…';
      try{
        const {error}=await supabase.rpc('owner_update_staff',{p_staff_id:staffId,p_name:view.querySelector('#editName').value.trim(),p_outlet_id:Number(view.querySelector('#editOutlet').value),p_role:view.querySelector('#editRole').value,p_basic_salary:Number(view.querySelector('#editSalary').value||0),p_joining_date:view.querySelector('#editJoining').value,p_active:!['INACTIVE','LEFT'].includes(view.querySelector('#editEmploymentStatus').value),p_permissions:permissions,p_notes:view.querySelector('#editNotes').value});
        if(error)throw error;
        const {error:statusError}=await supabase.rpc('owner_set_staff_status',{p_staff_id:staffId,p_status:view.querySelector('#editEmploymentStatus').value,p_effective_from:view.querySelector('#editStatusDate').value,p_note:view.querySelector('#editStatusNote').value.trim()||null});
        if(statusError)throw statusError;
        if(error)throw error;
        ({outlets,staffRows,adminRows}=await loadData()); view.querySelector('#staffList').innerHTML='<div class="notice">Staff profile updated.</div>'; renderList();
      }catch(err){msg.innerHTML='<p class="form-error">'+escapeHtml(err.message||'Unable to save changes.')+'</p>';}
      finally{btn.disabled=false;btn.textContent='Save changes';}
    };
    const resetPinBtn=view.querySelector('#resetPin');if(resetPinBtn)resetPinBtn.onclick=async()=>{
      const msg=view.querySelector('#editMsg'),btn=view.querySelector('#resetPin');
      btn.disabled=true;btn.textContent='Resetting…';
      try{
        const {data,error}=await supabase.rpc('superuser_reset_staff_pin_setup',{p_staff_id:staffId});
        if(error)throw error;
        msg.innerHTML='<div class="notice setup-share"><strong>First-time PIN:</strong> <strong class="setup-code">'+escapeHtml(data.setup_code)+'</strong><br><span class="hint">Use 1234 for first-time setup. Their old PIN no longer works.</span><div class="message-preview">${escapeHtml(staffWelcomeMessage(s.name,data.setup_code))}</div><div class="share-actions"><button type="button" id="copyResetWelcome" class="secondary">Copy message</button><button type="button" id="shareResetWhatsApp" class="whatsapp-action">Open WhatsApp</button></div></div>';
        view.querySelector('#copyResetWelcome').onclick=(e)=>copyStaffWelcomeMessage(s.name,data.setup_code,e.currentTarget);
        view.querySelector('#shareResetWhatsApp').onclick=()=>openStaffWelcomeWhatsApp(s.name,data.setup_code);
        ({outlets,staffRows}=await loadData());
      }catch(err){msg.innerHTML='<p class="form-error">'+escapeHtml(err.message||'Unable to reset PIN.')+'</p>';}
      finally{btn.disabled=false;btn.textContent='Reset login';}
    };
  };

  renderList();
  if(profile.is_super_user){
    const panel=view.querySelector('#addAdminPanel'),show=view.querySelector('#showAddAdmin'),cancel=view.querySelector('#cancelAddAdmin'),add=view.querySelector('#addAdminBtn');
    if(show)show.onclick=()=>{panel.hidden=false;show.hidden=true;view.querySelector('#adminName')?.focus();};
    if(cancel)cancel.onclick=()=>{panel.hidden=true;show.hidden=false;view.querySelector('#adminFormMsg').innerHTML='';};
    if(add)add.onclick=async()=>{
      const name=view.querySelector('#adminName').value.trim(),outletId=Number(view.querySelector('#adminOutlet').value),msg=view.querySelector('#adminFormMsg');
      if(!name){msg.innerHTML='<p class="form-error">Admin name is required.</p>';return;}
      add.disabled=true;add.textContent='Creating…';msg.innerHTML='';
      try{
        const {error}=await supabase.rpc('superuser_create_admin',{p_name:name,p_outlet_id:outletId});if(error)throw error;
        ({outlets,staffRows,adminRows}=await loadData());
        renderAdmins();
        view.querySelector('#adminName').value='';panel.hidden=true;show.hidden=false;
        msg.innerHTML='';
      }catch(err){msg.innerHTML='<p class="form-error">'+escapeHtml(err.message||'Unable to create Admin.')+'</p>';}
      finally{add.disabled=false;add.textContent='Create Admin';}
    };
  }
  view.querySelectorAll('[data-people-tab]').forEach(btn=>btn.onclick=()=>{const tab=btn.dataset.peopleTab;view.querySelectorAll('[data-people-tab]').forEach(b=>b.classList.toggle('active',b===btn));view.querySelector('#peopleStaff').hidden=tab!=='staff';view.querySelector('#peopleAdmins').hidden=tab!=='admins';view.querySelector('#peopleAdd').hidden=tab!=='add';if(tab==='staff')renderList();});

  view.querySelector('#addStaffBtn').onclick=async()=>{
    const btn=view.querySelector('#addStaffBtn'),msg=view.querySelector('#staffFormMsg');
    const name=view.querySelector('#staffName').value.trim(),outletId=Number(view.querySelector('#staffOutlet').value),role=view.querySelector('#staffRole').value,joining=view.querySelector('#staffJoining').value,salary=Number(view.querySelector('#staffSalary').value||0);
    const permissions={attendance:view.querySelector('#permAttendance').checked,purchase:view.querySelector('#permPurchase').checked,summary:view.querySelector('#permSummary').checked,stock:view.querySelector('#permStock').checked,salary:false};
    if(!name||!joining||salary<=0){msg.innerHTML='<p class="form-error">Name, joining date and agreed salary are required.</p>';return;}
    btn.disabled=true;btn.textContent='Adding…';msg.innerHTML='';
    try{
      const {data:created,error}=await supabase.rpc('owner_add_staff',{p_name:name,p_outlet_id:outletId,p_role:role,p_basic_salary:salary,p_joining_date:joining,p_permissions:permissions});
      if(error)throw error;
      msg.innerHTML=`<div class="notice setup-share"><strong>Staff member added.</strong><br>First-time PIN: <strong class="setup-code">${escapeHtml(created?.setup_code||'')}</strong><br><span class="hint">Use 1234 for first-time onboarding. They will create their private PIN during setup.</span><div class="message-preview">${escapeHtml(staffWelcomeMessage(name,created?.setup_code||''))}</div><div class="share-actions"><button type="button" id="copyNewWelcome" class="secondary">Copy message</button><button type="button" id="shareNewWhatsApp" class="whatsapp-action">Open WhatsApp</button></div></div>`;
      view.querySelector('#copyNewWelcome').onclick=(e)=>copyStaffWelcomeMessage(name,created?.setup_code||'',e.currentTarget);
      view.querySelector('#shareNewWhatsApp').onclick=()=>openStaffWelcomeWhatsApp(name,created?.setup_code||'');
      view.querySelector('#staffName').value='';view.querySelector('#staffSalary').value='';
      ({outlets,staffRows}=await loadData());renderList();
    }catch(err){msg.innerHTML='<p class="form-error">'+escapeHtml(err.message||'Unable to add staff.')+'</p>';}
    finally{btn.disabled=false;btn.textContent='Add staff member';}
  };
}

async function renderPurchases(view, supabase, profile) {
  const isOwner = profile.access_class === 'ADMIN';
  const { data: categories } = await supabase.from('categories').select('id,name').order('name');
  const { data: items } = await supabase.from('items').select('id,name,category_id,unit,pack_size').eq('active', true).order('name');
  const { data: outlets } = isOwner ? await supabase.from('outlets').select('id,name').order('id') : { data: [] };
  let outletId = (isOwner&&profile.context_outlet_id) || profile.outlet_id || outlets?.[0]?.id;
  const { data: bizDate, error: dateError } = await supabase.rpc('get_effective_business_day', {
    p_outlet_id: outletId,
    p_timestamp: new Date().toISOString()
  });
  if (dateError) {
    view.innerHTML = '<span class="eyebrow">Purchases</span><h2>Purchase entry unavailable</h2><p class="form-error">' + escapeHtml(dateError.message) + '</p>';
    return;
  }

  const businessDate = bizDate;
  view.innerHTML = `
    <div class="section-heading">
      <div><span class="eyebrow">Operations</span><h2>Purchases</h2></div>
      <span class="soft-badge">${escapeHtml(String(businessDate))}</span>
    </div>


    <div class="purchase-tabs">
      <button class="purchase-tab active" data-purchase-mode="item">Item-wise</button>
      <button class="purchase-tab" data-purchase-mode="invoice">Invoice total</button>
    </div>

    <div class="form-grid">
      <label>Category
        <select id="purCategory">
          <option value="">Select category</option>
          ${(categories || []).map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </label>
      <label>Vendor
        <input id="purVendor" placeholder="Vendor name (optional)">
      </label>
    </div>

    <div id="purItemArea">
      <div class="purchase-item-head"><span>Item</span><span>Qty</span><span>Unit</span><span>Amount</span></div>
      <div id="purRows"></div>
      <button id="addPurRow" class="secondary">+ Add item</button>
    </div>

    <div id="purInvoiceArea" hidden>
      <label class="purchase-invoice-field">Invoice amount
        <input id="purInvoice" type="number" min="0" step="0.01" placeholder="0.00">
      </label>
    </div>

    <div class="purchase-total" id="purTotal">Invoice total: 0.00</div>
    <div class="action-row">
      <button id="savePurchase" class="primary">Save Purchase</button>
    </div>
    <div id="purchaseMessage" class="purchase-message" hidden></div>

    <div class="subsection">
      <div class="section-heading"><h3>Recent purchases</h3><span class="soft-badge">${isOwner ? 'All entries' : 'This outlet'}</span></div>
      <div id="purchaseHistory"><div class="loading">Loading…</div></div>
    </div>
  `;

  let mode = 'item';

  const categoryName = () => {
    const id = Number(view.querySelector('#purCategory').value);
    return (categories || []).find(c => Number(c.id) === id)?.name || '';
  };

  const availableItems = () => {
    const cat = Number(view.querySelector('#purCategory').value);
    return (items || []).filter(i => !cat || Number(i.category_id) === cat);
  };

  const itemOptions = (selected='') => availableItems().map(i =>
    `<option value="${escapeHtml(i.id)}" ${i.id === selected ? 'selected' : ''}>${escapeHtml(i.name)}${i.pack_size ? ' · ' + escapeHtml(i.pack_size) : ''}</option>`
  ).join('');

  const updateTotal = () => {
    let total = 0;
    if (mode === 'invoice') total = Number(view.querySelector('#purInvoice')?.value || 0);
    else total = [...view.querySelectorAll('.purAmount')].reduce((s, el) => s + Number(el.value || 0), 0);
    view.querySelector('#purTotal').textContent = `Invoice total: ${total.toFixed(2)}`;
  };

  const addRow = (data={}) => {
    const wrap = document.createElement('div');
    wrap.className = 'purchase-entry-row';
    wrap.innerHTML = `
      <select class="purItem"><option value="">Select item</option>${itemOptions(data.item_id || '')}</select>
      <input class="purQty" type="number" min="0" step="0.01" placeholder="Qty" value="${data.qty || ''}">
      <input class="purUnit" value="${escapeHtml(data.unit || '')}" readonly>
      <input class="purAmount" type="number" min="0" step="0.01" placeholder="Amount" value="${data.invoice_amount || ''}">
      <button class="ghost remove-pur-row" type="button">×</button>
    `;
    const itemSelect = wrap.querySelector('.purItem');
    const unitInput = wrap.querySelector('.purUnit');
    itemSelect.addEventListener('change', () => {
      const item = (items || []).find(i => i.id === itemSelect.value);
      unitInput.value = item?.unit || '';
    });
    wrap.querySelector('.remove-pur-row').onclick = () => { wrap.remove(); updateTotal(); };
    wrap.querySelectorAll('input').forEach(el => el.addEventListener('input', updateTotal));
    view.querySelector('#purRows').appendChild(wrap);
  };

  const refreshRows = () => {
    const rows = [...view.querySelectorAll('.purchase-entry-row')];
    rows.forEach(r => {
      const selected = r.querySelector('.purItem').value;
      r.querySelector('.purItem').innerHTML = '<option value="">Select item</option>' + itemOptions(selected);
      const item = (items || []).find(i => i.id === selected);
      r.querySelector('.purUnit').value = item?.unit || '';
    });
  };

  addRow();
  view.querySelector('#purCategory').addEventListener('change', () => refreshRows());

  view.querySelectorAll('[data-purchase-mode]').forEach(btn => btn.onclick = () => {
    mode = btn.dataset.purchaseMode;
    view.querySelectorAll('[data-purchase-mode]').forEach(b => b.classList.toggle('active', b === btn));
    view.querySelector('#purItemArea').hidden = mode !== 'item';
    view.querySelector('#purInvoiceArea').hidden = mode !== 'invoice';
    updateTotal();
  });

  view.querySelector('#addPurRow').onclick = () => addRow();
  view.querySelector('#purInvoice').addEventListener('input', updateTotal);

  const loadHistory = async () => {
    let query = supabase
      .from('purchases')
      .select('id,business_date,vendor_name,item_id,qty,unit,invoice_amount,entry_type');
    query = query.eq('outlet_id', outletId);
    query = query.eq('business_date', businessDate).order('created_at', { ascending: false }).limit(50);
    const { data: history, error } = await query;
    if (error) {
      view.querySelector('#purchaseHistory').innerHTML = '<p class="form-error">' + escapeHtml(error.message) + '</p>';
      return;
    }
    const itemMap = new Map((items || []).map(i => [i.id, i]));
    const rows = history || [];
    if (!rows.length) {
      view.querySelector('#purchaseHistory').innerHTML = '<div class="notice">No purchases recorded for this business day.</div>';
      return;
    }
    view.querySelector('#purchaseHistory').innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>Entry</th><th>Item</th><th>Qty</th><th>Amount</th></tr></thead>
        <tbody>
          ${rows.map(r => {
            const item = itemMap.get(r.item_id);
            return `<tr><td>${escapeHtml(r.entry_type || 'item')}</td><td>${escapeHtml(item?.name || 'Invoice')}</td><td>${r.qty ? Number(r.qty) + ' ' + escapeHtml(r.unit || '') : '—'}</td><td>${r.invoice_amount ? Number(r.invoice_amount).toFixed(2) : '—'}</td></tr>`;
          }).join('')}
        </tbody>
      </table></div>`;
  };

  const showMessage=(message,type='error')=>{const box=view.querySelector('#purchaseMessage');box.textContent=message;box.className='purchase-message '+(type==='success'?'success':'error');box.hidden=false;if(type==='success')setTimeout(()=>{if(box.isConnected)box.hidden=true;},2400);else box.scrollIntoView({behavior:'smooth',block:'nearest'});};

  view.querySelector('#savePurchase').onclick = async () => {
    const categoryId = Number(view.querySelector('#purCategory').value) || null;
    const vendorName = view.querySelector('#purVendor').value.trim();
    if (!categoryId && !vendorName) return showMessage('Select a category or enter a vendor.','error');
    let payloads = [];

    if (mode === 'invoice') {
      const amount = Number(view.querySelector('#purInvoice').value || 0);
      if (amount <= 0) return showMessage('Enter the invoice amount.','error');
      payloads = [{ item_id: null, qty: 0, unit: '', invoice_amount: amount, entry_type: 'invoice' }];
    } else {
      payloads = [...view.querySelectorAll('.purchase-entry-row')].map(row => {
        const itemId = row.querySelector('.purItem').value;
        const item = (items || []).find(i => i.id === itemId);
        return {
          item_id: itemId || null,
          qty: Number(row.querySelector('.purQty').value || 0),
          unit: row.querySelector('.purUnit').value || item?.unit || '',
          invoice_amount: Number(row.querySelector('.purAmount').value || 0),
          entry_type: 'item'
        };
      }).filter(r => r.item_id && r.qty > 0);
      if (!payloads.length) return showMessage('Add at least one item with a quantity.','error');
    }

    const saveBtn = view.querySelector('#savePurchase');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
      for (const row of payloads) {
        const { error } = await supabase.from('purchases').insert({
          id: `PUR-${profile.outlet_id}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
          business_date: businessDate,
          outlet_id: outletId,
          user_id: profile.id,
          vendor_id: null,
          vendor_name: vendorName || null,
          item_id: row.item_id,
          qty: row.qty,
          unit: row.unit,
          invoice_amount: row.invoice_amount,
          entry_type: row.entry_type
        });
        if (error) throw error;
      }
      showMessage('Purchase saved.','success');
      await loadHistory();
      view.querySelector('#purRows').innerHTML = '';
      if (mode === 'item') addRow(); else view.querySelector('#purInvoice').value = '';
      updateTotal();
    } catch (err) {
      showMessage(err.message || 'Purchase could not be saved.','error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Purchase';
    }
  };

  await loadHistory();

}

async function renderSalary(view, supabase, profile) {
  const isAdmin=profile.access_class==='ADMIN', isManager=['Manager','Ops Manager'].includes(profile.role);
  const {data:userRow}=await supabase.from('users').select('staff_id,outlet_id').eq('id',profile.id).maybeSingle();
  let staff=[];
  if(isAdmin){let q=supabase.from('staff').select('id,name,outlet_id,basic_salary,joining_date,active,employment_status').eq('active',true);if(profile.context_outlet_id)q=q.eq('outlet_id',profile.context_outlet_id);const{data}=await q.order('name');staff=data||[];}
  else if(isManager){const{data}=await supabase.from('staff').select('id,name,outlet_id,basic_salary,joining_date,active,employment_status').eq('active',true).eq('outlet_id',profile.outlet_id).order('name');staff=data||[];}
  else {const{data}=await supabase.from('staff').select('id,name,outlet_id,basic_salary,joining_date,active,employment_status').eq('id',userRow?.staff_id||0);staff=data||[];}
  if(!staff.length){view.innerHTML='<span class="eyebrow">Salary</span><h2>Salary</h2><p class="section-help">No linked active staff record is available.</p>';return;}
  const nowIST=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const month=nowIST.slice(0,7), start=month+'-01', end=nowIST;
  view.innerHTML=`<div class="salary-page">
    <div class="summary-title-row"><div><span class="eyebrow">${isAdmin?'Payroll':'My pay'}</span><h2>Salary</h2><p>Current month · estimated from recorded attendance and payments</p></div><span class="summary-state">Estimated</span></div>
    ${staff.length>1?`<section class="summary-section compact"><label class="summary-label">Staff<select id="salaryStaff">${staff.map(x=>`<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('')}</select></label></section>`:''}
    <div id="salaryEstimate"><p class="section-help">Loading salary…</p></div>
  </div>`;
  const money=n=>'₹'+Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
  const render=async()=>{
    const sid=Number(view.querySelector('#salaryStaff')?.value||staff[0].id), person=staff.find(x=>Number(x.id)===sid);
    const [{data:est,error},{data:final}]=await Promise.all([
      supabase.rpc('get_salary_estimate',{p_staff_id:sid,p_start:start,p_end:end}),
      supabase.from('salary_records').select('net_salary,pay_date,period_start,period_end,created_at').eq('staff_id',sid).eq('period_start',start).order('created_at',{ascending:false}).limit(1).maybeSingle()
    ]);
    if(error){view.querySelector('#salaryEstimate').innerHTML='<p class="form-error">'+escapeHtml(error.message)+'</p>';return;}
    const hasOperationalData=Number(est.present_equivalent_days||0)>0||Number(est.late_mins||0)>0||Number(est.advance_deduction||0)>0||Number(est.loan_deduction||0)>0;
    if(!hasOperationalData&&!final){
      view.querySelector('#salaryEstimate').innerHTML=`<div class="salary-empty-note">${icon('attendance',21)}<div><strong>Not enough records to estimate salary yet</strong><span>No attendance or staff-payment activity is recorded for this period. CafeTracker will not treat missing records as absences.</span></div></div><section class="salary-hero"><span>${escapeHtml(person?.name||'Salary')}</span><strong>${money(est.basic_salary)}</strong><small>Basic salary · estimate pending attendance data</small></section><div class="salary-meta"><span>Daily rate <strong>${money(est.daily_rate)}</strong></span><span>Hourly rate <strong>${money(est.hourly_rate)}</strong></span><span>Paid off entitlement <strong>3 days/month</strong></span></div>`;return;
    }
    const incomplete=est.data_complete===false||Number(est.unrecorded_days||0)>0;
    view.querySelector('#salaryEstimate').innerHTML=`
      ${incomplete?`<div class="salary-empty-note">${icon('attendance',21)}<div><strong>Estimate incomplete</strong><span>${Number(est.unrecorded_days||0)} day(s) have no attendance record. Missing records are not counted as absences.</span></div></div>`:''}
      <section class="salary-hero"><span>${escapeHtml(person?.name||'Salary')}</span><strong>${money(est.estimated_net)}</strong><small>${incomplete?'Provisional amount from recorded data only':'Estimated current-month payable'}</small></section>
      <div class="salary-breakdown">
        <div class="salary-line"><span>Basic salary</span><strong>${money(est.basic_salary)}</strong></div>
        <div class="salary-line positive"><span>Holiday Duty · ${Number(est.holiday_duty_days||0)} day(s)</span><strong>+${money(est.holiday_duty_allowance)}</strong></div>
        <div class="salary-line"><span>Absent · ${Number(est.absent_days||0)} day(s)</span><strong>−${money(est.absent_deduction)}</strong></div>
        <div class="salary-line"><span>Half-day · ${Number(est.half_days||0)}</span><strong>−${money(est.half_day_deduction)}</strong></div>
        <div class="salary-line"><span>Late · ${Number(est.deductible_late_hours||0)} full hour(s)</span><strong>−${money(est.late_deduction)}</strong></div>
        <div class="salary-line"><span>Advances recorded</span><strong>−${money(est.advance_deduction)}</strong></div>
        <div class="salary-line"><span>Loan deductions recorded</span><strong>−${money(est.loan_deduction)}</strong></div>
      </div>
      <div class="salary-meta"><span>Daily rate <strong>${money(est.daily_rate)}</strong></span><span>Hourly rate <strong>${money(est.hourly_rate)}</strong></span><span>Paid off entitlement <strong>3 days/month</strong></span></div>
      ${final?`<div class="salary-final"><div><strong>Saved payroll record</strong><span>${escapeHtml(final.period_start)} – ${escapeHtml(final.period_end)}</span></div><strong>${money(final.net_salary)}</strong></div>`:''}
      ${isAdmin?'<p class="section-help">Payroll remains an estimate until an Admin finalizes the salary record. Incomplete attendance must be reconciled first.</p>':''}`;
  };
  view.querySelector('#salaryStaff')?.addEventListener('change',render);await render();
}

async function renderAttendance(view, supabase, profile) {
  const isOwner=profile.access_class==='ADMIN',isManager=['Manager','Ops Manager'].includes(profile.role),isAdmin=isOwner||isManager;
  const [{data:outlets},{data:userRow}]=await Promise.all([
    isOwner?supabase.from('outlets').select('id,name,theme_key,theme_color').order('id'):Promise.resolve({data:[]}),
    supabase.from('users').select('staff_id,outlet_id').eq('id',profile.id).maybeSingle()
  ]);
  let outletId=Number((profile.access_class==='ADMIN'&&profile.context_outlet_id)||profile.outlet_id||outlets?.[0]?.id||1),staffId=!isAdmin?Number(userRow?.staff_id||0):null;
  const effectiveDate=async id=>{const {data,error}=await supabase.rpc('get_effective_business_day',{p_outlet_id:id,p_timestamp:new Date().toISOString()});return error?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()):String(data);};
  let todayIST=await effectiveDate(outletId);
  let yesterday=(()=>{const d=new Date(todayIST+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);})();
  let monthKey=todayIST.slice(0,7);
  if(!isAdmin&&!staffId){view.innerHTML='<span class="eyebrow">Attendance</span><h2>Staff profile not linked</h2><p class="section-help">Ask an owner to link your CafeTracker user to your staff profile.</p>';return;}
  let filter='today',selectedMonth=monthKey,staffRows=[];
  view.innerHTML=`
    <div class="attendance-page">
      <div class="attendance-home-context"><div><span class="eyebrow">Today</span><strong id="attendanceTodayContext">Loading café day…</strong><small id="attendanceActionContext">Checking attendance status…</small></div></div>
      <div class="summary-title-row"><div><span class="eyebrow">Workforce</span><h2>Attendance</h2><p id="attendanceContext">Today’s attendance</p></div><span class="summary-state" id="attendanceState">Loading…</span></div>

      <section class="summary-section compact"><div class="summary-section-title"><span></span><h3>Filter</h3></div><div class="attendance-tabs"><button data-range="today" class="active">Today</button><button data-range="yesterday">Yesterday</button><button data-range="month">Month</button></div><label id="monthPickerWrap" class="summary-label attendance-month" hidden>Month<input id="attMonth" type="month" value="${selectedMonth}"></label></section>
      ${isAdmin?`<section class="summary-section compact"><div class="summary-section-title"><span></span><h3>Filter by staff</h3></div><label class="summary-label">Staff<select id="attStaff"><option value="">All staff</option></select></label></section>`:''}
      ${!isAdmin?`<section class="attendance-checkin"><div><strong>Mark today’s attendance</strong><span>Take a photo to check in.</span></div><input id="attendancePhoto" type="file" accept="image/jpeg,image/png,image/webp" capture="user" hidden><button id="checkinBtn" class="primary" type="button">Take photo & check in</button><p id="checkinMsg" class="summary-inline-status" hidden></p></section>`:''}
      <div id="attendanceStats"></div>
      <section class="summary-section"><div class="summary-section-title"><span></span><h3 id="attendanceListTitle">Attendance</h3></div><div id="attendanceList"><p class="section-help">Loading attendance…</p></div></section>
    </div>`;
  const outletSelect=view.querySelector('#attOutlet'),staffSelect=view.querySelector('#attStaff'),monthInput=view.querySelector('#attMonth');
  const dateRange=()=>{if(filter==='today')return[todayIST,todayIST];if(filter==='yesterday')return[yesterday,yesterday];const[y,m]=selectedMonth.split('-').map(Number),last=new Date(Date.UTC(y,m,0)).getUTCDate();return[selectedMonth+'-01',selectedMonth+'-'+String(last).padStart(2,'0')];};
  const prettyTime=t=>t?String(t).slice(0,5):'—';
  const prettyDate=d=>new Date(d+'T12:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:filter==='month'?undefined:'numeric'});
  const statusLabel=r=>r.status==='LATE'?('Late · '+r.late_mins+' min'):r.status==='HALF_DAY'?('Half-day · '+r.late_mins+' min late'):({PRESENT:'On time',LEAVE:'Leave',ABSENT:'Absent',WEEKLY_OFF:'Weekly off',UPCOMING:'Upcoming',NOT_CHECKED_IN:'Not checked in',NEEDS_REVIEW:'Needs review'})[r.status]||r.status;
  const statusClass=x=>({PRESENT:'ok',LATE:'warn',HALF_DAY:'warn',LEAVE:'info',ABSENT:'bad',WEEKLY_OFF:'neutral',UPCOMING:'neutral',NOT_CHECKED_IN:'neutral',NEEDS_REVIEW:'bad'})[x]||'neutral';
  const loadStaff=async()=>{if(!isAdmin)return;const{data}=await supabase.from('staff').select('id,name').eq('outlet_id',outletId).eq('active',true).order('name');staffRows=data||[];staffSelect.innerHTML='<option value="">All staff</option>'+staffRows.map(x=>`<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');if(staffId)staffSelect.value=String(staffId);};
  const openPhoto=async path=>{if(!path)return;if(/^https?:/i.test(path)){window.open(path,'_blank','noopener,noreferrer');return;}const{data,error}=await supabase.storage.from('attendance-photos').createSignedUrl(path,60);if(error)return alert(error.message);window.open(data.signedUrl,'_blank','noopener,noreferrer');};
  const correctRow=async r=>{const newTime=prompt('Correct check-in time (HH:MM)',prettyTime(r.punch_time));if(!newTime)return;if(!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(newTime))return alert('Enter time as HH:MM');const reason=prompt('Reason for correction');if(!reason?.trim())return;const{error}=await supabase.rpc('correct_attendance',{p_attendance_id:r.attendance_id,p_punch_time:newTime+':00',p_reason:reason.trim()});if(error)return alert(error.message);await refresh();};
  const refresh=async()=>{
    const[startDate,endDate]=dateRange();view.querySelector('#attendanceState').textContent='Loading…';
    const{data,error}=await supabase.rpc('get_attendance_calendar',{p_outlet_id:outletId,p_staff_id:staffId||null,p_start_date:startDate,p_end_date:endDate});
    if(error){view.querySelector('#attendanceList').innerHTML=`<p class="form-error">${escapeHtml(error.message)}</p>`;view.querySelector('#attendanceState').textContent='Error';return;}
    const rows=data||[],counts={present:rows.filter(r=>['PRESENT','LATE','HALF_DAY','NEEDS_REVIEW'].includes(r.status)).length,late:rows.filter(r=>['LATE','HALF_DAY'].includes(r.status)&&Number(r.late_mins)>0).length,lateMins:rows.reduce((a,r)=>a+Number(r.late_mins||0),0),absent:rows.filter(r=>r.status==='ABSENT').length,leave:rows.filter(r=>r.status==='LEAVE').length,missing:rows.filter(r=>r.status==='NOT_CHECKED_IN').length,half:rows.filter(r=>r.status==='HALF_DAY').length};
    view.querySelector('#attendanceStats').innerHTML=`<div class="attendance-stats"><div><strong>${counts.present}</strong><span>Present</span></div><div><strong>${counts.late}</strong><span>Late</span></div>${filter==='month'?`<div><strong>${counts.lateMins}</strong><span>Late min</span></div><div><strong>${counts.absent}</strong><span>Absent</span></div><div><strong>${counts.leave}</strong><span>Leave</span></div><div><strong>${counts.half}</strong><span>Half-day</span></div>`:`<div><strong>${counts.missing}</strong><span>Not in</span></div><div><strong>${counts.absent}</strong><span>Absent</span></div>`}</div>`;
    const outletName=isOwner?((outlets||[]).find(x=>Number(x.id)===Number(outletId))?.name||'Café'):(profile.outlets?.name||'Café');
    const dayLabel=new Date(todayIST+'T12:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short'});
    view.querySelector('#attendanceTodayContext').textContent=outletName+' · '+dayLabel;
    const reviewCount=rows.filter(r=>r.status==='NEEDS_REVIEW').length;
    const notInCount=rows.filter(r=>r.status==='NOT_CHECKED_IN').length;
    view.querySelector('#attendanceActionContext').textContent=filter!=='today'?'Viewing attendance history':reviewCount?reviewCount+' attendance '+(reviewCount===1?'record needs':'records need')+' review':notInCount?notInCount+' '+(notInCount===1?'person has':'people have')+' not checked in':'No attendance action pending';
    view.querySelector('#attendanceContext').textContent=filter==='today'?'Today’s attendance':filter==='yesterday'?'Yesterday’s attendance':new Date(selectedMonth+'-01T12:00:00').toLocaleDateString('en-GB',{month:'long',year:'numeric'});
    view.querySelector('#attendanceState').textContent=rows.length+(filter==='month'?' calendar rows':' staff');view.querySelector('#attendanceListTitle').textContent=filter==='month'?'Calendar':'Attendance';
    const priority={NEEDS_REVIEW:0,ABSENT:1,NOT_CHECKED_IN:2,LATE:3,HALF_DAY:4,LEAVE:5,PRESENT:6,WEEKLY_OFF:7,UPCOMING:8};
    const ordered=[...rows].sort((a,b)=>filter==='month'?(b.attendance_date.localeCompare(a.attendance_date)||a.staff_name.localeCompare(b.staff_name)):((priority[a.status]??9)-(priority[b.status]??9)||a.staff_name.localeCompare(b.staff_name)));
    view.querySelector('#attendanceList').innerHTML=ordered.length?ordered.map(r=>`<article class="attendance-row ${r.status==='NEEDS_REVIEW'?'attention':''}"><div class="attendance-main"><div class="attendance-name">${escapeHtml(r.staff_name)}</div><div class="attendance-meta">${prettyDate(r.attendance_date)} · Shift ${prettyTime(r.shift_start)}</div></div><div class="attendance-result"><div class="attendance-time">${r.punch_time?prettyTime(r.punch_time):'—'}</div><span class="attendance-badge ${statusClass(r.status)}">${escapeHtml(statusLabel(r))}</span></div><div class="attendance-actions">${r.photo_url?'<button type="button" class="text-action photo-btn">View photo</button>':''}${isAdmin&&r.punch_time?'<button type="button" class="text-action correct-btn">Correct</button>':''}</div></article>`).join(''):'<p class="section-help">No staff records for this period.</p>';
    [...view.querySelectorAll('.attendance-row')].forEach((el,i)=>{const r=ordered[i];el.querySelector('.photo-btn')?.addEventListener('click',()=>openPhoto(r.photo_url));el.querySelector('.correct-btn')?.addEventListener('click',()=>correctRow(r));});
    if(!isAdmin){const row=rows.find(r=>r.attendance_date===todayIST&&Number(r.staff_id)===Number(staffId)),btn=view.querySelector('#checkinBtn');if(btn){btn.disabled=!!row?.punch_time;btn.textContent=row?.punch_time?'Checked in · '+prettyTime(row.punch_time):'Take photo & check in';}}
  };

  if(isAdmin){await loadStaff();staffSelect.onchange=()=>{staffId=staffSelect.value?Number(staffSelect.value):null;refresh();};}
  view.querySelectorAll('.attendance-tabs button').forEach(btn=>btn.onclick=()=>{filter=btn.dataset.range;view.querySelectorAll('.attendance-tabs button').forEach(b=>b.classList.toggle('active',b===btn));view.querySelector('#monthPickerWrap').hidden=filter!=='month';refresh();});
  if(monthInput)monthInput.onchange=()=>{selectedMonth=monthInput.value||monthKey;refresh();};
  if(!isAdmin){const photo=view.querySelector('#attendancePhoto'),btn=view.querySelector('#checkinBtn'),msg=view.querySelector('#checkinMsg');btn.onclick=()=>photo.click();photo.onchange=async()=>{const file=photo.files?.[0];if(!file)return;btn.disabled=true;btn.textContent='Checking in…';msg.hidden=true;const body=new FormData();body.append('photo',file);const{data,error}=await supabase.functions.invoke('chaitracker-attendance',{body});if(error||!data?.ok){msg.textContent=data?.error||error?.message||'Check-in failed';msg.className='summary-inline-status bad';msg.hidden=false;btn.disabled=false;btn.textContent='Take photo & check in';return;}msg.textContent='Attendance recorded';msg.className='summary-inline-status ok';msg.hidden=false;await refresh();};}
  await refresh();
}
