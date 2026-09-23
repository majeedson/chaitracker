const modules = [
  ['home', 'My Day'],
  ['attendance', 'Attendance'],
  ['stock', 'Stock'],
  ['purchase', 'Purchases'],
  ['po', 'Purchase Order'],
  ['summary', 'Daily Summary'],
  ['delta', 'Delta'],
  ['salary', 'Salary'],
  ['dashboard', 'Dashboard']
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

  if (module === 'attendance') {
    await renderAttendance(view, supabase, profile);
    return;
  }

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
