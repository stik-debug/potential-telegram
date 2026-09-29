const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb, save, hashPin, nextId, audit } = require('./db');
const sub = require('./subscription');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'chamahub-v4-change-in-production';
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

setInterval(() => { try { sub.processExpirations(); } catch (_) {} }, 3600e3);

function sign(p) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({ ...p, exp: Date.now() + 7 * 864e5 })).toString('base64url');
  const s = crypto.createHmac('sha256', SECRET).update(h + '.' + b).digest('base64url');
  return h + '.' + b + '.' + s;
}
function verify(t) {
  try {
    const [h, b, s] = t.split('.');
    if (crypto.createHmac('sha256', SECRET).update(h + '.' + b).digest('base64url') !== s) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp < Date.now() ? null : p;
  } catch { return null; }
}
function parseBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 2e6) resolve({}); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}
function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  });
  res.end(JSON.stringify(data));
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || null;
}
function normalizePhone(p) {
  let s = String(p || '').replace(/\s+/g, '').replace(/^\+254/, '0');
  if (s.startsWith('254') && s.length === 12) s = '0' + s.slice(3);
  return s;
}
function auth(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? verify(h.slice(7)) : null;
}
function urlPath(u) {
  try { return new URL(u, 'http://x').pathname; } catch { return '/'; }
}
function canManage(role) {
  return ['CHAMA_ADMIN', 'TREASURER', 'SECRETARY'].includes(role);
}
function canConfirm(role) {
  return ['CHAMA_ADMIN', 'TREASURER'].includes(role);
}
function getMembership(db, userId) {
  return db.members.find(m => m.user_id === userId && m.status !== 'REMOVED') || null;
}
function chamaCtx(db, userId) {
  const membership = getMembership(db, userId);
  if (!membership) return { membership: null, chama: null, access: null, subscription: null };
  const access = sub.getChamaAccess(db, membership.chama_id);
  return {
    membership,
    chama: access.chama || db.chamas.find(c => c.id === membership.chama_id),
    access,
    subscription: sub.getSubscription(db, membership.chama_id),
  };
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    });
    return res.end();
  }

  const db = getDb();
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await parseBody(req) : {};
  const ip = clientIp(req);

  // Public plans
  if (url === '/api/plans' && req.method === 'GET') {
    const plans = db.plans.filter(p => p.active).sort((a, b) => (a.sort_order || a.id) - (b.sort_order || b.id));
    return json(res, 200, { plans });
  }

  // ---- AUTH ----
  if (url === '/api/auth/login' && req.method === 'POST') {
    const phone = normalizePhone(body.phone);
    const user = db.users.find(u => u.phone === phone);
    if (!user || user.pin_hash !== hashPin(body.pin)) {
      return json(res, 401, { error: 'Invalid phone or PIN. Try 0723456789 / 1234' });
    }
    if (user.status === 'SUSPENDED') return json(res, 403, { error: 'Account suspended' });
    user.last_login = new Date().toISOString();
    audit(db, { actor_id: user.id, action: 'LOGIN', target_type: 'user', target_id: user.id, ip });
    save(db);
    const ctx = chamaCtx(db, user.id);
    return json(res, 200, {
      token: sign({ id: user.id, phone: user.phone, name: user.name, platform_role: user.platform_role }),
      user: { id: user.id, phone: user.phone, name: user.name, email: user.email, platform_role: user.platform_role, avatar_color: user.avatar_color },
      chama: ctx.membership ? {
        chama_id: ctx.chama.id,
        chama_name: ctx.chama.name,
        member_role: ctx.membership.role,
        invite_code: ctx.chama.invite_code,
        max_members: sub.memberLimit(db, ctx.chama.id),
        contribution_amount: ctx.chama.contribution_amount,
      } : null,
      access: ctx.access,
      subscription: ctx.subscription,
    });
  }

  if (url === '/api/auth/register' && req.method === 'POST') {
    const phone = normalizePhone(body.phone);
    const name = String(body.name || '').trim();
    const pin = String(body.pin || '');
    if (!phone || !name || pin.length < 4) return json(res, 400, { error: 'Phone, name and 4+ digit PIN required' });
    if (db.users.find(u => u.phone === phone)) return json(res, 409, { error: 'Phone already registered' });
    const id = nextId(db, 'users');
    const colors = ['#0D5C45', '#1A7A5C', '#C9A227', '#2E9B78', '#0A3D2E'];
    const user = {
      id, phone, pin_hash: hashPin(pin), name, email: body.email || null,
      platform_role: 'USER', status: 'ACTIVE', avatar_color: colors[id % 5],
      created_at: new Date().toISOString(), last_login: null,
    };
    db.users.push(user);
    audit(db, { actor_id: id, action: 'USER_REGISTERED', target_type: 'user', target_id: id, ip });
    save(db);
    return json(res, 201, {
      token: sign({ id, phone, name, platform_role: 'USER' }),
      user: { id, phone, name, email: null, platform_role: 'USER', avatar_color: user.avatar_color },
      chama: null, access: null, subscription: null,
    });
  }

  const me = auth(req);
  if (!me && url.startsWith('/api/')) return json(res, 401, { error: 'Please log in again' });

  if (url === '/api/me' && req.method === 'GET') {
    const user = db.users.find(u => u.id === me.id);
    if (!user) return json(res, 404, { error: 'User not found' });
    const ctx = chamaCtx(db, user.id);
    return json(res, 200, {
      user: { id: user.id, phone: user.phone, name: user.name, email: user.email, platform_role: user.platform_role, avatar_color: user.avatar_color },
      chama: ctx.membership ? {
        chama_id: ctx.chama.id, chama_name: ctx.chama.name, member_role: ctx.membership.role,
        invite_code: ctx.chama.invite_code, max_members: sub.memberLimit(db, ctx.chama.id),
        contribution_amount: ctx.chama.contribution_amount,
      } : null,
      access: ctx.access,
      subscription: ctx.subscription,
    });
  }

  // ---- OWNER ----
  function requireOwner() {
    const user = db.users.find(u => u.id === me.id);
    if (!user || user.platform_role !== 'SUPER_ADMIN') {
      json(res, 403, { error: 'SUPER_ADMIN access required' });
      return null;
    }
    return user;
  }

  if (url.startsWith('/api/owner')) {
    const owner = requireOwner();
    if (!owner) return;

    if (url === '/api/owner/stats' && req.method === 'GET') {
      const subs = db.subscriptions;
      const by = (st) => subs.filter(s => s.status === st).length;
      const payments = db.payments.filter(p => p.status === 'SUCCESS' && p.type === 'SUBSCRIPTION');
      const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
      return json(res, 200, {
        total_users: db.users.length,
        active_users: db.users.filter(u => u.status === 'ACTIVE').length,
        total_chamas: db.chamas.length,
        active_chamas: db.chamas.filter(c => c.status === 'ACTIVE').length,
        trial_chamas: by('TRIAL'),
        paid_chamas: by('ACTIVE'),
        past_due_chamas: by('PAST_DUE') + by('GRACE_PERIOD'),
        suspended_chamas: db.chamas.filter(c => c.status === 'SUSPENDED').length,
        mrr: subs.filter(s => ['ACTIVE', 'TRIAL'].includes(s.status)).reduce((s, x) => s + (x.amount || 0), 0),
        revenue_month: payments.filter(p => (p.completed_at || '') >= monthStart).reduce((s, p) => s + p.amount, 0),
        total_members: db.members.filter(m => m.status !== 'REMOVED').length,
      });
    }

    if (url === '/api/owner/chamas' && req.method === 'GET') {
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const search = (params.get('search') || '').toLowerCase();
      let list = db.chamas.map(c => {
        const subscription = sub.getSubscription(db, c.id);
        const admin = db.members.find(m => m.chama_id === c.id && m.role === 'CHAMA_ADMIN');
        const adminUser = admin && db.users.find(u => u.id === admin.user_id);
        return {
          id: c.id, name: c.name, status: c.status, suspend_reason: c.suspend_reason,
          member_count: db.members.filter(m => m.chama_id === c.id && m.status !== 'REMOVED').length,
          max_members: sub.memberLimit(db, c.id),
          admin_name: adminUser && adminUser.name, admin_phone: adminUser && adminUser.phone,
          plan: subscription && (db.plans.find(p => p.id === subscription.plan_id) || {}).name,
          subscription_status: subscription && subscription.status,
          period_end: subscription && subscription.current_period_end,
          amount: subscription && subscription.amount,
          created_at: c.created_at,
        };
      });
      if (search) list = list.filter(c =>
        (c.name || '').toLowerCase().includes(search) || String(c.id).includes(search) ||
        (c.admin_name || '').toLowerCase().includes(search) || (c.admin_phone || '').includes(search)
      );
      return json(res, 200, { chamas: list });
    }

    if (url.match(/^\/api\/owner\/chamas\/\d+\/suspend$/) && req.method === 'POST') {
      const id = parseInt(url.split('/')[4], 10);
      try {
        const chama = sub.suspendChama(db, { chamaId: id, reason: body.reason, actorId: me.id, ip });
        return json(res, 200, { chama, message: 'Chama suspended. Data kept.' });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (url.match(/^\/api\/owner\/chamas\/\d+\/reactivate$/) && req.method === 'POST') {
      const id = parseInt(url.split('/')[4], 10);
      try {
        const result = sub.reactivateChama(db, { chamaId: id, actorId: me.id, ip, extendDays: body.extend_days || 30 });
        return json(res, 200, { ...result, message: 'Chama reactivated' });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (url === '/api/owner/plans' && req.method === 'GET') {
      return json(res, 200, { plans: [...db.plans].sort((a, b) => (a.sort_order || a.id) - (b.sort_order || b.id)) });
    }

    if (url === '/api/owner/plans' && req.method === 'POST') {
      const id = nextId(db, 'plans');
      const plan = {
        id, name: String(body.name || '').trim(), price: parseInt(body.price, 10) || 500,
        currency: 'KES', billing_cycle: 'monthly', max_members: parseInt(body.max_members, 10) || 15,
        trial_days: parseInt(body.trial_days, 10) || 14, description: body.description || '',
        features: [], active: true, sort_order: id,
      };
      if (!plan.name) return json(res, 400, { error: 'Name required' });
      db.plans.push(plan);
      save(db);
      return json(res, 201, { plan });
    }

    if (url === '/api/owner/users' && req.method === 'GET') {
      return json(res, 200, {
        users: db.users.map(u => {
          const m = getMembership(db, u.id);
          const c = m && db.chamas.find(x => x.id === m.chama_id);
          return {
            id: u.id, name: u.name, phone: u.phone, platform_role: u.platform_role, status: u.status,
            chama_name: c && c.name, chama_role: m && m.role, last_login: u.last_login, created_at: u.created_at,
          };
        }),
      });
    }

    if (url === '/api/owner/audit' && req.method === 'GET') {
      const logs = [...db.audit_logs].reverse().slice(0, 100).map(a => {
        const actor = db.users.find(u => u.id === a.actor_id);
        return { ...a, actor_name: actor && actor.name };
      });
      return json(res, 200, { logs });
    }

    if (url === '/api/owner/run-expiry' && req.method === 'POST') {
      return json(res, 200, { processed: sub.processExpirations(me.id) });
    }

    return json(res, 404, { error: 'Owner route not found' });
  }

  // ---- helpers for chama routes ----
  function requireChama(write) {
    const ctx = chamaCtx(db, me.id);
    if (!ctx.membership) {
      json(res, 404, { error: 'You are not in a chama yet' });
      return null;
    }
    if (!ctx.access.allowed) {
      json(res, 403, {
        error: ctx.access.reason,
        message: ctx.access.message,
        suspend_reason: ctx.access.suspend_reason,
        amount_due: ctx.access.amount_due,
        subscription: ctx.subscription,
      });
      return null;
    }
    if (write && ctx.access.write_allowed === false) {
      json(res, 403, { error: 'PAYMENT_REQUIRED', message: 'Subscription past due. Renew to continue.', subscription: ctx.subscription });
      return null;
    }
    return ctx;
  }

  // ---- DASHBOARD ----
  if (url === '/api/dashboard' && req.method === 'GET') {
    const ctx = chamaCtx(db, me.id);
    if (!ctx.membership) return json(res, 404, { error: 'Not in a chama' });
    if (!ctx.access.allowed) {
      return json(res, 403, {
        error: ctx.access.reason, message: ctx.access.message,
        suspend_reason: ctx.access.suspend_reason, subscription: ctx.subscription,
        chama: { id: ctx.chama.id, name: ctx.chama.name },
      });
    }
    const cid = ctx.chama.id;
    const contribs = db.contributions.filter(c => c.chama_id === cid && c.status === 'SUCCESS');
    const total_savings = contribs.reduce((s, c) => s + c.amount, 0);
    const month_contributions = contribs.filter(c => (c.created_at || '').startsWith('2026-09') || new Date(c.created_at) >= new Date(new Date().getFullYear(), new Date().getMonth(), 1)).reduce((s, c) => s + c.amount, 0);
    const outstanding_loans = db.loans.filter(l => l.chama_id === cid && l.status === 'ACTIVE').reduce((s, l) => s + l.principal + (l.interest || 0) - (l.amount_repaid || 0), 0);
    const member_count = db.members.filter(m => m.chama_id === cid && m.status !== 'REMOVED').length;
    const my_loan = db.loans.find(l => l.chama_id === cid && l.user_id === me.id && l.status === 'ACTIVE') || null;
    const my_contributions = contribs.filter(c => c.user_id === me.id).reduce((s, c) => s + c.amount, 0);
    const pending_count = db.contributions.filter(c => c.chama_id === cid && c.status === 'PENDING').length;
    const recent = contribs.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 8).map(c => {
      const u = db.users.find(x => x.id === c.user_id);
      return { id: c.id, amount: c.amount, created_at: c.created_at, mpesa_ref: c.mpesa_ref, status: c.status, name: u && u.name, user_id: c.user_id };
    });
    return json(res, 200, {
      chama: {
        id: ctx.chama.id, name: ctx.chama.name,
        max_members: sub.memberLimit(db, cid),
        contribution_amount: ctx.chama.contribution_amount,
        invite_code: ctx.chama.invite_code,
      },
      subscription: ctx.subscription,
      access: ctx.access,
      total_savings, month_contributions, outstanding_loans, member_count, pending_count,
      my_loan, my_contributions, recent_contributions: recent,
      member_role: ctx.membership.role,
      can_manage: canManage(ctx.membership.role),
      can_confirm: canConfirm(ctx.membership.role),
    });
  }

  // ---- MEMBERS ----
  if (url === '/api/members' && req.method === 'GET') {
    const ctx = requireChama(false); if (!ctx) return;
    const cid = ctx.chama.id;
    const members = db.members.filter(m => m.chama_id === cid && m.status !== 'REMOVED').map(m => {
      const u = db.users.find(x => x.id === m.user_id);
      const total_contributed = db.contributions.filter(c => c.user_id === m.user_id && c.chama_id === cid && c.status === 'SUCCESS').reduce((s, c) => s + c.amount, 0);
      return {
        id: u.id, name: u.name, phone: u.phone, avatar_color: u.avatar_color,
        role: m.role, joined_at: m.joined_at, total_contributed,
      };
    });
    return json(res, 200, {
      members,
      invite_code: ctx.chama.invite_code,
      can_manage: canManage(ctx.membership.role),
      max_members: sub.memberLimit(db, cid),
      member_count: members.length,
    });
  }

  if (url === '/api/members/add' && req.method === 'POST') {
    const ctx = requireChama(true); if (!ctx) return;
    if (!canManage(ctx.membership.role)) return json(res, 403, { error: 'Only Chair, Treasurer or Secretary can add members' });
    const limit = sub.memberLimit(db, ctx.chama.id);
    const count = db.members.filter(m => m.chama_id === ctx.chama.id && m.status !== 'REMOVED').length;
    if (count >= limit) return json(res, 400, { error: 'Member limit reached (' + limit + ')' });
    const phone = normalizePhone(body.phone);
    const name = String(body.name || '').trim();
    let role = String(body.role || 'MEMBER').toUpperCase();
    if (role === 'MEMBER' || role === 'TREASURER' || role === 'SECRETARY') { /* ok */ }
    else role = 'MEMBER';
    if (!phone || !name) return json(res, 400, { error: 'Name and phone required' });
    let u = db.users.find(x => x.phone === phone);
    if (!u) {
      const id = nextId(db, 'users');
      const colors = ['#0D5C45', '#1A7A5C', '#C9A227', '#2E9B78', '#0A3D2E'];
      u = { id, phone, pin_hash: hashPin('1234'), name, email: null, platform_role: 'USER', status: 'ACTIVE', avatar_color: colors[id % 5], created_at: new Date().toISOString(), last_login: null };
      db.users.push(u);
    } else if (db.members.find(m => m.user_id === u.id && m.status !== 'REMOVED')) {
      return json(res, 409, { error: 'This phone is already in a chama' });
    }
    const mid = nextId(db, 'members');
    db.members.push({ id: mid, chama_id: ctx.chama.id, user_id: u.id, role, joined_at: new Date().toISOString(), status: 'ACTIVE' });
    audit(db, { actor_id: me.id, action: 'MEMBER_ADDED', target_type: 'user', target_id: u.id, meta: { chama_id: ctx.chama.id }, ip });
    save(db);
    return json(res, 201, {
      member: { id: u.id, name: u.name, phone: u.phone, role, total_contributed: 0, avatar_color: u.avatar_color },
      message: u.name + ' added. They log in with ' + phone + ' and PIN 1234',
    });
  }

  if (url === '/api/members/remove' && req.method === 'POST') {
    const ctx = requireChama(true); if (!ctx) return;
    if (!canManage(ctx.membership.role)) return json(res, 403, { error: 'Not allowed' });
    const targetId = parseInt(body.user_id, 10);
    if (targetId === me.id) return json(res, 400, { error: 'Cannot remove yourself' });
    const target = db.members.find(m => m.chama_id === ctx.chama.id && m.user_id === targetId);
    if (!target) return json(res, 404, { error: 'Member not found' });
    if (target.role === 'CHAMA_ADMIN') return json(res, 400, { error: 'Cannot remove Chair' });
    target.status = 'REMOVED';
    save(db);
    return json(res, 200, { ok: true });
  }

  // ---- PAYMENT METHODS (how to pay OUTSIDE the app) ----
  if (url === '/api/payment-methods' && req.method === 'GET') {
    const ctx = requireChama(false); if (!ctx) return;
    return json(res, 200, {
      methods: ctx.chama.payment_methods || [],
      disclaimer: 'ChamaHub does not collect or process contribution money. Pay using your chama method, then record it here.',
    });
  }

  if (url === '/api/payment-methods' && req.method === 'POST') {
    const ctx = requireChama(true); if (!ctx) return;
    if (!canManage(ctx.membership.role)) return json(res, 403, { error: 'Only officials can manage payment methods' });
    const label = String(body.label || '').trim();
    const details = String(body.details || '').trim();
    if (!label || !details) return json(res, 400, { error: 'Label and details required' });
    if (!ctx.chama.payment_methods) ctx.chama.payment_methods = [];
    db.payment_method_seq = (db.payment_method_seq || 0) + 1;
    const method = {
      id: db.payment_method_seq,
      type: String(body.type || 'OTHER').toUpperCase(),
      label, details,
      instructions: String(body.instructions || '').trim(),
      is_default: !!body.is_default || ctx.chama.payment_methods.length === 0,
    };
    if (method.is_default) ctx.chama.payment_methods.forEach(m => { m.is_default = false; });
    ctx.chama.payment_methods.push(method);
    save(db);
    return json(res, 201, { method });
  }

  if (url.match(/^\/api\/payment-methods\/\d+$/) && req.method === 'DELETE') {
    const ctx = requireChama(true); if (!ctx) return;
    if (!canManage(ctx.membership.role)) return json(res, 403, { error: 'Not allowed' });
    const mid = parseInt(url.split('/').pop(), 10);
    ctx.chama.payment_methods = (ctx.chama.payment_methods || []).filter(m => m.id !== mid);
    save(db);
    return json(res, 200, { ok: true });
  }

  // ---- CONTRIBUTIONS (ledger only) ----
  if (url === '/api/contributions' && req.method === 'GET') {
    const ctx = requireChama(false); if (!ctx) return;
    const list = db.contributions
      .filter(c => c.chama_id === ctx.chama.id)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .map(c => {
        const u = db.users.find(x => x.id === c.user_id);
        return {
          id: c.id, amount: c.amount, status: c.status, method: c.method,
          payment_method_label: c.payment_method_label, mpesa_ref: c.mpesa_ref,
          created_at: c.created_at, name: u && u.name, user_id: c.user_id,
          is_mine: c.user_id === me.id,
        };
      });
    const success = list.filter(c => c.status === 'SUCCESS');
    return json(res, 200, {
      contributions: list,
      total: success.reduce((s, c) => s + c.amount, 0),
      mine: success.filter(c => c.is_mine).reduce((s, c) => s + c.amount, 0),
      count: success.length,
      pending_count: list.filter(c => c.status === 'PENDING').length,
      can_confirm: canConfirm(ctx.membership.role),
    });
  }

  if (url === '/api/contributions/record' && req.method === 'POST') {
    const ctx = requireChama(true); if (!ctx) return;
    const amt = parseInt(body.amount, 10);
    if (!amt || amt < 1) return json(res, 400, { error: 'Enter a valid amount' });
    const methods = ctx.chama.payment_methods || [];
    const methodId = body.payment_method_id != null ? parseInt(body.payment_method_id, 10) : null;
    const method = methods.find(m => m.id === methodId) || methods.find(m => m.is_default) || methods[0] || null;
    const reference = String(body.reference || '').trim() || null;
    const now = new Date().toISOString();
    const cid = nextId(db, 'contributions');
    const auto = canConfirm(ctx.membership.role) && body.confirm_now === true;
    const status = auto ? 'SUCCESS' : 'PENDING';
    const row = {
      id: cid, chama_id: ctx.chama.id, user_id: me.id, amount: amt, status,
      method: method ? method.type : 'EXTERNAL',
      payment_method_id: method ? method.id : null,
      payment_method_label: method ? method.label : 'External',
      mpesa_ref: reference, note: null, recorded_by: me.id,
      confirmed_by: auto ? me.id : null, confirmed_at: auto ? now : null, created_at: now,
    };
    db.contributions.push(row);
    audit(db, { actor_id: me.id, action: 'CONTRIBUTION_REPORTED', target_type: 'contribution', target_id: cid, meta: { amount: amt, status }, ip });
    save(db);
    return json(res, 201, {
      contribution: row,
      message: status === 'SUCCESS'
        ? 'Contribution recorded and confirmed.'
        : 'Submitted. Treasurer will confirm after checking the payment outside the app.',
    });
  }

  if (url === '/api/contributions/confirm' && req.method === 'POST') {
    const ctx = requireChama(true); if (!ctx) return;
    if (!canConfirm(ctx.membership.role)) return json(res, 403, { error: 'Only Chair or Treasurer can confirm' });
    const c = db.contributions.find(x => x.id === parseInt(body.contribution_id, 10) && x.chama_id === ctx.chama.id);
    if (!c) return json(res, 404, { error: 'Not found' });
    c.status = 'SUCCESS';
    c.confirmed_by = me.id;
    c.confirmed_at = new Date().toISOString();
    if (body.reference) c.mpesa_ref = String(body.reference).trim();
    save(db);
    return json(res, 200, { contribution: c, message: 'Confirmed on ledger' });
  }

  if (url === '/api/contributions/reject' && req.method === 'POST') {
    const ctx = requireChama(true); if (!ctx) return;
    if (!canConfirm(ctx.membership.role)) return json(res, 403, { error: 'Not allowed' });
    const c = db.contributions.find(x => x.id === parseInt(body.contribution_id, 10) && x.chama_id === ctx.chama.id);
    if (!c) return json(res, 404, { error: 'Not found' });
    c.status = 'REJECTED';
    c.confirmed_by = me.id;
    c.confirmed_at = new Date().toISOString();
    save(db);
    return json(res, 200, { contribution: c });
  }

  // ---- LOANS ----
  if (url === '/api/loans' && req.method === 'GET') {
    const ctx = requireChama(false); if (!ctx) return;
    const my_loan = db.loans.find(l => l.chama_id === ctx.chama.id && l.user_id === me.id && l.status === 'ACTIVE') || null;
    return json(res, 200, { my_loan, loans: db.loans.filter(l => l.chama_id === ctx.chama.id) });
  }

  if (url === '/api/loans/apply' && req.method === 'POST') {
    const ctx = requireChama(true); if (!ctx) return;
    const principal = parseInt(body.amount, 10);
    if (!principal || principal < 1000) return json(res, 400, { error: 'Minimum KES 1,000' });
    if (db.loans.find(l => l.chama_id === ctx.chama.id && l.user_id === me.id && l.status === 'ACTIVE')) {
      return json(res, 400, { error: 'You already have an active loan' });
    }
    const id = nextId(db, 'loans');
    const next = new Date(); next.setMonth(next.getMonth() + 1);
    const loan = {
      id, chama_id: ctx.chama.id, user_id: me.id, principal,
      interest: Math.round(principal * 0.1), amount_repaid: 0, status: 'ACTIVE',
      next_payment: next.toISOString().slice(0, 10), created_at: new Date().toISOString(),
    };
    db.loans.push(loan);
    save(db);
    return json(res, 201, { loan, message: 'Loan recorded' });
  }

  // ---- MESSAGES ----
  if (url === '/api/messages' && req.method === 'GET') {
    const ctx = requireChama(false); if (!ctx) return;
    const messages = db.messages.filter(m => m.chama_id === ctx.chama.id).map(m => {
      const u = db.users.find(x => x.id === m.user_id);
      return { id: m.id, body: m.body, created_at: m.created_at, user_id: m.user_id, name: u && u.name };
    });
    return json(res, 200, { messages });
  }

  if (url === '/api/messages' && req.method === 'POST') {
    const ctx = requireChama(true); if (!ctx) return;
    const text = String(body.body || '').trim();
    if (!text) return json(res, 400, { error: 'Message required' });
    const id = nextId(db, 'messages');
    const msg = { id, chama_id: ctx.chama.id, user_id: me.id, body: text, created_at: new Date().toISOString() };
    db.messages.push(msg);
    save(db);
    const user = db.users.find(u => u.id === me.id);
    return json(res, 201, { message: { ...msg, name: user.name } });
  }

  // ---- MEETINGS / SUBSCRIPTION ----
  if (url === '/api/meetings' && req.method === 'GET') {
    const ctx = requireChama(false); if (!ctx) return;
    return json(res, 200, { meetings: db.meetings.filter(m => m.chama_id === ctx.chama.id) });
  }

  if (url === '/api/subscription' && req.method === 'GET') {
    const ctx = chamaCtx(db, me.id);
    if (!ctx.membership) return json(res, 404, { error: 'Not in a chama' });
    const plan = sub.getPlan(db, ctx.subscription && ctx.subscription.plan_id);
    return json(res, 200, {
      plan: plan && plan.name,
      status: ctx.subscription && ctx.subscription.status,
      next_payment: ctx.subscription && ctx.subscription.current_period_end,
      max_members: sub.memberLimit(db, ctx.chama.id),
      price: (ctx.subscription && ctx.subscription.amount) || 500,
      chama_status: ctx.chama.status,
      suspend_reason: ctx.chama.suspend_reason,
    });
  }

  // Create / join chama
  if (url === '/api/chamas' && req.method === 'POST') {
    if (getMembership(db, me.id)) return json(res, 400, { error: 'Already in a chama' });
    const name = String(body.name || '').trim();
    if (!name) return json(res, 400, { error: 'Chama name required' });
    const plan = sub.getPlan(db, (db.settings && db.settings.default_plan_id) || 1);
    const id = nextId(db, 'chamas');
    const trialDays = plan.trial_days || 14;
    const trialEnd = sub.addDays(new Date().toISOString().slice(0, 10), trialDays);
    const code = name.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) + id;
    const chama = {
      id, name, description: '', status: 'ACTIVE', suspend_reason: null,
      max_members: plan.max_members, contribution_amount: parseInt(body.contribution_amount, 10) || 2000,
      owner_user_id: me.id, invite_code: code, payment_methods: [],
      created_at: new Date().toISOString(), last_active: new Date().toISOString(),
    };
    db.chamas.push(chama);
    db.members.push({ id: nextId(db, 'members'), chama_id: id, user_id: me.id, role: 'CHAMA_ADMIN', joined_at: new Date().toISOString(), status: 'ACTIVE' });
    db.subscriptions.push({
      id: nextId(db, 'subscriptions'), chama_id: id, plan_id: plan.id, status: 'TRIAL',
      started_at: new Date().toISOString(), trial_ends_at: trialEnd,
      current_period_start: new Date().toISOString().slice(0, 10), current_period_end: trialEnd,
      grace_ends_at: null, cancelled_at: null, amount: plan.price, currency: 'KES',
    });
    save(db);
    return json(res, 201, { chama, invite_code: code, message: 'Chama created. Add a payment method so members know how to pay.' });
  }

  if (url === '/api/chamas/join' && req.method === 'POST') {
    if (getMembership(db, me.id)) return json(res, 400, { error: 'Already in a chama' });
    const code = String(body.invite_code || '').trim().toUpperCase();
    const chama = db.chamas.find(c => (c.invite_code || '').toUpperCase() === code);
    if (!chama) return json(res, 404, { error: 'Invalid invite code' });
    const access = sub.getChamaAccess(db, chama.id);
    if (!access.allowed) return json(res, 403, { error: access.reason, message: access.message });
    const limit = sub.memberLimit(db, chama.id);
    const count = db.members.filter(m => m.chama_id === chama.id && m.status !== 'REMOVED').length;
    if (count >= limit) return json(res, 400, { error: 'Chama is full' });
    db.members.push({ id: nextId(db, 'members'), chama_id: chama.id, user_id: me.id, role: 'MEMBER', joined_at: new Date().toISOString(), status: 'ACTIVE' });
    save(db);
    return json(res, 200, { message: 'Joined ' + chama.name });
  }

  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const pathname = urlPath(req.url);
  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }
    if (pathname === '/owner' || pathname.startsWith('/owner/')) {
      const fp = path.join(PUBLIC, 'owner', 'index.html');
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Owner UI missing'); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
      return;
    }
    let fp = path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname);
    if (!fp.startsWith(PUBLIC)) { res.writeHead(404); return res.end('Not found'); }
    fs.readFile(fp, (err, data) => {
      if (err) {
        fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
          if (e2) { res.writeHead(404); return res.end('Not found'); }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ChamaHub Kenya v4');
  console.log('  App:   http://localhost:' + PORT);
  console.log('  Owner: http://localhost:' + PORT + '/owner');
  console.log('  Chair: 0723456789 / 1234');
  console.log('  Owner: 0700000001 / Owner@2026!');
  console.log('');
});
