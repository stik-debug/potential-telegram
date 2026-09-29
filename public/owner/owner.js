(function () {
  const state = { token: localStorage.getItem('ch_owner_token'), user: null };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || res.statusText);
    return data;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
  }

  function formatKES(n) {
    return 'KES ' + Number(n || 0).toLocaleString('en-KE');
  }

  function showApp() {
    $('#login-gate').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#owner-name').textContent = state.user.name;
    loadDashboard();
  }

  async function login(phone, pin) {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ phone, pin }) });
    if (data.user.platform_role !== 'SUPER_ADMIN') throw new Error('SUPER_ADMIN access required');
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('ch_owner_token', data.token);
    showApp();
  }

  function logout() {
    state.token = null;
    state.user = null;
    localStorage.removeItem('ch_owner_token');
    $('#app').classList.add('hidden');
    $('#login-gate').classList.remove('hidden');
  }

  function switchView(name) {
    $$('.view').forEach(v => v.classList.remove('active'));
    $$('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === name));
    const el = $('#view-' + name);
    if (el) el.classList.add('active');
    const titles = { dashboard: 'Dashboard', chamas: 'Chamas', plans: 'Subscription Plans', users: 'Users', payments: 'Payments', audit: 'Audit Logs', settings: 'Settings' };
    $('#view-title').textContent = titles[name] || name;
    if (name === 'dashboard') loadDashboard();
    if (name === 'chamas') loadChamas();
    if (name === 'users') loadUsers();
    if (name === 'payments') loadPayments();
    if (name === 'audit') loadAudit();
    if (name === 'plans') loadPlans();
    if (name === 'settings') loadSettings();
  }

  async function loadDashboard() {
    try {
      const s = await api('/api/owner/stats');
      const items = [
        ['Total users', s.total_users],
        ['Active users', s.active_users],
        ['Total Chamas', s.total_chamas],
        ['Active Chamas', s.active_chamas],
        ['Trial', s.trial_chamas],
        ['Paid (ACTIVE)', s.paid_chamas],
        ['Past due', s.past_due_chamas],
        ['Suspended', s.suspended_chamas],
        ['MRR', formatKES(s.mrr)],
        ['Revenue this month', formatKES(s.revenue_month)],
        ['Revenue this year', formatKES(s.revenue_year)],
        ['Pending payments', s.pending_payments],
        ['Failed payments', s.failed_payments],
        ['Total members', s.total_members],
        ['New Chamas (month)', s.new_chamas_month],
        ['New users (month)', s.new_users_month],
      ];
      $('#stat-grid').innerHTML = items.map(([l, v]) =>
        `<div class="stat"><div class="lbl">${l}</div><div class="val">${v}</div></div>`
      ).join('');
    } catch (e) {
      toast(e.message);
      if (/Unauthorized|SUPER_ADMIN/i.test(e.message)) logout();
    }
  }

  async function loadChamas() {
    try {
      const search = $('#chama-search').value;
      const status = $('#chama-filter').value;
      const q = new URLSearchParams({ search, status }).toString();
      const data = await api('/api/owner/chamas?' + q);
      $('#chama-tbody').innerHTML = data.chamas.map(c => `
        <tr>
          <td>${c.id}</td>
          <td><strong>${esc(c.name)}</strong></td>
          <td>${esc(c.admin_name || '—')}</td>
          <td>${esc(c.admin_phone || '—')}</td>
          <td>${c.member_count}/${c.max_members}</td>
          <td>${esc(c.plan || '—')}</td>
          <td><span class="badge ${c.subscription_status || ''}">${c.subscription_status || '—'}</span></td>
          <td>${c.period_end || '—'}</td>
          <td>${formatKES(c.total_paid)}</td>
          <td><span class="badge ${c.status}">${c.status}</span></td>
          <td><button class="btn-sm" data-open-chama="${c.id}">Open</button></td>
        </tr>
      `).join('') || '<tr><td colspan="11">No chamas</td></tr>';
    } catch (e) { toast(e.message); }
  }

  async function openChama(id) {
    try {
      const data = await api('/api/owner/chamas/' + id);
      const c = data.chama;
      const s = data.subscription;
      const f = data.financials;
      $('#chama-detail').innerHTML = `
        <h3>${esc(c.name)}</h3>
        <p class="muted">ID ${c.id} · ${esc(c.invite_code || '')} · Created ${c.created_at && c.created_at.slice(0, 10)}</p>
        <div class="row"><span>Platform status</span><span class="badge ${c.status}">${c.status}</span></div>
        <div class="row"><span>Suspend reason</span><span>${esc(c.suspend_reason || '—')}</span></div>
        <div class="row"><span>Subscription</span><span class="badge ${s && s.status}">${s ? s.status : '—'}</span></div>
        <div class="row"><span>Period end</span><span>${s ? s.current_period_end : '—'}</span></div>
        <div class="row"><span>Amount</span><span>${s ? formatKES(s.amount) : '—'}</span></div>
        <div class="row"><span>Contributions</span><span>${formatKES(f.total_contributions)}</span></div>
        <div class="row"><span>Active loans</span><span>${formatKES(f.total_loans)} (${f.loan_count})</span></div>
        <div class="row"><span>Members</span><span>${data.members.length}</span></div>
        <h4 style="margin-top:16px">Members</h4>
        ${data.members.map(m => `<div class="row"><span>${esc(m.name)} · ${esc(m.role)}</span><span>${esc(m.phone)}</span></div>`).join('')}
        <div class="row"><span>Current plan</span><span>${esc(s && data.plan_name ? data.plan_name : (s ? 'Plan #' + s.plan_id : '—'))}</span></div>
        <div class="drawer-actions">
          ${c.status === 'SUSPENDED'
            ? `<button class="btn-sm ok" data-reactivate="${c.id}">Reactivate</button>`
            : `<button class="btn-sm danger" data-suspend="${c.id}">Suspend Chama</button>`}
          <button class="btn-sm" data-extend="${c.id}" data-days="30">Extend 30 days</button>
          <button class="btn-sm" data-extend="${c.id}" data-days="7">Extend 7 days</button>
          <button class="btn-sm" data-change-plan="${c.id}">Change plan</button>
        </div>
      `;
      $('#chama-drawer').classList.remove('hidden');
    } catch (e) { toast(e.message); }
  }


  async function loadPlans() {
    try {
      const data = await api('/api/owner/plans');
      $('#plans-grid').innerHTML = data.plans.map(pl => `
        <div class="plan-card ${pl.active ? '' : 'inactive'}">
          <div class="plan-name">${esc(pl.name)}</div>
          <div class="plan-price">${formatKES(pl.price)} <span>/ ${esc(pl.billing_cycle || 'month')}</span></div>
          <div class="plan-desc">${esc(pl.description || '')}</div>
          <ul>
            <li>Up to <strong>${pl.max_members}</strong> members</li>
            <li>${pl.trial_days || 0}-day trial</li>
            ${(pl.features || []).slice(0, 6).map(f => '<li>' + esc(f.replace(/_/g, ' ')) + '</li>').join('')}
          </ul>
          <div class="plan-actions">
            <button class="btn-sm" data-edit-plan="${pl.id}">Edit</button>
            <button class="btn-sm ${pl.active ? 'danger' : 'ok'}" data-toggle-plan="${pl.id}" data-active="${pl.active ? '0' : '1'}">
              ${pl.active ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        </div>
      `).join('') || '<p class="muted">No plans</p>';
    } catch (e) { toast(e.message); }
  }

  async function loadUsers() {
    try {
      const search = $('#user-search').value;
      const data = await api('/api/owner/users?search=' + encodeURIComponent(search));
      $('#user-tbody').innerHTML = data.users.map(u => `
        <tr>
          <td>${esc(u.name)}</td>
          <td>${esc(u.phone)}</td>
          <td>${esc(u.platform_role)}${u.chama_role ? ' / ' + u.chama_role : ''}</td>
          <td>${esc(u.chama_name || '—')}</td>
          <td><span class="badge ${u.status}">${u.status}</span></td>
          <td>${u.last_login ? u.last_login.slice(0, 16).replace('T', ' ') : '—'}</td>
        </tr>
      `).join('');
    } catch (e) { toast(e.message); }
  }

  async function loadPayments() {
    try {
      const search = $('#pay-search').value;
      const status = $('#pay-filter').value;
      const q = new URLSearchParams({ search, status }).toString();
      const data = await api('/api/owner/payments?' + q);
      $('#pay-tbody').innerHTML = data.payments.map(p => `
        <tr>
          <td>${p.id}</td>
          <td>${esc(p.chama_name || p.chama_id)}</td>
          <td>${esc(p.payer_name || p.phone || '—')}</td>
          <td>${formatKES(p.amount)}</td>
          <td>${esc(p.method || p.provider || '—')}</td>
          <td>${esc(p.mpesa_ref || '—')}</td>
          <td><span class="badge ${p.status}">${p.status}</span></td>
          <td>${(p.completed_at || p.created_at || '').slice(0, 16).replace('T', ' ')}</td>
        </tr>
      `).join('') || '<tr><td colspan="8">No payments</td></tr>';
    } catch (e) { toast(e.message); }
  }

  async function loadAudit() {
    try {
      const data = await api('/api/owner/audit');
      $('#audit-tbody').innerHTML = data.logs.map(a => `
        <tr>
          <td>${(a.created_at || '').slice(0, 19).replace('T', ' ')}</td>
          <td>${esc(a.actor_name || a.actor_id || '—')}</td>
          <td>${esc(a.action)}</td>
          <td>${esc((a.target_type || '') + ' ' + (a.target_id || ''))}</td>
          <td><code style="font-size:11px">${esc(JSON.stringify(a.meta || {}))}</code></td>
        </tr>
      `).join('');
    } catch (e) { toast(e.message); }
  }

  async function loadSettings() {
    try {
      const data = await api('/api/owner/settings');
      const s = data.settings;
      $('#set-name').value = s.platform_name || '';
      $('#set-email').value = s.support_email || '';
      $('#set-phone').value = s.support_phone || '';
      $('#set-trial').value = s.trial_days || 14;
      $('#set-grace').value = s.grace_days || 3;
      $('#set-maint').checked = !!s.maintenance_mode;
    } catch (e) { toast(e.message); }
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // Events
  $('#owner-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await login($('#phone').value.trim(), $('#pin').value);
    } catch (err) { toast(err.message); }
  });
  $('#btn-logout').addEventListener('click', logout);
  $$('.nav').forEach(n => n.addEventListener('click', () => switchView(n.dataset.view)));
  $('#chama-search').addEventListener('input', () => loadChamas());
  $('#chama-filter').addEventListener('change', () => loadChamas());
  $('#user-search').addEventListener('input', () => loadUsers());
  $('#pay-search').addEventListener('input', () => loadPayments());
  $('#pay-filter').addEventListener('change', () => loadPayments());
  $('#drawer-close').addEventListener('click', () => $('#chama-drawer').classList.add('hidden'));
  $('#drawer-x').addEventListener('click', () => $('#chama-drawer').classList.add('hidden'));

  document.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open-chama]');
    if (open) openChama(open.dataset.openChama);

    const sus = e.target.closest('[data-suspend]');
    if (sus) {
      const reason = prompt('Suspension reason:', 'Subscription payment overdue');
      if (reason === null) return;
      if (!confirm('Suspend this Chama? Data will be preserved.')) return;
      try {
        await api('/api/owner/chamas/' + sus.dataset.suspend + '/suspend', {
          method: 'POST', body: JSON.stringify({ reason }),
        });
        toast('Chama suspended');
        $('#chama-drawer').classList.add('hidden');
        loadChamas();
        loadDashboard();
      } catch (err) { toast(err.message); }
    }

    const rea = e.target.closest('[data-reactivate]');
    if (rea) {
      if (!confirm('Reactivate this Chama?')) return;
      try {
        await api('/api/owner/chamas/' + rea.dataset.reactivate + '/reactivate', {
          method: 'POST', body: JSON.stringify({ extend_days: 30 }),
        });
        toast('Chama reactivated (+30 days)');
        $('#chama-drawer').classList.add('hidden');
        loadChamas();
      } catch (err) { toast(err.message); }
    }

    const ext = e.target.closest('[data-extend]');
    if (ext) {
      try {
        await api('/api/owner/chamas/' + ext.dataset.extend + '/extend', {
          method: 'POST', body: JSON.stringify({ days: parseInt(ext.dataset.days, 10) }),
        });
        toast('Extended ' + ext.dataset.days + ' days');
        openChama(ext.dataset.extend);
        loadChamas();
      } catch (err) { toast(err.message); }
    }
  });

  $('#btn-manual-pay').addEventListener('click', async () => {
    const chama_id = prompt('Chama ID:');
    const amount = prompt('Amount (KES):', '500');
    const reference = prompt('Reference / receipt:', 'MANUAL-' + Date.now());
    if (!chama_id || !amount) return;
    try {
      const r = await api('/api/owner/payments/manual', {
        method: 'POST',
        body: JSON.stringify({ chama_id: parseInt(chama_id, 10), amount: parseInt(amount, 10), reference, method: 'MANUAL' }),
      });
      toast(r.message || 'Payment recorded');
      loadPayments();
      loadDashboard();
    } catch (e) { toast(e.message); }
  });

  $('#btn-save-settings').addEventListener('click', async () => {
    try {
      await api('/api/owner/settings', {
        method: 'POST',
        body: JSON.stringify({
          settings: {
            platform_name: $('#set-name').value,
            support_email: $('#set-email').value,
            support_phone: $('#set-phone').value,
            trial_days: parseInt($('#set-trial').value, 10),
            grace_days: parseInt($('#set-grace').value, 10),
            maintenance_mode: $('#set-maint').checked,
          },
        }),
      });
      toast('Settings saved');
    } catch (e) { toast(e.message); }
  });

  $('#btn-toggle-maint').addEventListener('click', async () => {
    const enabled = !($('#set-maint').checked);
    if (enabled && !confirm('Enable maintenance mode?')) return;
    try {
      await api('/api/owner/maintenance', { method: 'POST', body: JSON.stringify({ enabled }) });
      $('#set-maint').checked = enabled;
      toast(enabled ? 'Maintenance ON' : 'Maintenance OFF');
    } catch (e) { toast(e.message); }
  });

  $('#btn-run-expiry').addEventListener('click', async () => {
    try {
      const r = await api('/api/owner/run-expiry', { method: 'POST', body: '{}' });
      toast(r.message + ' (' + r.processed + ' changes)');
      loadDashboard();
      loadChamas();
    } catch (e) { toast(e.message); }
  });

  // Boot
  (async () => {
    if (state.token) {
      try {
        const data = await api('/api/me');
        if (data.user.platform_role !== 'SUPER_ADMIN') throw new Error('not owner');
        state.user = data.user;
        showApp();
      } catch {
        logout();
      }
    }
  })();
})();
