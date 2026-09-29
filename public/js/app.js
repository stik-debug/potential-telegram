/* ChamaHub Kenya v2 — API client with Add Member + clear payments */
(function () {
  'use strict';

  const state = {
    token: localStorage.getItem('ch_token') || null,
    user: null,
    chama: null,
    dashboard: null,
    canManage: false,
    onboardStep: 0,
    currentPage: 'home',
    theme: localStorage.getItem('ch-theme') || 'light',
    perfMode: localStorage.getItem('ch-perf') === '1',
    reducedMotion: localStorage.getItem('ch-motion') === '1',
    contribAmount: 2000,
    selectedMethodId: null,
    paymentMethods: [],
    canConfirmContrib: false,
  };

  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
    return data;
  }

  function formatKES(n) {
    return 'KES ' + Number(n || 0).toLocaleString('en-KE');
  }
  function formatDate(str) {
    if (!str) return '';
    const d = new Date(str);
    if (isNaN(d)) return str;
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const y = new Date(now); y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
  }
  function initials(n) {
    return (n || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  }
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }
  function toast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3200);
  }

  function showView(id) {
    $$('.view').forEach(v => v.classList.remove('active'));
    const el = $('#view-' + id);
    if (el) el.classList.add('active');
  }

  function showPage(page) {
    state.currentPage = page;
    $$('.page').forEach(p => p.classList.remove('active'));
    const el = $('#page-' + page);
    if (el) el.classList.add('active');
    $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
    const titles = {
      home: 'Home', chama: 'Chama', money: 'Money', messages: 'Messages',
      profile: 'Profile', owner: 'Control Center', subscription: 'Subscription',
      meetings: 'Meetings', contribute: 'Contribute', payment: '', success: '', expired: 'Subscription',
    };
    const ht = $('#header-title');
    if (ht) ht.textContent = titles[page] || 'ChamaHub';
    const app = $('#view-app');
    if (app) app.classList.toggle('hide-nav', ['contribute', 'payment', 'success', 'expired'].includes(page));
    if (page === 'home') loadDashboard();
    if (page === 'chama') loadMembers();
    if (page === 'money') loadMoney();
    if (page === 'messages') loadMessages();
    if (page === 'profile') renderProfile();
    if (page === 'owner') loadOwner();
    if (page === 'subscription') loadSubscription();
    if (page === 'meetings') loadMeetings();
    if (page === 'contribute') { loadPaymentMethods(); renderContributeSummary(); }
  }

  function openModal(id) {
    const m = $('#' + id);
    if (m) m.classList.remove('hidden');
  }
  function closeModals() {
    $$('.modal').forEach(m => m.classList.add('hidden'));
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme === 'dark' ? 'dark' : 'light');
    localStorage.setItem('ch-theme', state.theme);
  }
  function applyPerf() {
    document.body.classList.toggle('perf-mode', state.perfMode);
    localStorage.setItem('ch-perf', state.perfMode ? '1' : '0');
    const t = $('#perf-toggle');
    if (t) t.classList.toggle('on', state.perfMode);
  }
  function applyMotion() {
    document.body.classList.toggle('reduced-motion', state.reducedMotion);
    localStorage.setItem('ch-motion', state.reducedMotion ? '1' : '0');
    const t = $('#motion-toggle');
    if (t) t.classList.toggle('on', state.reducedMotion);
  }

  // ---------- LOADERS ----------
  async function loadDashboard() {
    try {
      const data = await api('/api/dashboard');
      state.dashboard = data;
      state.chama = data.chama;
      state.canManage = !!data.can_manage;
      state.canConfirmContrib = ['CHAMA_ADMIN', 'TREASURER', 'chair', 'treasurer'].includes((data.member_role || '').toUpperCase().replace('CHAIR', 'CHAMA_ADMIN')) || data.can_manage;
      if (data.chama.subscription_status === 'EXPIRED') {
        showPage('expired');
        return;
      }
      const cn = $('.chama-name');
      if (cn) cn.textContent = data.chama.name;
      const bal = $('#balance-amount');
      if (bal) bal.textContent = formatKES(data.total_savings);
      const stats = $$('.balance-stats .b-value');
      if (stats[0]) stats[0].textContent = formatKES(data.month_contributions);
      if (stats[1]) stats[1].textContent = formatKES(data.outstanding_loans);
      if (stats[2]) stats[2].textContent = 'Fri ' + (data.chama.contribution_amount || 2000).toLocaleString();
      const metrics = $$('.metric-value');
      if (metrics[0]) metrics[0].textContent = formatKES(data.total_savings);
      if (metrics[1]) metrics[1].textContent = formatKES(data.month_contributions);
      if (metrics[2]) metrics[2].textContent = formatKES(data.outstanding_loans);
      if (metrics[3]) metrics[3].textContent = data.member_count + ' / ' + data.chama.max_members;
    } catch (e) {
      toast(e.message);
      if (/log in|Unauthorized|token/i.test(e.message)) logout();
    }
  }

  async function loadMembers() {
    try {
      const data = await api('/api/members');
      state.canManage = !!data.can_manage;
      state.canConfirmContrib = ['CHAMA_ADMIN', 'TREASURER', 'chair', 'treasurer'].includes((data.member_role || '').toUpperCase().replace('CHAIR', 'CHAMA_ADMIN')) || data.can_manage;
      const list = $('#member-list');
      if (!list) return;
      list.innerHTML = data.members.map(m => {
        const removeBtn = state.canManage && m.role !== 'chair' && m.id !== state.user.id
          ? `<button class="btn-icon-sm danger" data-remove-member="${m.id}">Remove</button>`
          : '';
        return `<div class="member-card">
          <div class="member-avatar" style="background:${m.avatar_color || '#0D5C45'}">${initials(m.name)}</div>
          <div class="member-info">
            <h4>${esc(m.name)}</h4>
            <p>${esc(m.phone)} · ${formatKES(m.total_contributed)} contributed</p>
            <p>${m.outstanding_loan > 0 ? 'Loan ' + formatKES(m.outstanding_loan) : 'No active loan'}</p>
          </div>
          <div class="member-actions">
            <span class="member-role">${esc(m.role)}</span>
            ${removeBtn}
          </div>
        </div>`;
      }).join('');

      const count = $('.section-title .count');
      if (count) count.textContent = data.member_count + ' / ' + data.max_members;

      const manage = $('#manage-actions');
      const noManage = $('#no-manage');
      if (manage) manage.style.display = data.can_manage ? 'block' : 'none';
      if (noManage) noManage.style.display = data.can_manage ? 'none' : 'block';

      const codeEl = $('#invite-code-display');
      if (codeEl) codeEl.textContent = data.invite_code || '—';
      const olist = document.getElementById('official-methods-list');
      if (olist) {
        api('/api/payment-methods').then(d => {
          olist.innerHTML = (d.methods || []).map(m =>
            '<div class="member-card" style="padding:10px"><div class="member-info"><h4>' + esc(m.label) + '</h4><p>' + esc(m.details) + '</p></div>' +
            (data.can_manage ? '<button class="btn-icon-sm danger" data-del-method="' + m.id + '">Remove</button>' : '') + '</div>'
          ).join('') || '<p class="muted">None yet</p>';
        }).catch(() => {});
      }
      const hint = $('#invite-hint');
      if (hint) hint.textContent = 'Invite code: ' + (data.invite_code || '—');
    } catch (e) {
      toast(e.message);
    }
  }

  async function loadMoney() {
    try {
      // officials can confirm pending ledger entries
      if (state.chama && state.chama.member_role) {
        const r = String(state.chama.member_role).toUpperCase();
        state.canConfirmContrib = r.includes('ADMIN') || r.includes('TREASURER') || r === 'CHAIR';
      }
      const [contrib, loans] = await Promise.all([
        api('/api/contributions'),
        api('/api/loans'),
      ]);

      // Summary cards
      let summary = $('#contrib-summary');
      if (!summary) {
        const panel = $('#tab-contrib');
        if (panel) {
          summary = document.createElement('div');
          summary.id = 'contrib-summary';
          summary.className = 'contrib-summary-bar';
          const hero = panel.querySelector('.contrib-hero');
          if (hero) hero.after(summary);
          else panel.prepend(summary);
        }
      }
      if (summary) {
        summary.innerHTML = `
          <div class="cs-card"><span class="cs-val">${formatKES(contrib.total)}</span><span class="cs-lbl">All time</span></div>
          <div class="cs-card"><span class="cs-val">${formatKES(contrib.mine)}</span><span class="cs-lbl">My total</span></div>
          <div class="cs-card"><span class="cs-val">${contrib.count}</span><span class="cs-lbl">Payments</span></div>
        `;
      }

      if (state.dashboard) {
        const h2 = $('.contrib-hero h2');
        if (h2) h2.textContent = formatKES(state.dashboard.month_contributions);
      }

      const html = contrib.contributions.map(c => {
        const statusClass = c.status === 'SUCCESS' || c.status === 'completed' ? 'completed' : 'pending';
        const statusLabel = c.status === 'SUCCESS' || c.status === 'completed' ? 'Paid' : 'Pending';
        const sign = c.status === 'SUCCESS' || c.status === 'completed' ? '+' : '';
        return `<div class="tx-item">
          <div class="tx-icon">${c.status === 'SUCCESS' || c.status === 'completed' ? '↑' : '…'}</div>
          <div class="tx-info">
            <h4>${esc(c.name)}${c.is_mine ? ' (You)' : ''}</h4>
            <p>${formatDate(c.created_at)}</p>
          </div>
          <span class="tx-amount" style="${c.status !== 'SUCCESS' && c.status !== 'completed' ? 'color:var(--text-muted)' : ''}">${sign}${formatKES(c.amount)}</span>
          <div class="tx-meta-row">
            <span class="tx-ref">${c.mpesa_ref ? 'M-Pesa: ' + c.mpesa_ref : 'Awaiting confirmation'}</span>
            <span class="tx-status ${statusClass}${c.status === 'REJECTED' ? ' rejected' : ''}">${statusLabel}</span>
          </div>
          ${(c.status === 'PENDING' || c.status === 'pending') && state.canConfirmContrib ? '<div class="tx-actions"><button class="confirm-btn" data-confirm-contrib="'+c.id+'">Confirm</button><button class="reject-btn" data-reject-contrib="'+c.id+'">Reject</button></div>' : ''}
        </div>`;
      }).join('') || '<div class="empty-state small"><div class="empty-icon">💰</div><p>No contributions yet</p></div>';

      const list = $('#contrib-list');
      const hist = $('#history-list');
      if (list) list.innerHTML = html;
      if (hist) hist.innerHTML = html;

      // Loan
      const loan = loans.my_loan;
      if (loan) {
        const total = loan.principal + loan.interest;
        const pct = total ? Math.round((loan.amount_repaid / total) * 100) : 0;
        const rem = total - loan.amount_repaid;
        const amtEl = $('.loan-amount');
        if (amtEl) amtEl.textContent = formatKES(rem);
        const ring = $('.ring-fill');
        if (ring) {
          const circ = 2 * Math.PI * 42;
          ring.style.strokeDasharray = circ;
          ring.style.strokeDashoffset = circ * (1 - pct / 100);
        }
        const pctEl = $('.ring-pct');
        if (pctEl) pctEl.textContent = pct + '%';
        const rows = $$('.ld-row span:last-child');
        if (rows[0]) rows[0].textContent = formatKES(loan.principal);
        if (rows[1]) rows[1].textContent = formatKES(loan.interest);
        if (rows[2]) rows[2].textContent = formatKES(loan.amount_repaid);
        if (rows[3]) rows[3].textContent = formatKES(rem);
        if (rows[4]) rows[4].textContent = loan.next_payment || '—';
      } else {
        const amtEl = $('.loan-amount');
        if (amtEl) amtEl.textContent = formatKES(0);
        const pctEl = $('.ring-pct');
        if (pctEl) pctEl.textContent = '0%';
      }
    } catch (e) {
      toast(e.message);
    }
  }

  function renderContributeSummary() {
    const amt = state.contribAmount || 2000;
    let box = $('#payment-summary-box');
    if (!box) {
      const flow = $('.contrib-flow');
      if (!flow) return;
      box = document.createElement('div');
      box.id = 'payment-summary-box';
      box.className = 'payment-summary';
      const btn = $('#btn-record-contrib');
      if (btn) flow.insertBefore(box, btn);
      else flow.appendChild(box);
    }
    const phone = state.user ? state.user.phone : '—';
    box.innerHTML = `
      <div class="ps-row"><span>Amount</span><span id="ps-amount">${formatKES(amt)}</span></div>
      <div class="ps-row"><span>Pay to</span><span>Chama wallet</span></div>
      <div class="ps-row"><span>Via</span><span>M-Pesa (${esc(phone)})</span></div>
      <div class="ps-row total"><span>You pay</span><span id="ps-total">${formatKES(amt)}</span></div>
    `;
  }

  async function loadMessages() {
    try {
      const data = await api('/api/messages');
      const box = $('#chat-messages');
      if (!box) return;
      box.innerHTML = data.messages.map(m => {
        const me = m.user_id === state.user.id;
        return `<div class="msg ${me ? 'me' : 'them'}">${me ? '' : '<div class="msg-meta">' + esc(m.name) + '</div>'}${esc(m.body)}</div>`;
      }).join('');
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      toast(e.message);
    }
  }

  async function loadMeetings() {
    try {
      const data = await api('/api/meetings');
      const upcoming = data.meetings.filter(m => new Date(m.meeting_at) >= new Date());
      const card = $('.meeting-card.large');
      if (card && upcoming[0]) {
        const m = upcoming[0];
        const d = new Date(m.meeting_at);
        const calDay = card.querySelector('.cal-day');
        const calMonth = card.querySelector('.cal-month');
        if (calDay) calDay.textContent = String(d.getDate()).padStart(2, '0');
        if (calMonth) calMonth.textContent = d.toLocaleDateString('en-KE', { month: 'short' }).toUpperCase();
        const h4 = card.querySelector('h4');
        if (h4) h4.textContent = m.title;
        card.dataset.meetingId = m.id;
      }
    } catch (e) {
      toast(e.message);
    }
  }

  async function loadSubscription() {
    try {
      const data = await api('/api/subscription');
      const plan = $('.sub-plan');
      if (plan) plan.textContent = data.plan;
      const members = $('.sub-members');
      if (members) members.textContent = data.max_members + ' MEMBERS';
      const price = $('.sub-price');
      if (price) price.textContent = formatKES(data.price) + ' / MONTH';
      const status = $('.sub-status');
      if (status) {
        status.innerHTML = data.status === 'ACTIVE'
          ? '<span class="dot active"></span> ACTIVE'
          : '<span class="dot" style="background:#DC2626"></span> EXPIRED';
      }
      const next = $('.sub-next');
      if (next) next.textContent = data.next_payment ? 'Next payment: ' + data.next_payment : '';
    } catch (e) {
      toast(e.message);
    }
  }

  async function loadOwner() {
    try {
      const data = await api('/api/owner/stats');
      const vals = $$('.om-value');
      if (vals[0]) vals[0].textContent = data.active_chamas.toLocaleString();
      if (vals[1]) vals[1].textContent = data.active_users.toLocaleString();
      if (vals[2]) vals[2].textContent = formatKES(data.monthly_revenue);
      if (vals[3]) vals[3].textContent = data.expired.toLocaleString();
    } catch (e) {
      toast(e.message);
    }
  }

  function renderProfile() {
    if (!state.user) return;
    const av = $('.profile-avatar');
    if (av) {
      av.textContent = initials(state.user.name);
      av.style.background = state.user.avatar_color || '#0D5C45';
    }
    const h2 = $('.profile-header h2');
    if (h2) h2.textContent = state.user.name;
    const role = $('.profile-header .role');
    if (role) {
      role.textContent = (state.chama ? state.chama.member_role || 'Member' : 'Member') +
        (state.chama ? ' · ' + state.chama.chama_name : '');
    }
    if (state.dashboard) {
      const ps = $$('.ps-v');
      if (ps[0]) ps[0].textContent = formatKES(state.dashboard.my_contributions || 0);
      if (ps[1] && state.dashboard.my_loan) {
        const l = state.dashboard.my_loan;
        ps[1].textContent = formatKES(l.principal + l.interest - l.amount_repaid);
      } else if (ps[1]) ps[1].textContent = formatKES(0);
    }
  }

  // ---------- AUTH ----------
  async function login(phone, pin) {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ phone, pin }),
    });
    state.token = data.token;
    state.user = data.user;
    state.chama = data.chama;
    localStorage.setItem('ch_token', data.token);
    showView('app');
    if (!data.chama) {
      toast('No chama yet — create one or join with a code');
      showPage('profile');
    } else {
      showPage('home');
      toast('Welcome, ' + data.user.name.split(' ')[0] + '!');
    }
  }

  function logout() {
    state.token = null;
    state.user = null;
    state.chama = null;
    state.dashboard = null;
    localStorage.removeItem('ch_token');
    showView('login');
    toast('Logged out');
  }

  async function tryRestore() {
    if (!state.token) return false;
    try {
      const data = await api('/api/me');
      state.user = data.user;
      state.chama = data.chama;
      return true;
    } catch {
      localStorage.removeItem('ch_token');
      state.token = null;
      return false;
    }
  }

  // ---------- PAYMENT ----------
  async function loadPaymentMethods() {
    try {
      const data = await api('/api/payment-methods');
      state.paymentMethods = data.methods || [];
      const box = document.getElementById('payment-methods-list');
      if (!box) return;
      if (!state.paymentMethods.length) {
        box.innerHTML = '<p class="muted" style="padding:8px 0">No payment methods yet. Ask your Treasurer to add how members should pay (M-Pesa number, till, bank…).</p>';
        return;
      }
      if (state.selectedMethodId == null) {
        const def = state.paymentMethods.find(m => m.is_default) || state.paymentMethods[0];
        state.selectedMethodId = def.id;
      }
      box.innerHTML = state.paymentMethods.map(m => {
        const icon = m.type.includes('MPESA') ? 'M' : m.type === 'BANK' ? 'B' : m.type === 'CASH' ? '₵' : 'P';
        return `<button type="button" class="pay-method ${m.id === state.selectedMethodId ? 'active' : ''}" data-method-id="${m.id}">
          <div class="pm-icon">${icon}</div>
          <div class="pm-body">
            <div class="pm-label">${esc(m.label)}</div>
            <div class="pm-details">${esc(m.details)}</div>
            ${m.instructions ? '<div class="pm-hint">' + esc(m.instructions) + '</div>' : ''}
          </div>
        </button>`;
      }).join('');
    } catch (e) {
      toast(e.message);
    }
  }

  async function recordContribution() {
    if (state.contribAmount < 1) {
      toast('Enter amount');
      return;
    }
    if (!state.paymentMethods.length) {
      toast('No payment method set. Ask your Treasurer to add one first.');
      return;
    }
    if (state.selectedMethodId == null) {
      toast('Select how you paid');
      return;
    }
    showPage('payment');
    const status = document.getElementById('pay-status');
    if (status) status.textContent = 'Saving to the chama ledger…';
    try {
      const ref = document.getElementById('contrib-ref')?.value.trim() || '';
      const result = await api('/api/contributions/record', {
        method: 'POST',
        body: JSON.stringify({
          amount: state.contribAmount,
          payment_method_id: state.selectedMethodId,
          reference: ref,
        }),
      });
      const amountEl = document.getElementById('success-amount');
      if (amountEl) amountEl.textContent = formatKES(state.contribAmount);
      const rec = document.getElementById('success-receipt');
      if (rec) {
        const c = result.contribution;
        rec.textContent = c.status === 'SUCCESS'
          ? (c.mpesa_ref ? 'Ref: ' + c.mpesa_ref : 'Confirmed on ledger')
          : 'Status: Pending confirmation';
      }
      const details = document.getElementById('success-details');
      if (details) {
        const c = result.contribution;
        details.innerHTML = `
          <div class="sd-row"><span>Amount</span><span>${formatKES(c.amount)}</span></div>
          <div class="sd-row"><span>Method</span><span>${esc(c.payment_method_label || c.method)}</span></div>
          <div class="sd-row"><span>Reference</span><span>${esc(c.mpesa_ref || '—')}</span></div>
          <div class="sd-row"><span>Status</span><span style="color:var(--emerald)">${c.status === 'SUCCESS' ? 'Confirmed' : 'Pending Treasurer'}</span></div>
        `;
      }
      showPage('success');
      toast(result.message || 'Recorded');
    } catch (e) {
      toast(e.message);
      showPage('contribute');
    }
  }

  function setOnboardStep(step) {
    state.onboardStep = step;
    $$('.onboard-slide').forEach(s => s.classList.toggle('active', +s.dataset.step === step));
    $$('.onboard-dot').forEach(d => d.classList.toggle('active', +d.dataset.step === step));
    const btn = $('#btn-next-onboard');
    if (btn) btn.textContent = step === 3 ? 'Get Started' : 'Next';
  }

  // ---------- INIT ----------
  async function init() {
    applyTheme();
    applyPerf();
    applyMotion();

    const restored = await tryRestore();
    setTimeout(() => {
      if (restored) {
        showView('app');
        showPage(state.chama ? 'home' : 'profile');
      } else if (localStorage.getItem('ch-onboarded')) {
        showView('login');
      } else {
        showView('onboarding');
        setOnboardStep(0);
      }
    }, 1200);

    // Onboarding
    $('#btn-next-onboard')?.addEventListener('click', () => {
      if (state.onboardStep < 3) setOnboardStep(state.onboardStep + 1);
      else {
        localStorage.setItem('ch-onboarded', '1');
        showView('login');
      }
    });
    $('#btn-skip-onboard')?.addEventListener('click', () => {
      localStorage.setItem('ch-onboarded', '1');
      showView('login');
    });

    // Login
    $('#login-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const phone = $('#phone').value.trim();
      const pin = $('#pin').value.trim();
      if (!phone || pin.length < 4) {
        toast('Enter phone and PIN');
        return;
      }
      try {
        await login(phone, pin);
      } catch (err) {
        toast(err.message);
      }
    });

    // Create chama
    $('#btn-create-chama')?.addEventListener('click', async () => {
      const phone = $('#phone')?.value.trim() || prompt('Your phone (07XX…):');
      const name = prompt('Your full name:');
      const pin = prompt('Choose a 4-digit PIN:');
      const chamaName = prompt('Name of your chama:');
      if (!phone || !name || !pin || !chamaName) return;
      try {
        // register if needed
        let token = state.token;
        if (!token) {
          try {
            const reg = await api('/api/auth/register', {
              method: 'POST',
              body: JSON.stringify({ phone, pin, name }),
            });
            state.token = reg.token;
            state.user = reg.user;
            localStorage.setItem('ch_token', reg.token);
          } catch (regErr) {
            // maybe already registered — login
            await login(phone, pin);
          }
        }
        const created = await api('/api/chamas', {
          method: 'POST',
          body: JSON.stringify({ name: chamaName, contribution_amount: 2000 }),
        });
        state.chama = {
          chama_id: created.chama.id,
          chama_name: created.chama.name,
          member_role: 'chair',
          subscription_status: created.chama.subscription_status,
          max_members: created.chama.max_members,
          contribution_amount: created.chama.contribution_amount,
          invite_code: created.invite_code,
        };
        showView('app');
        showPage('home');
        toast('Chama created! Invite code: ' + (created.invite_code || ''));
      } catch (err) {
        toast(err.message);
      }
    });

    // Nav
    $$('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.page) showPage(btn.dataset.page);
      });
    });
    $$('.metric-card').forEach(card => {
      card.addEventListener('click', () => {
        if (card.dataset.page) showPage(card.dataset.page);
      });
    });
    $$('.qa-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = btn.dataset.action;
        if (a === 'contribute') showPage('contribute');
        else if (a === 'loan') {
          showPage('money');
          $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'loans'));
          $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-loans'));
        } else if (a === 'meeting') showPage('meetings');
        else if (a === 'chat') showPage('messages');
      });
    });
    $$('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab.dataset.tab));
        $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab.dataset.tab));
      });
    });

    // Contribute
    $('#btn-make-contrib')?.addEventListener('click', () => showPage('contribute'));
    $$('.amount-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.amount-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.contribAmount = +btn.dataset.amount;
        const inp = $('#contrib-amount');
        if (inp) inp.value = state.contribAmount;
        renderContributeSummary();
      });
    });
    $('#contrib-amount')?.addEventListener('input', e => {
      state.contribAmount = +e.target.value || 0;
      renderContributeSummary();
    });
    $('#btn-record-contrib')?.addEventListener('click', () => {
      if (state.contribAmount < 100) {
        toast('Minimum is KES 100');
        return;
      }
      recordContribution();
    });

    // Apply loan
    $('#btn-apply-loan')?.addEventListener('click', async () => {
      const amount = prompt('Loan amount (KES):', '10000');
      if (!amount) return;
      try {
        const r = await api('/api/loans/apply', {
          method: 'POST',
          body: JSON.stringify({ amount: parseInt(amount, 10) }),
        });
        toast(r.message || 'Loan approved');
        loadMoney();
      } catch (e) {
        toast(e.message);
      }
    });

    // Add member
    $('#btn-invite')?.addEventListener('click', () => {
      if (!state.canManage) {
        toast('Only Chair, Treasurer or Secretary can add members');
        return;
      }
      openModal('modal-add-member');
      // refresh code
      api('/api/members').then(d => {
        const el = $('#invite-code-display');
        if (el) el.textContent = d.invite_code || '—';
      }).catch(() => {});
    });

    $('#btn-confirm-add')?.addEventListener('click', async () => {
      const name = $('#add-name')?.value.trim();
      const phone = $('#add-phone')?.value.trim();
      const role = $('#add-role')?.value || 'member';
      if (!name || !phone) {
        toast('Name and phone are required');
        return;
      }
      try {
        const r = await api('/api/members/add', {
          method: 'POST',
          body: JSON.stringify({ name, phone, role }),
        });
        toast(r.message || 'Member added');
        closeModals();
        $('#add-name').value = '';
        $('#add-phone').value = '';
        loadMembers();
        loadDashboard();
      } catch (e) {
        toast(e.message);
      }
    });

    $('#btn-copy-code')?.addEventListener('click', () => {
      const code = $('#invite-code-display')?.textContent;
      if (code && code !== '—') {
        navigator.clipboard?.writeText(code).then(() => toast('Code copied: ' + code)).catch(() => toast(code));
      }
    });

    // Join chama
    $('#btn-confirm-join')?.addEventListener('click', async () => {
      const code = $('#join-code')?.value.trim();
      if (!code) {
        toast('Enter invite code');
        return;
      }
      try {
        const r = await api('/api/chamas/join', {
          method: 'POST',
          body: JSON.stringify({ invite_code: code }),
        });
        state.chama = r.chama;
        closeModals();
        showPage('home');
        toast(r.message || 'Joined!');
      } catch (e) {
        toast(e.message);
      }
    });

    // Remove member
    document.addEventListener('click', async e => {
      const rm = e.target.closest('[data-remove-member]');
      if (rm) {
        const id = rm.dataset.removeMember;
        if (!confirm('Remove this member from the chama?')) return;
        try {
          await api('/api/members/remove', {
            method: 'POST',
            body: JSON.stringify({ user_id: parseInt(id, 10) }),
          });
          toast('Member removed');
          loadMembers();
        } catch (err) {
          toast(err.message);
        }
      }
    });

    // Global
    document.addEventListener('click', async e => {
      if (e.target.closest('[data-close-modal]')) closeModals();
      const pageBtn = e.target.closest('[data-page]');
      if (pageBtn && pageBtn.dataset.page) {
        e.preventDefault();
        showPage(pageBtn.dataset.page);
      }
      const action = e.target.closest('[data-action]');
      if (action) {
        const a = action.dataset.action;
        if (a === 'meeting') showPage('meetings');
        if (a === 'subscription') showPage('subscription');
        if (a === 'owner') showPage('owner');
        if (a === 'performance') {
          state.perfMode = !state.perfMode;
          applyPerf();
          toast(state.perfMode ? 'Performance Mode on' : 'Performance Mode off');
        }
        if (a === 'reduced-motion') {
          state.reducedMotion = !state.reducedMotion;
          applyMotion();
          toast(state.reducedMotion ? 'Reduced Motion on' : 'Reduced Motion off');
        }
        if (a === 'theme-settings') {
          state.theme = state.theme === 'dark' ? 'light' : 'dark';
          applyTheme();
          toast(state.theme === 'dark' ? 'Dark mode' : 'Light mode');
        }
      }
      if (e.target.textContent === 'MARK ATTENDANCE') {
        const id = $('.meeting-card.large')?.dataset.meetingId;
        if (!id) return toast('No meeting');
        try {
          await api('/api/meetings/' + id + '/attendance', { method: 'POST' });
          toast('Attendance marked');
        } catch (err) {
          toast(err.message);
        }
      }
      if (e.target.textContent === 'RENEW FOR KES 500' || e.target.textContent === 'RENEW SUBSCRIPTION') {
        try {
          await api('/api/subscription/renew', { method: 'POST' });
          toast('Subscription renewed');
          showPage('subscription');
          loadSubscription();
        } catch (err) {
          toast(err.message);
        }
      }
    });

    $('#btn-theme')?.addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
    });

    async function sendChat() {
      const input = $('#chat-input');
      const text = input?.value.trim();
      if (!text) return;
      try {
        await api('/api/messages', { method: 'POST', body: JSON.stringify({ body: text }) });
        input.value = '';
        loadMessages();
      } catch (e) {
        toast(e.message);
      }
    }
    $('#btn-send')?.addEventListener('click', sendChat);
    $('#chat-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') sendChat();
    });

    $('#btn-exit-owner')?.addEventListener('click', () => showPage('profile'));
    $('#btn-owner-mode')?.addEventListener('click', () => showPage('owner'));
    $('#btn-sim-expire')?.addEventListener('click', async () => {
      try {
        await api('/api/subscription/expire', { method: 'POST' });
        showPage('expired');
      } catch (e) {
        toast(e.message);
      }
    });
    $('#btn-restore-sub')?.addEventListener('click', async () => {
      try {
        await api('/api/subscription/renew', { method: 'POST' });
        showPage('subscription');
        toast('Subscription restored');
      } catch (e) {
        toast(e.message);
      }
    });
    $('#btn-logout')?.addEventListener('click', logout);
    $('#btn-notifications')?.addEventListener('click', () => toast('You\'re up to date'));
    $$('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
