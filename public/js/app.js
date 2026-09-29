(function () {
  'use strict';

  const state = {
    token: localStorage.getItem('ch_token') || null,
    user: null,
    chama: null,
    canManage: false,
    canConfirm: false,
    contribAmount: 2000,
    selectedMethodId: null,
    paymentMethods: [],
    theme: localStorage.getItem('ch-theme') || 'light',
  };

  const $ = (s, c) => (c || document).querySelector(s);
  const $$ = (s, c) => Array.from((c || document).querySelectorAll(s));

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function formatKES(n) {
    return 'KES ' + Number(n || 0).toLocaleString('en-KE');
  }
  function initials(n) {
    return (n || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  }
  function toast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3200);
  }

  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || res.statusText);
    return data;
  }

  function showView(id) {
    $$('.view').forEach(v => v.classList.remove('active'));
    const el = $('#view-' + id);
    if (el) el.classList.add('active');
  }

  function showPage(page) {
    $$('.page').forEach(p => p.classList.remove('active'));
    const el = $('#page-' + page);
    if (el) el.classList.add('active');

    $$('.nav-item').forEach(n => {
      n.classList.toggle('active', n.getAttribute('data-go') === page);
    });

    const titles = {
      home: 'Home', contribute: 'Contribute', money: 'Money',
      chama: 'Chama', messages: 'Messages', profile: 'Profile',
      success: 'Done', suspended: 'Suspended',
    };
    const ht = $('#header-title');
    if (ht) ht.textContent = titles[page] || 'ChamaHub';

    const app = $('#view-app');
    if (app) app.classList.toggle('hide-nav', page === 'success' || page === 'suspended');

    if (page === 'home') loadDashboard();
    if (page === 'contribute') loadPaymentMethods();
    if (page === 'money') loadMoney();
    if (page === 'chama') loadChama();
    if (page === 'messages') loadMessages();
    if (page === 'profile') renderProfile();
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme === 'dark' ? 'dark' : 'light');
    localStorage.setItem('ch-theme', state.theme);
  }

  // ---------- DATA ----------
  async function loadDashboard() {
    try {
      const data = await api('/api/dashboard');
      state.canManage = !!data.can_manage;
      state.canConfirm = !!data.can_confirm;
      state.chama = {
        chama_id: data.chama.id,
        chama_name: data.chama.name,
        member_role: data.member_role,
        invite_code: data.chama.invite_code,
        contribution_amount: data.chama.contribution_amount,
      };

      const cn = $('#chama-name');
      if (cn) cn.textContent = data.chama.name;
      const bal = $('#balance-amount');
      if (bal) bal.textContent = formatKES(data.total_savings);
      const sm = $('#stat-month');
      if (sm) sm.textContent = formatKES(data.month_contributions);
      const sl = $('#stat-loans');
      if (sl) sl.textContent = formatKES(data.outstanding_loans);
      const smem = $('#stat-members');
      if (smem) smem.textContent = data.member_count + '/' + data.chama.max_members;

      const recent = $('#home-recent');
      if (recent) {
        if (!data.recent_contributions.length) {
          recent.innerHTML = '<p class="muted">No contributions yet. Tap Record contribution above.</p>';
        } else {
          recent.innerHTML = data.recent_contributions.map(txRow).join('');
        }
      }
    } catch (e) {
      if (e.message && /SUSPENDED|EXPIRED|CANCELLED/i.test(e.message)) {
        const m = $('#suspend-msg');
        if (m) m.textContent = e.message;
        showPage('suspended');
        return;
      }
      toast(e.message);
      if (/log in|Unauthorized/i.test(e.message)) logout();
    }
  }

  function txRow(c) {
    const status = c.status === 'SUCCESS' ? 'ok' : c.status === 'REJECTED' ? 'rejected' : 'pending';
    const label = c.status === 'SUCCESS' ? 'Confirmed' : c.status === 'REJECTED' ? 'Rejected' : 'Pending';
    const actions = (c.status === 'PENDING' && state.canConfirm)
      ? '<div class="tx-actions"><button type="button" class="ok" data-confirm="' + c.id + '">Confirm</button><button type="button" class="no" data-reject="' + c.id + '">Reject</button></div>'
      : '';
    return (
      '<div class="tx-item">' +
      '<div class="tx-icon">' + (c.status === 'SUCCESS' ? '↑' : '…') + '</div>' +
      '<div><h4>' + esc(c.name || 'Member') + (c.is_mine ? ' (You)' : '') + '</h4>' +
      '<p>' + esc(c.payment_method_label || c.method || '') +
      (c.mpesa_ref ? ' · ' + esc(c.mpesa_ref) : '') + '</p>' +
      '<span class="tx-badge ' + status + '">' + label + '</span></div>' +
      '<div class="tx-amt">' + formatKES(c.amount) + '</div>' +
      actions +
      '</div>'
    );
  }

  async function loadPaymentMethods() {
    const box = $('#payment-methods-list');
    if (!box) return;
    box.innerHTML = '<p class="muted">Loading payment methods…</p>';
    try {
      const data = await api('/api/payment-methods');
      state.paymentMethods = data.methods || [];
      if (!state.paymentMethods.length) {
        box.innerHTML =
          '<div class="notice-box"><strong>No payment methods yet</strong><br/>' +
          'Ask Chair or Treasurer to open the <b>Chama</b> tab and tap <b>+ Add payment method</b>.</div>';
        state.selectedMethodId = null;
        return;
      }
      if (state.selectedMethodId == null || !state.paymentMethods.some(m => m.id === state.selectedMethodId)) {
        const def = state.paymentMethods.find(m => m.is_default) || state.paymentMethods[0];
        state.selectedMethodId = def.id;
      }
      box.innerHTML = state.paymentMethods.map(function (m) {
        const icon = (m.type || '').indexOf('MPESA') >= 0 ? 'M' : m.type === 'BANK' ? 'B' : m.type === 'CASH' ? '₵' : 'P';
        const active = m.id === state.selectedMethodId ? ' active' : '';
        return (
          '<button type="button" class="pay-method' + active + '" data-method-id="' + m.id + '">' +
          '<div class="pm-icon">' + icon + '</div>' +
          '<div><div class="pm-label">' + esc(m.label) + '</div>' +
          '<div class="pm-details">' + esc(m.details) + '</div>' +
          (m.instructions ? '<div class="pm-hint">' + esc(m.instructions) + '</div>' : '') +
          '</div></button>'
        );
      }).join('');
    } catch (e) {
      box.innerHTML = '<div class="notice-box danger"><strong>Could not load methods</strong><br/>' + esc(e.message) + '</div>';
    }
  }

  async function recordContribution() {
    if (!state.contribAmount || state.contribAmount < 1) {
      toast('Enter an amount');
      return;
    }
    if (!state.paymentMethods.length || state.selectedMethodId == null) {
      toast('Select a payment method first');
      return;
    }
    const btn = $('#btn-record-contrib');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const ref = ($('#contrib-ref') && $('#contrib-ref').value.trim()) || '';
      const result = await api('/api/contributions/record', {
        method: 'POST',
        body: JSON.stringify({
          amount: state.contribAmount,
          payment_method_id: state.selectedMethodId,
          reference: ref,
        }),
      });
      const c = result.contribution;
      const amt = $('#success-amount');
      if (amt) amt.textContent = formatKES(c.amount);
      const msg = $('#success-msg');
      if (msg) msg.textContent = result.message || 'Saved to ledger';
      const det = $('#success-details');
      if (det) {
        det.innerHTML =
          '<div class="row"><span>Amount</span><span>' + formatKES(c.amount) + '</span></div>' +
          '<div class="row"><span>Method</span><span>' + esc(c.payment_method_label || c.method) + '</span></div>' +
          '<div class="row"><span>Reference</span><span>' + esc(c.mpesa_ref || '—') + '</span></div>' +
          '<div class="row"><span>Status</span><span>' + (c.status === 'SUCCESS' ? 'Confirmed' : 'Pending Treasurer') + '</span></div>';
      }
      showPage('success');
      toast(result.message || 'Recorded');
    } catch (e) {
      toast(e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'I have paid — record it'; }
    }
  }

  async function loadMoney() {
    try {
      const data = await api('/api/contributions');
      state.canConfirm = !!data.can_confirm;
      const sum = $('#money-summary');
      if (sum) {
        sum.innerHTML =
          '<div><strong>' + formatKES(data.total) + '</strong><span>All time</span></div>' +
          '<div><strong>' + formatKES(data.mine) + '</strong><span>Mine</span></div>' +
          '<div><strong>' + data.pending_count + '</strong><span>Pending</span></div>';
      }
      const list = $('#contrib-list');
      if (list) {
        list.innerHTML = data.contributions.length
          ? data.contributions.map(txRow).join('')
          : '<p class="muted">No contributions yet.</p>';
      }
    } catch (e) {
      toast(e.message);
    }
  }

  async function loadChama() {
    try {
      const data = await api('/api/members');
      state.canManage = !!data.can_manage;
      const label = $('#member-count-label');
      if (label) label.textContent = 'Members ' + data.member_count + ' / ' + data.max_members;
      const list = $('#member-list');
      if (list) {
        list.innerHTML = data.members.map(function (m) {
          return (
            '<div class="member-card">' +
            '<div class="member-avatar" style="background:' + esc(m.avatar_color || '#0D5C45') + '">' + initials(m.name) + '</div>' +
            '<div><h4>' + esc(m.name) + '</h4><p>' + esc(m.phone) + ' · ' + formatKES(m.total_contributed) + '</p></div>' +
            '<span class="member-role">' + esc(m.role) + '</span></div>'
          );
        }).join('');
      }
      const invite = $('#invite-code-line');
      if (invite) invite.textContent = 'Invite code: ' + (data.invite_code || '—');
      const addMem = $('#btn-add-member');
      if (addMem) addMem.style.display = data.can_manage ? 'block' : 'none';

      const methods = await api('/api/payment-methods');
      const olist = $('#official-methods-list');
      if (olist) {
        if (!methods.methods.length) {
          olist.innerHTML = '<p class="muted small">None yet. Add M-Pesa, till, bank or cash.</p>';
        } else {
          olist.innerHTML = methods.methods.map(function (m) {
            return (
              '<div class="member-card" style="margin-bottom:8px">' +
              '<div><h4>' + esc(m.label) + '</h4><p>' + esc(m.details) + '</p></div>' +
              (data.can_manage
                ? '<button type="button" class="btn-ghost" style="width:auto;padding:6px 10px;font-size:12px" data-del-method="' + m.id + '">Remove</button>'
                : '') +
              '</div>'
            );
          }).join('');
        }
      }
      const addPm = $('#btn-add-pay-method');
      if (addPm) addPm.style.display = data.can_manage ? 'block' : 'none';
    } catch (e) {
      toast(e.message);
    }
  }

  async function loadMessages() {
    try {
      const data = await api('/api/messages');
      const box = $('#chat-messages');
      if (!box) return;
      box.innerHTML = data.messages.map(function (m) {
        const me = m.user_id === state.user.id;
        return '<div class="msg ' + (me ? 'me' : 'them') + '">' +
          (me ? '' : '<div class="msg-meta">' + esc(m.name) + '</div>') +
          esc(m.body) + '</div>';
      }).join('');
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      toast(e.message);
    }
  }

  function renderProfile() {
    if (!state.user) return;
    const av = $('#profile-avatar');
    if (av) {
      av.textContent = initials(state.user.name);
      av.style.background = state.user.avatar_color || '#0D5C45';
    }
    const n = $('#profile-name');
    if (n) n.textContent = state.user.name;
    const r = $('#profile-role');
    if (r) r.textContent = (state.chama ? state.chama.member_role + ' · ' + state.chama.chama_name : 'Member');
    api('/api/dashboard').then(function (d) {
      const pc = $('#profile-contrib');
      if (pc) pc.textContent = formatKES(d.my_contributions);
      const ps = $('#profile-sub');
      if (ps && d.subscription) ps.textContent = d.subscription.status + ' until ' + (d.subscription.current_period_end || '—');
    }).catch(function () {});
  }

  // ---------- AUTH ----------
  async function login(phone, pin) {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ phone: phone, pin: pin }),
    });
    state.token = data.token;
    state.user = data.user;
    state.chama = data.chama;
    localStorage.setItem('ch_token', data.token);
    const g = $('#header-greet');
    if (g) g.textContent = 'Hi, ' + data.user.name.split(' ')[0];
    showView('app');
    if (data.access && data.access.allowed === false) {
      const m = $('#suspend-msg');
      if (m) m.textContent = data.access.message || 'Suspended';
      showPage('suspended');
    } else {
      showPage('home');
      toast('Welcome, ' + data.user.name.split(' ')[0]);
    }
  }

  function logout() {
    state.token = null;
    state.user = null;
    state.chama = null;
    localStorage.removeItem('ch_token');
    showView('login');
  }

  async function tryRestore() {
    if (!state.token) return false;
    try {
      const data = await api('/api/auth/me');
      state.user = data.user;
      state.chama = data.chama;
      const g = $('#header-greet');
      if (g) g.textContent = 'Hi, ' + data.user.name.split(' ')[0];
      return true;
    } catch (e) {
      localStorage.removeItem('ch_token');
      state.token = null;
      return false;
    }
  }

  // ---------- EVENTS ----------
  function bind() {
    $('#login-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      try {
        await login($('#phone').value.trim(), $('#pin').value);
      } catch (err) {
        toast(err.message);
      }
    });

    $('#btn-theme').addEventListener('click', function () {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
    });

    $('#btn-logout').addEventListener('click', logout);
    $('#btn-logout-2').addEventListener('click', logout);

    // Navigation via data-go
    document.addEventListener('click', function (e) {
      const go = e.target.closest('[data-go]');
      if (go) {
        e.preventDefault();
        showPage(go.getAttribute('data-go'));
        return;
      }

      const methodBtn = e.target.closest('[data-method-id]');
      if (methodBtn) {
        state.selectedMethodId = parseInt(methodBtn.getAttribute('data-method-id'), 10);
        loadPaymentMethods();
        return;
      }

      const chip = e.target.closest('.amount-chip');
      if (chip) {
        $$('.amount-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.contribAmount = parseInt(chip.getAttribute('data-amount'), 10);
        const inp = $('#contrib-amount');
        if (inp) inp.value = state.contribAmount;
        return;
      }

      if (e.target.closest('#btn-record-contrib')) {
        e.preventDefault();
        recordContribution();
        return;
      }
      if (e.target.closest('#btn-go-contribute') || e.target.closest('#btn-money-contribute')) {
        e.preventDefault();
        showPage('contribute');
        return;
      }

      const conf = e.target.closest('[data-confirm]');
      if (conf) {
        api('/api/contributions/confirm', {
          method: 'POST',
          body: JSON.stringify({ contribution_id: parseInt(conf.getAttribute('data-confirm'), 10) }),
        }).then(function () {
          toast('Confirmed');
          loadMoney();
          loadDashboard();
        }).catch(function (err) { toast(err.message); });
        return;
      }
      const rej = e.target.closest('[data-reject]');
      if (rej) {
        api('/api/contributions/reject', {
          method: 'POST',
          body: JSON.stringify({ contribution_id: parseInt(rej.getAttribute('data-reject'), 10) }),
        }).then(function () {
          toast('Rejected');
          loadMoney();
        }).catch(function (err) { toast(err.message); });
        return;
      }

      if (e.target.closest('[data-close]')) {
        $('#modal-member').classList.add('hidden');
      }

      const delm = e.target.closest('[data-del-method]');
      if (delm) {
        if (!confirm('Remove this payment method?')) return;
        api('/api/payment-methods/' + delm.getAttribute('data-del-method'), { method: 'DELETE' })
          .then(function () { toast('Removed'); loadChama(); })
          .catch(function (err) { toast(err.message); });
      }
    });

    $('#contrib-amount').addEventListener('input', function (e) {
      state.contribAmount = parseInt(e.target.value, 10) || 0;
    });

    $('#btn-add-member').addEventListener('click', function () {
      if (!state.canManage) {
        toast('Only Chair, Treasurer or Secretary can add members');
        return;
      }
      $('#modal-member').classList.remove('hidden');
    });

    $('#btn-confirm-add').addEventListener('click', async function () {
      try {
        const r = await api('/api/members/add', {
          method: 'POST',
          body: JSON.stringify({
            name: $('#add-name').value.trim(),
            phone: $('#add-phone').value.trim(),
            role: $('#add-role').value,
          }),
        });
        toast(r.message || 'Added');
        $('#modal-member').classList.add('hidden');
        $('#add-name').value = '';
        $('#add-phone').value = '';
        loadChama();
      } catch (e) {
        toast(e.message);
      }
    });

    $('#btn-add-pay-method').addEventListener('click', async function () {
      if (!state.canManage) {
        toast('Only officials can add payment methods');
        return;
      }
      const label = prompt('Label (e.g. M-Pesa to Jane)');
      if (!label) return;
      const details = prompt('Details (phone / till / account number)');
      if (!details) return;
      const type = prompt('Type: MPESA_PHONE, MPESA_TILL, BANK, CASH', 'MPESA_PHONE') || 'OTHER';
      const instructions = prompt('Instructions for members (optional)', '') || '';
      try {
        await api('/api/payment-methods', {
          method: 'POST',
          body: JSON.stringify({ label: label, details: details, type: type, instructions: instructions, is_default: true }),
        });
        toast('Payment method added');
        loadChama();
      } catch (e) {
        toast(e.message);
      }
    });

    $('#btn-send').addEventListener('click', async function () {
      const input = $('#chat-input');
      const text = input.value.trim();
      if (!text) return;
      try {
        await api('/api/messages', { method: 'POST', body: JSON.stringify({ body: text }) });
        input.value = '';
        loadMessages();
      } catch (e) {
        toast(e.message);
      }
    });
  }

  async function init() {
    applyTheme();
    bind();
    const ok = await tryRestore();
    setTimeout(function () {
      if (ok) {
        showView('app');
        showPage(state.chama ? 'home' : 'profile');
      } else {
        showView('login');
      }
    }, 800);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
