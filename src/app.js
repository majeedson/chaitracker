const modules = [
  ['home', 'My Day'],
  ['attendance', 'Attendance'],
  ['stock', 'Stock'],
  ['purchase', 'Purchases'],
  ['po', 'Purchase Order'],
  ['summary', 'Daily Summary'],
  ['delta', 'Delta'],
  ['salary', 'Salary'],
  ['dashboard', 'Dashboard'],
  ['people', 'People']
];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
    .select('id,name,role,outlet_id,can_switch_outlet,active')
    .eq('auth_user_id', authId)
    .maybeSingle();

  if (!profile?.active) {
    await supabase.auth.signOut();
    await renderLogin(root, supabase);
    return;
  }

  renderWorkspace(root, supabase, profile);
}

async function renderLogin(root, supabase) {
  const [{ data: outlets }, { data: directory, error }] = await Promise.all([
    supabase.from('outlets').select('id,name').order('id'),
    supabase.from('login_directory').select('id,name,role,outlet_id,outlet_name,can_switch_outlet,auth_enrolled,pin_set').order('name')
  ]);

  if (error) {
    root.innerHTML = '<main class="login-shell"><section class="card"><div class="eyebrow">ChaiTracker</div><h1>Login setup unavailable</h1><p class="muted">The login directory could not be loaded.</p></section></main>';
    return;
  }

  root.innerHTML = `
    <main class="login-shell">
      <section class="login-card">
        <div class="login-brand">ChaiTracker</div>
        <p class="login-subtitle">Choose your café and name to continue.</p>

        <div class="login-step">
          <label>Café</label>
          <div class="choice-grid" id="outlet-choice">
            ${(outlets || []).map(o => `<button class="choice" data-outlet="${o.id}">${escapeHtml(o.name)}</button>`).join('')}
          </div>
        </div>

        <div class="login-step">
          <label for="name-select">Your name</label>
          <select id="name-select" disabled>
            <option value="">Select your café first</option>
          </select>
        </div>

        <div class="login-step">
          <label for="pin">PIN</label>
          <input id="pin" inputmode="numeric" autocomplete="current-password" maxlength="8" type="password" placeholder="Enter PIN" disabled>
        </div>

        <button id="login-btn" class="primary full" disabled>Sign in</button>
        <div id="login-error" class="form-error" hidden></div>
        <p class="login-note">First-time PIN setup and account activation will be managed through the owner workflow.</p>
      </section>
    </main>
  `;

  const outletChoice = root.querySelector('#outlet-choice');
  const nameSelect = root.querySelector('#name-select');
  const pin = root.querySelector('#pin');
  const loginBtn = root.querySelector('#login-btn');
  const errorBox = root.querySelector('#login-error');
  let selectedOutlet = null;

  outletChoice.addEventListener('click', e => {
    const button = e.target.closest('[data-outlet]');
    if (!button) return;
    selectedOutlet = Number(button.dataset.outlet);
    outletChoice.querySelectorAll('.choice').forEach(b => b.classList.toggle('selected', b === button));

    const people = (directory || []).filter(u => Number(u.outlet_id) === selectedOutlet);
    nameSelect.disabled = false;
    nameSelect.innerHTML = '<option value="">Select your name</option>' +
      people.map(u => `<option value="${u.id}">${escapeHtml(u.name)} — ${escapeHtml(u.role)}</option>`).join('');
    pin.disabled = true;
    loginBtn.disabled = true;
  });

  nameSelect.addEventListener('change', () => {
    pin.disabled = !nameSelect.value;
    loginBtn.disabled = true;
    if (!nameSelect.value) return;
    pin.focus();
  });

  pin.addEventListener('input', () => {
    pin.value = pin.value.replace(/\D/g, '').slice(0, 8);
    loginBtn.disabled = pin.value.length < 4;
  });

  loginBtn.addEventListener('click', async () => {
    errorBox.hidden = true;
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in…';

    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chaitracker-login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
        },
        body: JSON.stringify({ user_id: nameSelect.value, pin: pin.value })
      });

      const payload = await response.json();
      if (!response.ok || !payload.session) throw new Error(payload.error || 'Sign-in failed.');

      const { error: sessionError } = await supabase.auth.setSession({
        access_token: payload.session.access_token,
        refresh_token: payload.session.refresh_token
      });
      if (sessionError) throw sessionError;

      await renderApp(root, supabase);
    } catch (err) {
      errorBox.textContent = err.message || 'Unable to sign in.';
      errorBox.hidden = false;
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign in';
    }
  });
}

function renderWorkspace(root, supabase, profile) {
  const isOwner = profile.role === 'Owner';

  root.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div>
          <div class="brand">ChaiTracker</div>
          <div class="subtitle">${escapeHtml(profile.name)} · ${escapeHtml(profile.role)}</div>
        </div>
        <div class="topbar-actions">
          <span class="outlet-badge">${isOwner ? 'All outlets' : 'Assigned outlet'}</span>
          <button id="logout" class="ghost">Logout</button>
        </div>
      </header>

      <main class="content">
        <section class="hero card">
          <div>
            <span class="eyebrow">${isOwner ? 'Operations Center' : 'My Day'}</span>
            <h1>${isOwner ? 'Good to see you.' : 'Your ChaiTracker day.'}</h1>
            <p>${isOwner ? 'One place for people, attendance and café operations.' : 'Attendance, leave and your daily tasks in one place.'}</p>
          </div>
        </section>

        <nav class="module-grid">
          ${modules.filter(([id]) => isOwner || !['salary','dashboard','delta'].includes(id)).map(([id,label]) =>
            `<button class="module-card" data-module="${id}"><span class="module-name">${label}</span><span class="module-state">Open</span></button>`
          ).join('')}
        </nav>

        <section id="module-view" class="card module-view"></section>
      </main>
    </div>
  `;

  root.querySelector('#logout').addEventListener('click', async () => {
    await supabase.auth.signOut();
    await renderApp(root, supabase);
  });

  root.querySelectorAll('[data-module]').forEach(button => {
    button.addEventListener('click', () => loadModule(root.querySelector('#module-view'), supabase, profile, button.dataset.module));
  });

  loadModule(root.querySelector('#module-view'), supabase, profile, isOwner ? 'home' : 'attendance');
}

async function loadModule(view, supabase, profile, module) {
  view.innerHTML = '<div class="loading">Loading…</div>';

  if (module === 'attendance') { await renderAttendance(view, supabase, profile); return; }
  if (module === 'summary') { await renderDailySummary(view, supabase, profile); return; }
  if (module === 'salary') { await renderSalary(view, supabase, profile); return; }
  if (module === 'purchase') { await renderPurchases(view, supabase, profile); return; }
  if (module === 'people') { await renderPeople(view, supabase, profile); return; }

  const labels = {
    home: ['My Day', profile.role === 'Owner' ? 'Owner command center foundation is ready.' : 'Your personal workspace is ready.'],
    stock: ['Stock', 'Inventory workflow is the next operations module.'],
    purchase: ['Purchases', 'Purchase entry will connect to vendors, items and business dates.'],
    po: ['Purchase Order', 'Purchase orders will be generated from stock intelligence.'],
    summary: ['Daily Summary', 'Sales, expenses, vendor payments and cash closing will live here.'],
    delta: ['Delta', 'Owner stock delta review will compare business days.'],
    salary: ['Salary', 'Payroll will use attendance, leave and approved adjustments.'],
    dashboard: ['Dashboard', 'The owner dashboard will aggregate operational performance.']
  };

  const [title, copy] = labels[module] || labels.home;
  view.innerHTML = `
    <span class="eyebrow">ChaiTracker</span>
    <h2>${title}</h2>
    <p class="muted">${copy}</p>
    <div class="coming-soon">Module foundation connected</div>
  `;
}

async function renderDailySummary(view, supabase, profile) {
  const isOwner = profile.role === 'Owner';
  const today = new Date().toISOString().slice(0,10);
  let outletId = profile.outlet_id;
  let outlets = [];
  if (isOwner) {
    const { data } = await supabase.from('outlets').select('id,name').order('id');
    outlets = data || [];
    outletId = outletId || outlets[0]?.id;
  }

  const { data: existing } = await supabase
    .from('daily_summaries')
    .select('*')
    .eq('outlet_id', outletId)
    .eq('business_date', today)
    .maybeSingle();

  const { data: outlet } = await supabase.from('outlets').select('name,swiggy_payout_rate,zomato_payout_rate').eq('id', outletId).maybeSingle();
  const swRate = Number(outlet?.swiggy_payout_rate ?? 0.5);
  const zoRate = Number(outlet?.zomato_payout_rate ?? 0.5);

  view.innerHTML = `
    <div class="section-heading"><div><span class="eyebrow">Closing</span><h2>Daily Summary</h2></div><span class="soft-badge">${escapeHtml(outlet?.name || '')} · ${today}</span></div>
    ${isOwner ? `<div class="field-row"><label>Outlet<select id="sumOutlet">${outlets.map(o => `<option value="${o.id}" ${Number(o.id)===Number(outletId)?'selected':''}>${escapeHtml(o.name)}</option>`).join('')}</select></label></div>` : ''}
    <div class="form-grid">
      <label>Cash sale<input id="sCash" type="number" step="0.01" value="${existing?.cash_sale ?? 0}"></label>
      <label>UPI sale<input id="sUpi" type="number" step="0.01" value="${existing?.upi_sale ?? 0}"></label>
      <label>Swiggy gross<input id="sSwGross" type="number" step="0.01" value="${existing?.swiggy_gross ?? 0}"></label>
      <label>Swiggy payout <span class="hint">rate ${Math.round(swRate*100)}%</span><input id="sSwPay" type="number" step="0.01" value="${existing?.swiggy_payout ?? 0}"></label>
      <label>Zomato gross<input id="sZoGross" type="number" step="0.01" value="${existing?.zomato_gross ?? 0}"></label>
      <label>Zomato payout <span class="hint">rate ${Math.round(zoRate*100)}%</span><input id="sZoPay" type="number" step="0.01" value="${existing?.zomato_payout ?? 0}"></label>
      <label>Own digital<input id="sOwn" type="number" step="0.01" value="${existing?.own_digital ?? 0}"></label>
      <label>Discount<input id="sDisc" type="number" step="0.01" value="${existing?.discount ?? 0}"></label>
      <label>Opening cash actual<input id="sOpen" type="number" step="0.01" value="${existing?.opening_cash_actual ?? 0}"></label>
      <label>Physical cash<input id="sPhysical" type="number" step="0.01" value="${existing?.physical_cash ?? 0}"></label>
    </div>
    <div class="summary-preview" id="sumPreview"></div>
    <div class="subsection"><h3>Expenses</h3><div id="expenseRows"></div><button id="addExpense" class="secondary">+ Add expense</button></div>
    <div class="subsection"><h3>Vendor payments</h3><div id="vendorRows"></div><button id="addVendor" class="secondary">+ Add vendor payment</button></div>
    <div class="subsection"><h3>Staff payments</h3><div id="staffRows"></div><button id="addStaff" class="secondary">+ Add staff payment</button></div>
    <div class="action-row"><button id="saveSummary" class="primary">Save Summary</button><button id="closeSummary" class="secondary">Close Day</button></div>
    ${existing?.is_closed ? '<div class="notice warning">This summary is closed. It cannot be edited.</div>' : ''}
  `;

  const disabled = !!existing?.is_closed;
  view.querySelectorAll('input,select,button').forEach(el => { if (disabled) el.disabled = true; });

  const addRow=(container,type,data={})=>{
    const wrap=document.createElement('div'); wrap.className='entry-row';
    if(type==='expense') wrap.innerHTML=`<input class="e-cat" placeholder="Category" value="${escapeHtml(data.category||'')}"><input class="e-amt" type="number" step="0.01" placeholder="Amount" value="${data.amount||''}"><select class="e-mode"><option ${data.mode==='UPI'?'selected':''}>Cash</option><option ${data.mode==='UPI'?'selected':''}>UPI</option></select><button class="remove-row ghost">×</button>`;
    if(type==='vendor') wrap.innerHTML=`<input class="v-name" placeholder="Vendor" value="${escapeHtml(data.vendor_name||'')}"><input class="v-amt" type="number" step="0.01" placeholder="Amount" value="${data.amount||''}"><select class="v-mode"><option ${data.mode==='UPI'?'selected':''}>Cash</option><option ${data.mode==='UPI'?'selected':''}>UPI</option></select><button class="remove-row ghost">×</button>`;
    if(type==='staff') wrap.innerHTML=`<input class="p-name" placeholder="Staff" value="${escapeHtml(data.staff_name||'')}"><input class="p-type" placeholder="Type" value="${escapeHtml(data.payout_type||'Salary')}"><input class="p-amt" type="number" step="0.01" placeholder="Amount" value="${data.amount||''}"><select class="p-mode"><option ${data.mode==='UPI'?'selected':''}>Cash</option><option ${data.mode==='UPI'?'selected':''}>UPI</option></select><button class="remove-row ghost">×</button>`;
    wrap.querySelector('.remove-row').onclick=()=>{wrap.remove();calc();}; container.appendChild(wrap);
    wrap.querySelectorAll('input,select').forEach(e=>e.addEventListener('input',calc));
  };
  const expensesView=await supabase.from('summary_expenses').select('*').eq('summary_id',existing?.id||'');
  const vendorsView=await supabase.from('summary_vendor_payouts').select('*').eq('summary_id',existing?.id||'');
  const staffView=await supabase.from('summary_staff_payouts').select('*').eq('summary_id',existing?.id||'');
  (expensesView.data||[]).forEach(x=>addRow(view.querySelector('#expenseRows'),'expense',x));
  (vendorsView.data||[]).forEach(x=>addRow(view.querySelector('#vendorRows'),'vendor',x));
  (staffView.data||[]).forEach(x=>addRow(view.querySelector('#staffRows'),'staff',x));
  if(!expensesView.data?.length) addRow(view.querySelector('#expenseRows'),'expense');
  const calc=()=>{
    const n=id=>Number(view.querySelector('#'+id)?.value||0);
    const net=n('sCash')+n('sUpi')+n('sSwPay')+n('sZoPay')+n('sOwn')-n('sDisc');
    const cashExpenses=[...view.querySelectorAll('.e-amt')].reduce((s,e,i)=>s+(view.querySelectorAll('.e-mode')[i]?.value==='Cash'?Number(e.value||0):0),0);
    const cashVendors=[...view.querySelectorAll('.v-amt')].reduce((s,e,i)=>s+(view.querySelectorAll('.v-mode')[i]?.value==='Cash'?Number(e.value||0):0),0);
    const cashStaff=[...view.querySelectorAll('.p-amt')].reduce((s,e,i)=>s+(view.querySelectorAll('.p-mode')[i]?.value==='Cash'?Number(e.value||0):0),0);
    const expected=n('sOpen')+n('sCash')-cashExpenses-cashVendors-cashStaff;
    const diff=n('sPhysical')-expected;
    view.querySelector('#sumPreview').innerHTML=`<div class="stats-grid"><div class="stat"><strong>${net.toFixed(2)}</strong><span>Net sale</span></div><div class="stat"><strong>${expected.toFixed(2)}</strong><span>Expected cash</span></div><div class="stat"><strong>${diff.toFixed(2)}</strong><span>Short / excess</span></div></div>`;
  };
  view.querySelectorAll('#sCash,#sUpi,#sSwGross,#sSwPay,#sZoGross,#sZoPay,#sOwn,#sDisc,#sOpen,#sPhysical').forEach(e=>e.addEventListener('input',calc));
  view.querySelector('#addExpense').onclick=()=>addRow(view.querySelector('#expenseRows'),'expense');
  view.querySelector('#addVendor').onclick=()=>addRow(view.querySelector('#vendorRows'),'vendor');
  view.querySelector('#addStaff').onclick=()=>addRow(view.querySelector('#staffRows'),'staff');
  calc();

  view.querySelector('#saveSummary').onclick=async()=>{
    const id=existing?.id || `SUM-${outletId}-${today}`;
    const collect=(selector,map)=>[...view.querySelectorAll(selector)].map(row=>map(row)).filter(x=>x.amount||x.category||x.vendor_name||x.staff_name);
    const expenses=collect('#expenseRows .entry-row',r=>({category:r.querySelector('.e-cat').value.trim(),amount:Number(r.querySelector('.e-amt').value||0),mode:r.querySelector('.e-mode').value}));
    const vendors=collect('#vendorRows .entry-row',r=>({vendor_name:r.querySelector('.v-name').value.trim(),amount:Number(r.querySelector('.v-amt').value||0),mode:r.querySelector('.v-mode').value}));
    const staff=collect('#staffRows .entry-row',r=>({staff_name:r.querySelector('.p-name').value.trim(),payout_type:r.querySelector('.p-type').value.trim()||'Salary',amount:Number(r.querySelector('.p-amt').value||0),mode:r.querySelector('.p-mode').value}));
    const args={p_summary_id:id,p_outlet_id:Number(outletId),p_business_date:today,p_user_id:profile.id,p_user_name:profile.name,p_role:profile.role,p_cash_sale:Number(view.querySelector('#sCash').value||0),p_upi_sale:Number(view.querySelector('#sUpi').value||0),p_swiggy_gross:Number(view.querySelector('#sSwGross').value||0),p_swiggy_payout:Number(view.querySelector('#sSwPay').value||0),p_zomato_gross:Number(view.querySelector('#sZoGross').value||0),p_zomato_payout:Number(view.querySelector('#sZoPay').value||0),p_own_digital:Number(view.querySelector('#sOwn').value||0),p_discount:Number(view.querySelector('#sDisc').value||0),p_opening_cash_system:Number(existing?.opening_cash_system||0),p_opening_cash_actual:Number(view.querySelector('#sOpen').value||0),p_physical_cash:Number(view.querySelector('#sPhysical').value||0),p_expenses:expenses,p_vendor_payouts:vendors,p_staff_payouts:staff};
    const {error}=await supabase.rpc('save_daily_summary',args);
    if(error) return alert(error.message);
    alert('Daily summary saved.');
    await renderDailySummary(view,supabase,profile);
  };
  view.querySelector('#closeSummary').onclick=async()=>{
    const id=existing?.id || `SUM-${outletId}-${today}`;
    const {error}=await supabase.rpc('close_daily_summary',{p_summary_id:id,p_user_id:profile.id});
    if(error) return alert(error.message);
    await renderDailySummary(view,supabase,profile);
  };
}


async function renderPeople(view, supabase, profile) {
  if (profile.role !== 'Owner') {
    view.innerHTML = '<span class="eyebrow">People</span><h2>Owner access required</h2>';
    return;
  }

  const [{ data: outlets }, { data: staffRows }] = await Promise.all([
    supabase.from('outlets').select('id,name').order('id'),
    supabase.from('staff').select('id,name,outlet_id,basic_salary,joining_date,active,users:users!staff_id(id,role,pin_set_at)').order('name')
  ]);

  view.innerHTML = `
    <div class="section-heading">
      <div><span class="eyebrow">People</span><h2>Staff & Users</h2></div>
      <span class="soft-badge">${(staffRows || []).filter(s => s.active).length} active</span>
    </div>

    <div class="subsection">
      <div class="section-heading"><h3>Add staff member</h3><span class="hint">PIN is set by the staff member later</span></div>
      <div class="form-grid">
        <label>Full name<input id="staffName" placeholder="Staff name"></label>
        <label>Outlet<select id="staffOutlet">${(outlets || []).map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}</select></label>
        <label>Role<select id="staffRole"><option>Staff</option><option>Manager</option><option>Ops Manager</option></select></label>
        <label>Joining date<input id="staffJoining" type="date" value="${new Date().toISOString().slice(0,10)}"></label>
        <label>Agreed basic salary<input id="staffSalary" type="number" min="0" step="0.01" placeholder="0.00"></label>
      </div>
      <div class="permissions-box">
        <div class="card-label">Access permissions</div>
        <div class="permission-grid">
          <label><input type="checkbox" id="permAttendance" checked> Attendance</label>
          <label><input type="checkbox" id="permPurchase" checked> Purchases</label>
          <label><input type="checkbox" id="permSummary" checked> Daily Summary</label>
          <label><input type="checkbox" id="permStock" checked> Stock</label>
        </div>
      </div>
      <button id="addStaffBtn" class="primary">Add staff member</button>
      <div id="staffFormMsg"></div>
    </div>

    <div class="subsection">
      <div class="section-heading"><h3>Current staff</h3><span class="hint">Employment and login status</span></div>
      <div id="staffList"></div>
    </div>
  `;

  const renderList = () => {
    const outletMap = new Map((outlets || []).map(o => [Number(o.id), o.name]));
    const rows = staffRows || [];
    view.querySelector('#staffList').innerHTML = rows.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Outlet</th><th>Role</th><th>Joining</th><th>Salary</th><th>PIN</th><th>Status</th></tr></thead>
        <tbody>${rows.map(s => {
          const u = Array.isArray(s.users) ? s.users[0] : s.users;
          return `<tr>
            <td><strong>${escapeHtml(s.name)}</strong></td>
            <td>${escapeHtml(outletMap.get(Number(s.outlet_id)) || '—')}</td>
            <td>${escapeHtml(u?.role || 'Staff')}</td>
            <td>${escapeHtml(s.joining_date || '—')}</td>
            <td>${Number(s.basic_salary || 0).toFixed(2)}</td>
            <td>${u?.pin_set_at ? '<span class="status-ok">Set</span>' : '<span class="status-warn">Not set</span>'}</td>
            <td>${s.active ? '<span class="status-ok">Active</span>' : '<span class="status-warn">Inactive</span>'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : '<div class="notice">No staff records yet.</div>';
  };
  renderList();

  view.querySelector('#addStaffBtn').onclick = async () => {
    const btn=view.querySelector('#addStaffBtn'), msg=view.querySelector('#staffFormMsg');
    const name=view.querySelector('#staffName').value.trim();
    const outletId=Number(view.querySelector('#staffOutlet').value);
    const role=view.querySelector('#staffRole').value;
    const joining=view.querySelector('#staffJoining').value;
    const salary=Number(view.querySelector('#staffSalary').value || 0);
    const permissions={
      attendance:view.querySelector('#permAttendance').checked,
      purchase:view.querySelector('#permPurchase').checked,
      summary:view.querySelector('#permSummary').checked,
      stock:view.querySelector('#permStock').checked,
      salary:false
    };
    if(!name || !joining || salary<=0){msg.innerHTML='<p class="form-error">Name, joining date and agreed salary are required.</p>';return;}
    btn.disabled=true;btn.textContent='Adding…';msg.innerHTML='';
    try{
      const {error}=await supabase.rpc('owner_add_staff',{p_name:name,p_outlet_id:outletId,p_role:role,p_basic_salary:salary,p_joining_date:joining,p_permissions:permissions});
      if(error) throw error;
      msg.innerHTML='<p class="status-ok">Staff member added. They can set their PIN through the first-time login flow.</p>';
      view.querySelector('#staffName').value='';view.querySelector('#staffSalary').value='';
      const {data}=await supabase.from('staff').select('id,name,outlet_id,basic_salary,joining_date,active,users:users!staff_id(id,role,pin_set_at)').order('name');
      staffRows.splice(0,staffRows.length,...(data||[])); renderList();
    }catch(err){msg.innerHTML='<p class="form-error">'+escapeHtml(err.message||'Unable to add staff.')+'</p>';}
    finally{btn.disabled=false;btn.textContent='Add staff member';}
  };
}

async function renderPurchases(view, supabase, profile) {
  const isOwner = profile.role === 'Owner';
  const { data: categories } = await supabase.from('categories').select('id,name').order('name');
  const { data: items } = await supabase.from('items').select('id,name,category_id,unit,pack_size').eq('active', true).order('name');
  const { data: outlets } = isOwner ? await supabase.from('outlets').select('id,name').order('id') : { data: [] };
  let outletId = profile.outlet_id || outlets?.[0]?.id;
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
    ${isOwner ? `<div class="field-row"><label>Outlet<select id="purOutlet">${(outlets || []).map(o => `<option value="${o.id}" ${Number(o.id)===Number(outletId)?'selected':''}>${escapeHtml(o.name)}</option>`).join('')}</select></label></div>` : ''}

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

  view.querySelector('#savePurchase').onclick = async () => {
    const categoryId = Number(view.querySelector('#purCategory').value) || null;
    const vendorName = view.querySelector('#purVendor').value.trim();
    if (!categoryId && !vendorName) return alert('Select a category or enter a vendor.');
    let payloads = [];

    if (mode === 'invoice') {
      const amount = Number(view.querySelector('#purInvoice').value || 0);
      if (amount <= 0) return alert('Enter the invoice amount.');
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
      if (!payloads.length) return alert('Add at least one item with a quantity.');
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
      alert('Purchase saved.');
      await loadHistory();
      view.querySelector('#purRows').innerHTML = '';
      if (mode === 'item') addRow(); else view.querySelector('#purInvoice').value = '';
      updateTotal();
    } catch (err) {
      alert(err.message || 'Purchase could not be saved.');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Purchase';
    }
  };

  await loadHistory();
  if (isOwner) view.querySelector('#purOutlet').addEventListener('change', () => renderPurchases(view, supabase, {...profile, outlet_id:Number(view.querySelector('#purOutlet').value)}));
}

async function renderSalary(view, supabase, profile) {
  if (profile.role !== 'Owner') {
    view.innerHTML='<span class="eyebrow">Salary</span><h2>Owner access required</h2>';
    return;
  }
  const {data: staff}=await supabase.from('staff').select('id,name,outlet_id,basic_salary,joining_date,active').eq('active',true).order('name');
  const {data: outlets}=await supabase.from('outlets').select('id,name').order('id');
  const now=new Date(), defaultStart=new Date(now.getFullYear(),now.getMonth()-1,now.getDate()+1);
  const iso=d=>d.toISOString().slice(0,10);
  view.innerHTML=`
    <div class="section-heading"><div><span class="eyebrow">Owner only</span><h2>Salary Processor</h2></div></div>
    <div class="form-grid">
      <label>Staff<select id="salStaff"><option value="">Select staff</option>${(staff||[]).map(s=>`<option value="${s.id}" data-basic="${s.basic_salary||0}" data-joining="${s.joining_date||''}" data-outlet="${s.outlet_id}">${escapeHtml(s.name)}</option>`).join('')}</select></label>
      <label>Period start<input id="salStart" type="date" value="${iso(defaultStart)}"></label>
      <label>Period end<input id="salEnd" type="date"></label>
      <label>Pay date<input id="salPay" type="date"></label>
    </div>
    <div class="action-row"><button id="loadSalary" class="primary">Load attendance</button></div>
    <div id="salaryData"></div>`;
  const updateDates=()=>{
    const s=new Date(view.querySelector('#salStart').value+'T00:00:00'); const e=new Date(s.getFullYear(),s.getMonth()+1,s.getDate());
    e.setDate(e.getDate()-1); view.querySelector('#salEnd').value=iso(e); const p=new Date(e); p.setDate(p.getDate()+11); view.querySelector('#salPay').value=iso(p);
  };
  updateDates(); view.querySelector('#salStart').onchange=updateDates;
  view.querySelector('#loadSalary').onclick=async()=>{
    const opt=view.querySelector('#salStaff').selectedOptions[0], sid=Number(opt?.value); if(!sid)return;
    const start=view.querySelector('#salStart').value,end=view.querySelector('#salEnd').value;
    const {data:period,error}=await supabase.rpc('get_salary_period',{p_staff_id:sid,p_start:start,p_end:end}); if(error)return alert(error.message);
    const basic=Number(opt.dataset.basic||0), absent=Number(period.absent_days||0), holidayDays=Math.max(0,3-absent), holidayPay=Math.round(basic/30*holidayDays);
    const lateHours=Number(period.late_mins||0)/60, autoPenalty=Math.round((basic/30/12)*lateHours);
    const {data:last}=await supabase.from('salary_records').select('*').eq('staff_id',sid).order('period_end',{ascending:false}).limit(1).maybeSingle();
    const petty=0,ot=0,loanPrev=Number(last?.loan_remaining||0);
    view.querySelector('#salaryData').innerHTML=`
      <div class="stats-grid"><div class="stat"><strong>${period.present_days}</strong><span>Present days</span></div><div class="stat"><strong>${period.absent_days}</strong><span>Absent days</span></div><div class="stat"><strong>${(period.late_mins/60).toFixed(2)}h</strong><span>Late time</span></div></div>
      <div class="form-grid">
        <label>Basic salary<input id="salBasic" type="number" value="${basic}"></label>
        <label>Holiday pay<input id="salHoliday" type="number" value="${holidayPay}"></label>
        <label>Absent deduction<input id="salAbsentDed" type="number" value="0"></label>
        <label>Late penalty<input id="salLate" type="number" value="${autoPenalty}"></label>
        <label>Petty advance<input id="salPetty" type="number" value="${petty}"></label>
        <label>OT credit<input id="salOt" type="number" value="${ot}"></label>
        <label>Previous loan balance<input id="salLoanPrev" type="number" value="${loanPrev}"></label>
        <label>Loan deduction<input id="salLoanDed" type="number" value="0"></label>
        <label>Late penalty waived<select id="salWaive"><option value="false">No</option><option value="true">Yes</option></select></label>
      </div>
      <div class="summary-preview" id="salaryPreview"></div>
      <button id="saveSalary" class="primary">Save salary</button>`;
    const recalc=()=>{
      const n=id=>Number(view.querySelector('#'+id)?.value||0), waive=view.querySelector('#salWaive').value==='true';
      const loanRem=Math.max(0,n('salLoanPrev')-n('salLoanDed')); const net=n('salBasic')+n('salHoliday')+n('salOt')-n('salAbsentDed')-(waive?0:n('salLate'))-n('salPetty')-n('salLoanDed');
      view.querySelector('#salaryPreview').innerHTML=`<div class="stats-grid"><div class="stat"><strong>${net.toFixed(2)}</strong><span>Net salary</span></div><div class="stat"><strong>${loanRem.toFixed(2)}</strong><span>Loan remaining</span></div><div class="stat"><strong>${(n('salOt')).toFixed(2)}</strong><span>OT prepaid</span></div></div>`;
    };
    view.querySelectorAll('#salaryData input,#salaryData select').forEach(e=>e.addEventListener('input',recalc)); recalc();
    view.querySelector('#saveSalary').onclick=async()=>{
      const n=id=>Number(view.querySelector('#'+id)?.value||0), waive=view.querySelector('#salWaive').value==='true';
      const payload={p_id:`SAL-${sid}-${start}`,p_outlet_id:Number(opt.dataset.outlet),p_staff_id:sid,p_period_start:start,p_period_end:end,p_pay_date:view.querySelector('#salPay').value,p_period_days:Number(period.period_days),p_basic_salary:n('salBasic'),p_holiday_pay:n('salHoliday'),p_holiday_days:Math.max(0,3-Number(period.absent_days)),p_present_days:Number(period.present_days),p_absent_days:Number(period.absent_days),p_absent_deduction:n('salAbsentDed'),p_late_mins:Number(period.late_mins),p_late_hours_edited:Number(period.late_mins)/60,p_late_penalty:n('salLate'),p_late_penalty_waived:waive,p_petty_advance:n('salPetty'),p_ot_credit:n('salOt'),p_loan_prev_balance:n('salLoanPrev'),p_loan_deduct_this_month:n('salLoanDed'),p_saved_by:profile.id,p_saved_by_name:profile.name};
      const {error}=await supabase.rpc('save_salary_record',payload); if(error)return alert(error.message); alert('Salary saved.');
    };
  };
}

async function renderAttendance(view, supabase, profile) {
  const isOwner = profile.role === 'Owner';

  if (isOwner) {
    const { data: rows, error } = await supabase
      .from('attendance')
      .select('attendance_date,status,half_day,late_mins,staff:staff_id(name),outlet:outlet_id(name)')
      .order('attendance_date', { ascending: false })
      .limit(100);

    if (error) {
      view.innerHTML = `<span class="eyebrow">Attendance</span><h2>Owner Attendance</h2><p class="form-error">${escapeHtml(error.message)}</p>`;
      return;
    }

    const present = (rows || []).filter(r => r.status === 'Present').length;
    const late = (rows || []).filter(r => Number(r.late_mins) > 0).length;
    const half = (rows || []).filter(r => r.half_day).length;

    view.innerHTML = `
      <div class="section-heading"><div><span class="eyebrow">All outlets</span><h2>Owner Attendance</h2></div><span class="soft-badge">Latest 100</span></div>
      <div class="stats-grid">
        <div class="stat"><strong>${present}</strong><span>Present</span></div>
        <div class="stat"><strong>${late}</strong><span>Late</span></div>
        <div class="stat"><strong>${half}</strong><span>Half-day</span></div>
      </div>
      <div class="table-wrap">
        <table><thead><tr><th>Date</th><th>Staff</th><th>Outlet</th><th>Status</th><th>Late</th></tr></thead>
        <tbody>${(rows || []).map(r => `<tr><td>${escapeHtml(r.attendance_date)}</td><td>${escapeHtml(r.staff?.name || '—')}</td><td>${escapeHtml(r.outlet?.name || '—')}</td><td>${escapeHtml(r.status || '—')}</td><td>${Number(r.late_mins || 0)}m</td></tr>`).join('') || '<tr><td colspan="5">No attendance records yet.</td></tr>'}</tbody></table>
      </div>
    `;
    return;
  }

  const { data: user } = await supabase.from('users').select('staff_id,outlet_id').eq('id', profile.id).maybeSingle();
  if (!user?.staff_id) {
    view.innerHTML = `<span class="eyebrow">Attendance</span><h2>Your attendance</h2><div class="notice warning">Your staff profile is not linked yet. An owner needs to reconcile your staff record before attendance can be captured.</div>`;
    return;
  }

  const { data: rows, error } = await supabase
    .from('attendance')
    .select('attendance_date,status,half_day,late_mins,punch_time,shift_start')
    .eq('staff_id', user.staff_id)
    .order('attendance_date', { ascending: false })
    .limit(31);

  view.innerHTML = `
    <div class="section-heading"><div><span class="eyebrow">Personal</span><h2>My Attendance</h2></div><span class="soft-badge">Last 31</span></div>
    <div class="action-row"><button class="primary" disabled title="Photo capture is being connected next">Mark attendance</button><button class="secondary" disabled>Apply for leave</button></div>
    <div class="notice">Attendance capture will require the staff photo flow from the legacy app. The database and role-specific view are ready.</div>
    ${error ? `<p class="form-error">${escapeHtml(error.message)}</p>` : `
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Status</th><th>Late</th><th>Punch</th></tr></thead>
    <tbody>${(rows || []).map(r => `<tr><td>${escapeHtml(r.attendance_date)}</td><td>${escapeHtml(r.status || '—')}</td><td>${Number(r.late_mins || 0)}m</td><td>${escapeHtml(r.punch_time ? new Date(r.punch_time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—')}</td></tr>`).join('') || '<tr><td colspan="4">No attendance records yet.</td></tr>'}</tbody></table></div>`}
  `;
}
