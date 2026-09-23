const modules = [
  ['dashboard', 'Dashboard'],
  ['attendance', 'Attendance'],
  ['stock', 'Stock'],
  ['purchase', 'Purchase'],
  ['po', 'Purchase Order'],
  ['summary', 'Daily Summary'],
  ['delta', 'Delta'],
  ['salary', 'Salary']
];

export function renderApp(root, supabase) {
  root.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div>
          <div class="brand">ChaiTracker</div>
          <div class="subtitle">Teapot · ChaiCafe</div>
        </div>
        <div id="connection" class="status-pill">Connecting…</div>
      </header>
      <main class="content">
        <section class="welcome card">
          <span class="eyebrow">Migration build</span>
          <h1>Operations, rebuilt on Supabase.</h1>
          <p>The new application foundation is connected to the ChaiTracker database. Existing workflows will be migrated module by module while the legacy Apps Script app remains intact.</p>
        </section>
        <section class="module-grid">
          ${modules.map(([id, label]) => `
            <button class="module-card" data-module="${id}">
              <span class="module-name">${label}</span>
              <span class="module-state">Foundation ready</span>
            </button>
          `).join('')}
        </section>
        <section id="module-view" class="card module-view">
          <span class="eyebrow">Current foundation</span>
          <h2>Seasonal outlet hours</h2>
          <p>Outlet schedules can now change by season and weekday without changing application code.</p>
          <div class="module-actions">
            <button id="test-db" class="primary">Test Supabase</button>
          </div>
          <pre id="db-result" class="result" hidden></pre>
        </section>
      </main>
    </div>
  `;

  const connection = root.querySelector('#connection');
  const result = root.querySelector('#db-result');

  supabase.from('outlets').select('id,name,timezone').order('id').then(({ data, error }) => {
    if (error) {
      connection.textContent = 'Database check failed';
      connection.classList.add('error');
      result.hidden = false;
      result.textContent = error.message;
      return;
    }
    connection.textContent = `${data?.length || 0} outlets connected`;
    connection.classList.add('success');
    result.hidden = false;
    result.textContent = JSON.stringify(data, null, 2);
  });

  root.querySelectorAll('[data-module]').forEach(button => {
    button.addEventListener('click', () => {
      root.querySelectorAll('[data-module]').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
      root.querySelector('#module-view h2').textContent = button.textContent.trim().split('\n')[0];
      root.querySelector('#module-view p').textContent =
        'This module is mapped to the new Supabase architecture and is ready for its legacy workflow migration.';
    });
  });

  root.querySelector('#test-db').addEventListener('click', async () => {
    const { data, error } = await supabase
      .from('outlets')
      .select('id,name,timezone,default_open_time,default_close_time')
      .order('id');

    result.hidden = false;
    result.textContent = error ? error.message : JSON.stringify(data, null, 2);
  });
}
