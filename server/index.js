
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb, save, hashPin, nextId, audit, IS_PROD } = require('./db');
const sub = require('./subscription');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'chamahub-kenya-prod-change-me';
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// Run expiry job every hour
setInterval(() => { try { sub.processExpirations(); } catch (e) { console.error('expiry job', e); } }, 3600e3);
setTimeout(() => { try { sub.processExpirations(); } catch (e) {} }, 2000);

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
  return new Promise((res, rej) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 2e6) rej(new Error('too large')); });
    req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch { res({}); } });
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
function requireAuth(req, res) {
  const me = auth(req);
  if (!me) { json(res, 401, { error: 'Unauthorized' }); return null; }
  return me;
}
function requireSuperAdmin(req, res, db) {
  const me = requireAuth(req, res);
  if (!me) return null;
  const user = db.users.find(u => u.id === me.id);
  if (!user || user.platform_role !== 'SUPER_ADMIN') {
    json(res, 403, { error: 'SUPER_ADMIN access required' });
    return null;
  }
  if (user.status === 'SUSPENDED') {
    json(res, 403, { error: 'Account suspended' });
    return null;
  }
  return { me, user };
}
function getMembership(db, userId) {
  return db.members.find(m => m.user_id === userId && m.status !== 'REMOVED') || null;
}
function canManageMembers(role) {
  return ['CHAMA_ADMIN', 'TREASURER', 'SECRETARY'].includes(role);
}
function urlPath(u) { try { return new URL(u, 'http://x').pathname; } catch { return '/'; } }

function chamaContext(db, userId) {
  const membership = getMembership(db, userId);
  if (!membership) return { membership: null, chama: null, access: null, subscription: null };
  const access = sub.getChamaAccess(db, membership.chama_id);
  const subscription = sub.getSubscription(db, membership.chama_id);
  return { membership, chama: access.chama || db.chamas.find(c => c.id === membership.chama_id), access, subscription };
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' });
    return res.end();
  }
  const db = getDb();
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await parseBody(req) : {};
  const ip = clientIp(req);

  // Maintenance (except owner + auth)
  if (db.settings && db.settings.maintenance_mode && !url.startsWith('/api/auth') && !url.startsWith('/api/owner')) {
    const me = auth(req);
    const u = me && db.users.find(x => x.id === me.id);
    if (!u || u.platform_role !== 'SUPER_ADMIN') {
      return json(res, 503, { error: 'MAINTENANCE', message: db.settings.maintenance_message });
    }
  }


  // Public plans (pricing page)
  if (url === '/api/plans' && req.method === 'GET') {
    const plans = db.plans.filter(p => p.active).sort((a, b) => (a.sort_order || a.id) - (b.sort_order || b.id));
    return json(res, 200, { plans: plans.map(p => ({
      id: p.id, name: p.name, price: p.price, currency: p.currency,
      billing_cycle: p.billing_cycle, max_members: p.max_members,
      trial_days: p.trial_days, features: p.features, description: p.description,
    })) });
  }

  // ========== AUTH ==========
  if (url === '/api/auth/login' && req.method === 'POST') {
    const phone = normalizePhone(body.phone);
    const user = db.users.find(u => u.phone === phone);
    if (!user || user.pin_hash !== hashPin(body.pin)) {
      return json(res, 401, { error: 'Invalid phone or PIN' });
    }
    if (user.status === 'SUSPENDED') return json(res, 403, { error: 'Your account is suspended' });
    user.last_login = new Date().toISOString();
    audit(db, { actor_id: user.id, action: 'LOGIN', target_type: 'user', target_id: user.id, ip });
    save(db);

    const ctx = chamaContext(db, user.id);
    // If suspended chama, still return token but flag access
    return json(res, 200, {
      token: sign({ id: user.id, phone: user.phone, name: user.name, platform_role: user.platform_role }),
      user: { id: user.id, phone: user.phone, name: user.name, email: user.email, platform_role: user.platform_role, avatar_color: user.avatar_color },
      chama: ctx.membership ? {
        chama_id: ctx.chama.id, chama_name: ctx.chama.name, member_role: ctx.membership.role,
        invite_code: ctx.chama.invite_code, max_members: ctx.chama.max_members,
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
    if (!phone || !pin || !name) return json(res, 400, { error: 'Phone, PIN and name required' });
    if (pin.length < 4) return json(res, 400, { error: 'PIN must be at least 4 digits' });
    if (db.users.find(u => u.phone === phone)) return json(res, 409, { error: 'Phone already registered' });
    const id = nextId(db, 'users');
    const colors = ['#0D5C45', '#1A7A5C', '#C9A227', '#2E9B78', '#0A3D2E'];
    const user = { id, phone, pin_hash: hashPin(pin), name, email: body.email || null, platform_role: 'USER', status: 'ACTIVE', avatar_color: colors[id % 5], created_at: new Date().toISOString(), last_login: null };
    db.users.push(user);
    audit(db, { actor_id: id, action: 'USER_REGISTERED', target_type: 'user', target_id: id, ip });
    save(db);
    return json(res, 201, {
      token: sign({ id, phone, name, platform_role: 'USER' }),
      user: { id, phone, name, email: user.email, platform_role: 'USER', avatar_color: user.avatar_color },
      chama: null, access: null, subscription: null,
    });
  }

  if (url === '/api/me' && req.method === 'GET') {
    const me = requireAuth(req, res); if (!me) return;
    const user = db.users.find(u => u.id === me.id);
    if (!user) return json(res, 404, { error: 'User not found' });
    const ctx = chamaContext(db, user.id);
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

  // ========== OWNER APIs (SUPER_ADMIN only) ==========
  if (url.startsWith('/api/owner')) {
    const sa = requireSuperAdmin(req, res, db);
    if (!sa) return;
    const { me, user } = sa;

    if (url === '/api/owner/stats' && req.method === 'GET') {
      const chamas = db.chamas;
      const subs = db.subscriptions;
      const payments = db.payments.filter(p => p.status === 'SUCCESS' && p.type === 'SUBSCRIPTION');
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const yearStart = new Date(now.getFullYear(), 0, 1).toISOString();
      const byStatus = (st) => subs.filter(s => s.status === st).length;
      const activeChamas = chamas.filter(c => c.status === 'ACTIVE').length;
      const suspendedChamas = chamas.filter(c => c.status === 'SUSPENDED').length;
      const mrr = subs.filter(s => s.status === 'ACTIVE' || s.status === 'TRIAL').reduce((s, x) => s + (x.amount || 0), 0);
      const revenueMonth = payments.filter(p => p.completed_at >= monthStart).reduce((s, p) => s + p.amount, 0);
      const revenueYear = payments.filter(p => p.completed_at >= yearStart).reduce((s, p) => s + p.amount, 0);
      const newChamasMonth = chamas.filter(c => c.created_at >= monthStart).length;
      const newUsersMonth = db.users.filter(u => u.created_at >= monthStart).length;
      const totalMembers = db.members.filter(m => m.status !== 'REMOVED').length;
      return json(res, 200, {
        total_users: db.users.length,
        active_users: db.users.filter(u => u.status === 'ACTIVE').length,
        total_chamas: chamas.length,
        active_chamas: activeChamas,
        trial_chamas: byStatus('TRIAL'),
        paid_chamas: byStatus('ACTIVE'),
        past_due_chamas: byStatus('PAST_DUE') + byStatus('GRACE_PERIOD'),
        suspended_chamas: suspendedChamas,
        cancelled_chamas: byStatus('CANCELLED'),
        expired_chamas: byStatus('EXPIRED'),
        mrr,
        revenue_month: revenueMonth,
        revenue_year: revenueYear,
        pending_payments: db.payments.filter(p => p.status === 'PENDING').length,
        failed_payments: db.payments.filter(p => p.status === 'FAILED').length,
        total_members: totalMembers,
        new_chamas_month: newChamasMonth,
        new_users_month: newUsersMonth,
      });
    }

    if (url === '/api/owner/chamas' && req.method === 'GET') {
      const q = (req.url.split('?')[1] || '');
      const params = new URLSearchParams(q);
      const search = (params.get('search') || '').toLowerCase();
      const filter = params.get('status') || '';
      let list = db.chamas.map(c => {
        const subscription = sub.getSubscription(db, c.id);
        const admin = db.members.find(m => m.chama_id === c.id && m.role === 'CHAMA_ADMIN');
        const adminUser = admin && db.users.find(u => u.id === admin.user_id);
        const memberCount = db.members.filter(m => m.chama_id === c.id && m.status !== 'REMOVED').length;
        const paid = db.payments.filter(p => p.chama_id === c.id && p.status === 'SUCCESS').reduce((s, p) => s + p.amount, 0);
        const lastPay = db.payments.filter(p => p.chama_id === c.id && p.status === 'SUCCESS').sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))[0];
        return {
          id: c.id, name: c.name, status: c.status, suspend_reason: c.suspend_reason,
          invite_code: c.invite_code, member_count: memberCount, max_members: sub.memberLimit(db, c.id),
          admin_name: adminUser && adminUser.name, admin_phone: adminUser && adminUser.phone, admin_email: adminUser && adminUser.email,
          plan: subscription && (db.plans.find(p => p.id === subscription.plan_id) || {}).name,
          subscription_status: subscription && subscription.status,
          amount: subscription && subscription.amount,
          period_end: subscription && subscription.current_period_end,
          total_paid: paid,
          last_payment: lastPay && lastPay.completed_at,
          created_at: c.created_at,
          last_active: c.last_active,
        };
      });
      if (search) {
        list = list.filter(c =>
          (c.name || '').toLowerCase().includes(search) ||
          String(c.id).includes(search) ||
          (c.admin_name || '').toLowerCase().includes(search) ||
          (c.admin_phone || '').includes(search) ||
          (c.admin_email || '').toLowerCase().includes(search)
        );
      }
      if (filter === 'SUSPENDED') list = list.filter(c => c.status === 'SUSPENDED');
      else if (filter) list = list.filter(c => c.subscription_status === filter);
      return json(res, 200, { chamas: list });
    }

    if (url.match(/^\/api\/owner\/chamas\/\d+$/) && req.method === 'GET') {
      const id = parseInt(url.split('/').pop(), 10);
      const c = db.chamas.find(x => x.id === id);
      if (!c) return json(res, 404, { error: 'Chama not found' });
      const subscription = sub.getSubscription(db, id);
      const memberList = db.members.filter(m => m.chama_id === id).map(m => {
        const u = db.users.find(x => x.id === m.user_id);
        return { id: u.id, name: u.name, phone: u.phone, role: m.role, status: m.status, joined_at: m.joined_at };
      });
      const contribs = db.contributions.filter(x => x.chama_id === id && (x.status === 'SUCCESS' || x.status === 'completed'));
      const totalContrib = contribs.reduce((s, x) => s + x.amount, 0);
      const activeLoans = db.loans.filter(l => l.chama_id === id && l.status === 'ACTIVE');
      const totalLoans = activeLoans.reduce((s, l) => s + l.principal, 0);
      const payments = db.payments.filter(p => p.chama_id === id).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      const audits = db.audit_logs.filter(a => a.meta && a.meta.chama_id === id || a.target_type === 'chama' && a.target_id === id).slice(-50);
      return json(res, 200, {
        chama: c, subscription, members: memberList,
        financials: { total_contributions: totalContrib, total_loans: totalLoans, loan_count: activeLoans.length, balance: totalContrib - totalLoans },
        payments, audit: audits,
      });
    }

    if (url.match(/^\/api\/owner\/chamas\/\d+\/suspend$/) && req.method === 'POST') {
      const id = parseInt(url.split('/')[4], 10);
      try {
        const chama = sub.suspendChama(db, { chamaId: id, reason: body.reason || 'Administrative suspension', actorId: me.id, ip });
        return json(res, 200, { chama, message: 'Chama suspended. Data preserved.' });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (url.match(/^\/api\/owner\/chamas\/\d+\/reactivate$/) && req.method === 'POST') {
      const id = parseInt(url.split('/')[4], 10);
      try {
        const result = sub.reactivateChama(db, { chamaId: id, actorId: me.id, ip, extendDays: body.extend_days || 0 });
        return json(res, 200, { ...result, message: 'Chama reactivated' });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (url.match(/^\/api\/owner\/chamas\/\d+\/extend$/) && req.method === 'POST') {
      const id = parseInt(url.split('/')[4], 10);
      const days = parseInt(body.days, 10) || 30;
      try {
        const subscription = sub.extendSubscription(db, { chamaId: id, days, actorId: me.id, ip });
        return json(res, 200, { subscription, message: 'Extended by ' + days + ' days' });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (url === '/api/owner/payments' && req.method === 'GET') {
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const status = params.get('status') || '';
      const search = (params.get('search') || '').toLowerCase();
      let list = db.payments.map(p => {
        const c = db.chamas.find(x => x.id === p.chama_id);
        const u = db.users.find(x => x.id === p.user_id);
        return { ...p, chama_name: c && c.name, payer_name: u && u.name };
      }).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      if (status) list = list.filter(p => p.status === status);
      if (search) list = list.filter(p =>
        (p.chama_name || '').toLowerCase().includes(search) ||
        (p.phone || '').includes(search) ||
        (p.mpesa_ref || '').toLowerCase().includes(search) ||
        String(p.id).includes(search)
      );
      return json(res, 200, { payments: list });
    }

    if (url === '/api/owner/payments/manual' && req.method === 'POST') {
      const chamaId = parseInt(body.chama_id, 10);
      const amount = parseInt(body.amount, 10) || 500;
      if (!chamaId || !db.chamas.find(c => c.id === chamaId)) return json(res, 400, { error: 'Valid chama_id required' });
      const pid = nextId(db, 'payments');
      const payment = {
        id: pid, chama_id: chamaId, user_id: me.id, amount, currency: 'KES',
        type: 'SUBSCRIPTION', method: body.method || 'MANUAL', provider: 'MANUAL',
        phone: body.phone || null, mpesa_ref: body.reference || ('MANUAL-' + pid),
        status: 'SUCCESS', billing_period: null, applied_to_subscription: false,
        notes: body.notes || '', created_at: new Date().toISOString(), completed_at: new Date().toISOString(),
      };
      db.payments.push(payment);
      save(db);
      const result = sub.activateFromPayment(db, { chamaId, paymentId: pid, amount, actorId: me.id });
      audit(db, { actor_id: me.id, action: 'MANUAL_PAYMENT_RECORDED', target_type: 'payment', target_id: pid, meta: { chama_id: chamaId, amount }, ip });
      save(db);
      return json(res, 201, { payment, subscription: result.subscription, message: 'Manual payment recorded and subscription activated' });
    }

    if (url === '/api/owner/users' && req.method === 'GET') {
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const search = (params.get('search') || '').toLowerCase();
      let list = db.users.map(u => {
        const m = getMembership(db, u.id);
        const c = m && db.chamas.find(x => x.id === m.chama_id);
        return {
          id: u.id, name: u.name, phone: u.phone, email: u.email,
          platform_role: u.platform_role, status: u.status,
          chama_name: c && c.name, chama_role: m && m.role,
          last_login: u.last_login, created_at: u.created_at,
        };
      });
      if (search) list = list.filter(u =>
        (u.name || '').toLowerCase().includes(search) ||
        (u.phone || '').includes(search) ||
        (u.email || '').toLowerCase().includes(search)
      );
      return json(res, 200, { users: list });
    }

    if (url === '/api/owner/audit' && req.method === 'GET') {
      const logs = [...db.audit_logs].reverse().slice(0, 200).map(a => {
        const actor = db.users.find(u => u.id === a.actor_id);
        return { ...a, actor_name: actor && actor.name };
      });
      return json(res, 200, { logs });
    }

    if (url === '/api/owner/settings' && req.method === 'GET') {
      return json(res, 200, { settings: db.settings, plans: db.plans });
    }

    if (url === '/api/owner/settings' && req.method === 'POST') {
      Object.assign(db.settings, body.settings || body);
      audit(db, { actor_id: me.id, action: 'SETTINGS_UPDATED', target_type: 'settings', target_id: 0, meta: body, ip });
      save(db);
      return json(res, 200, { settings: db.settings });
    }

    if (url === '/api/owner/maintenance' && req.method === 'POST') {
      db.settings.maintenance_mode = !!body.enabled;
      if (body.message) db.settings.maintenance_message = body.message;
      audit(db, { actor_id: me.id, action: body.enabled ? 'MAINTENANCE_ON' : 'MAINTENANCE_OFF', target_type: 'settings', target_id: 0, ip });
      save(db);
      return json(res, 200, { maintenance_mode: db.settings.maintenance_mode });
    }

    if (url === '/api/owner/run-expiry' && req.method === 'POST') {
      const n = sub.processExpirations(me.id);
      return json(res, 200, { processed: n, message: 'Expiry job ran' });
    }


    // ---- PLANS ----
    if (url === '/api/owner/plans' && req.method === 'GET') {
      const plans = [...db.plans].sort((a, b) => (a.sort_order || a.id) - (b.sort_order || b.id));
      return json(res, 200, { plans });
    }

    if (url === '/api/owner/plans' && req.method === 'POST') {
      const name = String(body.name || '').trim();
      const price = parseInt(body.price, 10);
      const max_members = parseInt(body.max_members, 10);
      if (!name || !price || !max_members) return json(res, 400, { error: 'name, price, max_members required' });
      const id = nextId(db, 'plans');
      const plan = {
        id, name, price, currency: body.currency || 'KES',
        billing_cycle: body.billing_cycle || 'monthly',
        max_members, trial_days: parseInt(body.trial_days, 10) || 14,
        features: Array.isArray(body.features) ? body.features : String(body.features || '').split(',').map(s => s.trim()).filter(Boolean),
        description: body.description || '',
        active: body.active !== false,
        sort_order: parseInt(body.sort_order, 10) || id,
      };
      db.plans.push(plan);
      audit(db, { actor_id: me.id, action: 'PLAN_CREATED', target_type: 'plan', target_id: id, meta: { name, price, max_members }, ip });
      save(db);
      return json(res, 201, { plan });
    }

    if (url.match(/^\/api\/owner\/plans\/\d+$/) && req.method === 'PUT') {
      const id = parseInt(url.split('/').pop(), 10);
      const plan = db.plans.find(p => p.id === id);
      if (!plan) return json(res, 404, { error: 'Plan not found' });
      if (body.name != null) plan.name = String(body.name).trim();
      if (body.price != null) plan.price = parseInt(body.price, 10);
      if (body.max_members != null) plan.max_members = parseInt(body.max_members, 10);
      if (body.trial_days != null) plan.trial_days = parseInt(body.trial_days, 10);
      if (body.billing_cycle != null) plan.billing_cycle = body.billing_cycle;
      if (body.description != null) plan.description = body.description;
      if (body.active != null) plan.active = !!body.active;
      if (body.features != null) {
        plan.features = Array.isArray(body.features) ? body.features : String(body.features).split(',').map(s => s.trim()).filter(Boolean);
      }
      if (body.sort_order != null) plan.sort_order = parseInt(body.sort_order, 10);
      audit(db, { actor_id: me.id, action: 'PLAN_UPDATED', target_type: 'plan', target_id: id, meta: body, ip });
      save(db);
      return json(res, 200, { plan });
    }

    if (url.match(/^\/api\/owner\/chamas\/\d+\/change-plan$/) && req.method === 'POST') {
      const chamaId = parseInt(url.split('/')[4], 10);
      const planId = parseInt(body.plan_id, 10);
      const plan = db.plans.find(p => p.id === planId && p.active);
      if (!plan) return json(res, 400, { error: 'Invalid or inactive plan' });
      const chama = db.chamas.find(c => c.id === chamaId);
      if (!chama) return json(res, 404, { error: 'Chama not found' });
      const subscription = sub.getSubscription(db, chamaId);
      if (!subscription) return json(res, 404, { error: 'No subscription' });
      const memberCount = db.members.filter(m => m.chama_id === chamaId && m.status !== 'REMOVED').length;
      if (memberCount > plan.max_members) {
        return json(res, 400, { error: 'Chama has ' + memberCount + ' members but plan allows only ' + plan.max_members });
      }
      subscription.plan_id = plan.id;
      subscription.amount = plan.price;
      chama.max_members = plan.max_members;
      audit(db, { actor_id: me.id, action: 'PLAN_CHANGED', target_type: 'chama', target_id: chamaId, meta: { plan_id: plan.id, plan_name: plan.name }, ip });
      save(db);
      return json(res, 200, { subscription, plan, message: 'Plan changed to ' + plan.name });
    }


    return json(res, 404, { error: 'Owner route not found' });
  }

  // ========== CHAMA USER APIs (auth required) ==========
  const me = requireAuth(req, res);
  if (!me) return;
  const user = db.users.find(u => u.id === me.id);
  if (!user) return json(res, 404, { error: 'User not found' });

  // Helper: require chama membership + access for writes
  function requireChama(write = false) {
    const ctx = chamaContext(db, me.id);
    if (!ctx.membership) { json(res, 404, { error: 'You are not in a chama' }); return null; }
    if (!ctx.access.allowed) {
      json(res, 403, {
        error: ctx.access.reason,
        message: ctx.access.message,
        suspend_reason: ctx.access.suspend_reason,
        amount_due: ctx.access.amount_due,
        subscription: ctx.access.subscription,
      });
      return null;
    }
    if (write && ctx.access.write_allowed === false) {
      json(res, 403, { error: 'PAYMENT_REQUIRED', message: 'Subscription past due. Pay to continue transactions.', subscription: ctx.subscription });
      return null;
    }
    return ctx;
  }

  // Dashboard
  if (url === '/api/dashboard' && req.method === 'GET') {
    const ctx = chamaContext(db, me.id);
    if (!ctx.membership) return json(res, 404, { error: 'Not in a chama' });
    if (!ctx.access.allowed) {
      return json(res, 403, {
        error: ctx.access.reason, message: ctx.access.message,
        suspend_reason: ctx.access.suspend_reason, amount_due: ctx.access.amount_due,
        subscription: ctx.subscription, chama: { id: ctx.chama.id, name: ctx.chama.name },
      });
    }
    const chamaId = ctx.chama.id;
    const contribs = db.contributions.filter(c => c.chama_id === chamaId && (c.status === 'SUCCESS' || c.status === 'completed'));
    const total_savings = contribs.reduce((s, c) => s + c.amount, 0);
    const month_contributions = contribs.filter(c => (c.created_at || '').startsWith('2026-09') || new Date(c.created_at) >= new Date(new Date().getFullYear(), new Date().getMonth(), 1)).reduce((s, c) => s + c.amount, 0);
    const outstanding_loans = db.loans.filter(l => l.chama_id === chamaId && l.status === 'ACTIVE').reduce((s, l) => s + l.principal + (l.interest || 0) - (l.amount_repaid || 0), 0);
    const member_count = db.members.filter(m => m.chama_id === chamaId && m.status !== 'REMOVED').length;
    const my_loan = db.loans.find(l => l.chama_id === chamaId && l.user_id === me.id && l.status === 'ACTIVE') || null;
    const my_contributions = contribs.filter(c => c.user_id === me.id).reduce((s, c) => s + c.amount, 0);
    const recent = contribs.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 10).map(c => {
      const u = db.users.find(x => x.id === c.user_id);
      return { id: c.id, amount: c.amount, created_at: c.created_at, mpesa_ref: c.mpesa_ref, status: c.status, name: u && u.name, user_id: c.user_id };
    });
    return json(res, 200, {
      chama: {
        id: ctx.chama.id, name: ctx.chama.name, max_members: sub.memberLimit(db, chamaId),
        contribution_amount: ctx.chama.contribution_amount, invite_code: ctx.chama.invite_code,
      },
      subscription: ctx.subscription,
      access: ctx.access,
      total_savings, month_contributions, outstanding_loans, member_count,
      my_loan, my_contributions, recent_contributions: recent,
      member_role: ctx.membership.role,
      can_manage: canManageMembers(ctx.membership.role),
    });
  }

  // Members list
  if (url === '/api/members' && req.method === 'GET') {
    const ctx = requireChama(false); if (!ctx) return;
    const cid = ctx.chama.id;
    const members = db.members.filter(m => m.chama_id === cid && m.status !== 'REMOVED').map(m => {
      const u = db.users.find(x => x.id === m.user_id);
      const total_contributed = db.contributions.filter(c => c.user_id === m.user_id && c.chama_id === cid && (c.status === 'SUCCESS' || c.status === 'completed')).reduce((s, c) => s + c.amount, 0);
      const outstanding_loan = db.loans.filter(l => l.user_id === m.user_id && l.chama_id === cid && l.status === 'ACTIVE').reduce((s, l) => s + l.principal + (l.interest || 0) - (l.amount_repaid || 0), 0);
      return { id: u.id, name: u.name, phone: u.phone, avatar_color: u.avatar_color, role: m.role, joined_at: m.joined_at, total_contributed, outstanding_loan };
    });
    return json(res, 200, {
      members, invite_code: ctx.chama.invite_code, can_manage: canManageMembers(ctx.membership.role),
      max_members: sub.memberLimit(db, cid), member_count: members.length,
    });
  }

  // Add member
  if (url === '/api/members/add' && req.method === 'POST') {
    const ctx = requireChama(true); if (!ctx) return;
    if (!canManageMembers(ctx.membership.role)) return json(res, 403, { error: 'Only Chair, Treasurer or Secretary can add members' });
    const limit = sub.memberLimit(db, ctx.chama.id);
    const count = db.members.filter(m => m.chama_id === ctx.chama.id && m.status !== 'REMOVED').length;
    if (count >= limit) return json(res, 400, { error: 'Member limit reached (' + limit + '). Upgrade plan or remove a member.' });
    const phone = normalizePhone(body.phone);
    const name = String(body.name || '').trim();
    let role = body.role || 'MEMBER';
    if (role === 'member') role = 'MEMBER';
    if (role === 'treasurer') role = 'TREASURER';
    if (role === 'secretary') role = 'SECRETARY';
    if (!['MEMBER', 'TREASURER', 'SECRETARY'].includes(role)) role = 'MEMBER';
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
    audit(db, { actor_id: me.id, action: 'MEMBER_ADDED', target_type: 'user', target_id: u.id, meta: { chama_id: ctx.chama.id, role }, ip });
    save(db);
    return json(res, 201, { member: { id: u.id, name: u.name, phone: u.phone, role, total_contributed: 0, outstanding_loan: 0, avatar_color: u.avatar_color }, message: u.name + ' added. Login: ' + phone + ' / PIN 1234' });
  }

  // Remove member
  if (url === '/api/members/remove' && req.method === 'POST') {
    const ctx = requireChama(true); if (!ctx) return;
    if (!canManageMembers(ctx.membership.role)) return json(res, 403, { error: 'Not allowed' });
    const targetId = parseInt(body.user_id, 10);
    if (targetId === me.id) return json(res, 400, { error: 'Cannot remove yourself' });
    const target = db.members.find(m => m.chama_id === ctx.chama.id && m.user_id === targetId);
    if (!target) return json(res, 404, { error: 'Member not found' });
    if (target.role === 'CHAMA_ADMIN') return json(res, 400, { error: 'Cannot remove Chama Admin' });
    target.status = 'REMOVED';
    audit(db, { actor_id: me.id, action: 'MEMBER_REMOVED', target_type: 'user', target_id: targetId, meta: { chama_id: ctx.chama.id }, ip });
    save(db);
    return json(res, 200, { ok: true });
  }

  // Contributions
  if (url === '/api/contributions' && req.method === 'GET') {
    const ctx = requireChama(false); if (!ctx) return;
    const list = db.contributions.filter(c => c.chama_id === ctx.chama.id).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).map(c => {
      const u = db.users.find(x => x.id === c.user_id);
      return { ...c, name: u && u.name, is_mine: c.user_id === me.id, status: c.status === 'completed' ? 'SUCCESS' : c.status };
    });
    const success = list.filter(c => c.status === 'SUCCESS');
    return json(res, 200, { contributions: list, total: success.reduce((s, c) => s + c.amount, 0), mine: success.filter(c => c.is_mine).reduce((s, c) => s + c.amount, 0), count: success.length });
  }

  if (url === '/api/contributions/initiate' && req.method === 'POST') {
    const ctx = requireChama(true); if (!ctx) return;
    const amt = parseInt(body.amount, 10);
    if (!amt || amt < 100) return json(res, 400, { error: 'Minimum KES 100' });
    const cid = nextId(db, 'contributions');
    const pid = nextId(db, 'payments');
    const checkoutId = 'ws_' + crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();
    db.contributions.push({ id: cid, chama_id: ctx.chama.id, user_id: me.id, amount: amt, status: 'PENDING', method: 'MPESA', mpesa_ref: null, recorded_by: me.id, created_at: now });
    db.payments.push({ id: pid, chama_id: ctx.chama.id, user_id: me.id, amount: amt, currency: 'KES', type: 'CONTRIBUTION', method: 'MPESA', provider: 'MPESA_STK', phone: user.phone, mpesa_ref: null, mpesa_checkout_id: checkoutId, status: 'PENDING', contribution_id: cid, created_at: now, completed_at: null });
    save(db);
    return json(res, 200, { payment_id: checkoutId, contribution_id: cid, amount: amt, phone: user.phone, message: 'STK Push sent to ' + user.phone, demo: !process.env.MPESA_SHORTCODE });
  }

  if (url.startsWith('/api/payments/') && url.endsWith('/status') && req.method === 'GET') {
    const checkoutId = url.split('/')[3];
    const payment = db.payments.find(p => p.mpesa_checkout_id === checkoutId);
    if (!payment) return json(res, 404, { error: 'Payment not found' });
    // Demo STK confirmation after 3s — production: only webhook sets SUCCESS
    if (payment.status === 'PENDING' && !process.env.MPESA_SHORTCODE && Date.now() - new Date(payment.created_at).getTime() > 3000) {
      const receipt = 'QK' + crypto.randomBytes(4).toString('hex').toUpperCase();
      // Idempotent
      if (payment.status === 'PENDING') {
        payment.status = 'SUCCESS';
        payment.mpesa_ref = receipt;
        payment.completed_at = new Date().toISOString();
        if (payment.contribution_id) {
          const c = db.contributions.find(x => x.id === payment.contribution_id);
          if (c) { c.status = 'SUCCESS'; c.mpesa_ref = receipt; }
        }
        if (payment.type === 'SUBSCRIPTION') {
          sub.activateFromPayment(db, { chamaId: payment.chama_id, paymentId: payment.id, amount: payment.amount, actorId: me.id });
        }
        audit(db, { actor_id: me.id, action: 'PAYMENT_SUCCESS', target_type: 'payment', target_id: payment.id, meta: { receipt, type: payment.type }, ip });
        save(db);
      }
    }
    return json(res, 200, { status: payment.status === 'SUCCESS' ? 'completed' : payment.status.toLowerCase(), amount: payment.amount, receipt: payment.mpesa_ref, verified_at: payment.completed_at, phone: payment.phone });
  }

  // Subscription pay for chama admin
  if (url === '/api/subscription' && req.method === 'GET') {
    const ctx = chamaContext(db, me.id);
    if (!ctx.membership) return json(res, 404, { error: 'Not in a chama' });
    const plan = sub.getPlan(db, ctx.subscription && ctx.subscription.plan_id);
    return json(res, 200, {
      plan: plan && plan.name, status: ctx.subscription && ctx.subscription.status,
      next_payment: ctx.subscription && ctx.subscription.current_period_end,
      max_members: sub.memberLimit(db, ctx.chama.id), price: (ctx.subscription && ctx.subscription.amount) || (plan && plan.price) || 500,
      trial_ends_at: ctx.subscription && ctx.subscription.trial_ends_at,
      grace_ends_at: ctx.subscription && ctx.subscription.grace_ends_at,
      chama_status: ctx.chama.status, suspend_reason: ctx.chama.suspend_reason,
    });
  }

  if (url === '/api/subscription/pay' && req.method === 'POST') {
    const ctx = chamaContext(db, me.id);
    if (!ctx.membership) return json(res, 404, { error: 'Not in a chama' });
    if (!['CHAMA_ADMIN', 'TREASURER'].includes(ctx.membership.role)) {
      return json(res, 403, { error: 'Only Chama Admin or Treasurer can pay subscription' });
    }
    const amount = (ctx.subscription && ctx.subscription.amount) || 500;
    const pid = nextId(db, 'payments');
    const checkoutId = 'ws_sub_' + crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();
    db.payments.push({
      id: pid, chama_id: ctx.chama.id, user_id: me.id, amount, currency: 'KES',
      type: 'SUBSCRIPTION', method: 'MPESA', provider: 'MPESA_STK', phone: normalizePhone(body.phone) || user.phone,
      mpesa_ref: null, mpesa_checkout_id: checkoutId, status: 'PENDING',
      applied_to_subscription: false, created_at: now, completed_at: null,
    });
    save(db);
    return json(res, 200, { payment_id: checkoutId, amount, message: 'STK Push initiated for subscription', demo: !process.env.MPESA_SHORTCODE });
  }

  // M-Pesa webhook (idempotent)
  if (url === '/api/webhooks/mpesa' && req.method === 'POST') {
    // Production: verify signature from Safaricom
    const checkoutId = body.CheckoutRequestID || body.checkout_id || body.mpesa_checkout_id;
    const resultCode = body.ResultCode != null ? body.ResultCode : body.result_code;
    const receipt = body.MpesaReceiptNumber || body.mpesa_ref || body.receipt;
    if (!checkoutId) return json(res, 400, { error: 'Missing checkout id' });
    // Dedupe webhook
    const whKey = checkoutId + ':' + (receipt || resultCode);
    if (db.payment_webhooks.find(w => w.key === whKey)) {
      return json(res, 200, { ok: true, duplicate: true });
    }
    db.payment_webhooks.push({ key: whKey, body, received_at: new Date().toISOString() });
    const payment = db.payments.find(p => p.mpesa_checkout_id === checkoutId);
    if (!payment) { save(db); return json(res, 200, { ok: true, note: 'payment not found' }); }
    if (payment.status === 'SUCCESS') { save(db); return json(res, 200, { ok: true, already_processed: true }); }
    if (resultCode === 0 || resultCode === '0' || body.status === 'SUCCESS') {
      payment.status = 'SUCCESS';
      payment.mpesa_ref = receipt || payment.mpesa_ref;
      payment.completed_at = new Date().toISOString();
      if (payment.contribution_id) {
        const c = db.contributions.find(x => x.id === payment.contribution_id);
        if (c) { c.status = 'SUCCESS'; c.mpesa_ref = payment.mpesa_ref; }
      }
      if (payment.type === 'SUBSCRIPTION') {
        sub.activateFromPayment(db, { chamaId: payment.chama_id, paymentId: payment.id, amount: payment.amount, actorId: payment.user_id });
      }
      audit(db, { actor_id: payment.user_id, action: 'WEBHOOK_PAYMENT_SUCCESS', target_type: 'payment', target_id: payment.id, meta: { receipt } });
    } else {
      payment.status = 'FAILED';
    }
    save(db);
    return json(res, 200, { ok: true });
  }

  // Loans, messages, meetings — same pattern with requireChama
  if (url === '/api/loans' && req.method === 'GET') {
    const ctx = requireChama(false); if (!ctx) return;
    const my_loan = db.loans.find(l => l.chama_id === ctx.chama.id && l.user_id === me.id && l.status === 'ACTIVE') || null;
    const loans = db.loans.filter(l => l.chama_id === ctx.chama.id).map(l => {
      const u = db.users.find(x => x.id === l.user_id);
      return { ...l, name: u && u.name, remaining: l.principal + (l.interest || 0) - (l.amount_repaid || 0) };
    });
    return json(res, 200, { my_loan, loans });
  }

  if (url === '/api/loans/apply' && req.method === 'POST') {
    const ctx = requireChama(true); if (!ctx) return;
    const principal = parseInt(body.amount, 10);
    if (!principal || principal < 1000) return json(res, 400, { error: 'Minimum loan KES 1,000' });
    if (db.loans.find(l => l.chama_id === ctx.chama.id && l.user_id === me.id && l.status === 'ACTIVE')) {
      return json(res, 400, { error: 'You already have an active loan' });
    }
    const id = nextId(db, 'loans');
    const interest = Math.round(principal * 0.1);
    const next = new Date(); next.setMonth(next.getMonth() + 1);
    const loan = { id, chama_id: ctx.chama.id, user_id: me.id, principal, interest, amount_repaid: 0, status: 'ACTIVE', next_payment: next.toISOString().slice(0, 10), created_at: new Date().toISOString() };
    db.loans.push(loan);
    audit(db, { actor_id: me.id, action: 'LOAN_APPLIED', target_type: 'loan', target_id: id, meta: { chama_id: ctx.chama.id, principal }, ip });
    save(db);
    return json(res, 201, { loan, message: 'Loan approved' });
  }

  if (url === '/api/messages' && req.method === 'GET') {
    const ctx = requireChama(false); if (!ctx) return;
    // Tenant isolation: only this chama
    const messages = db.messages.filter(m => m.chama_id === ctx.chama.id).map(m => {
      const u = db.users.find(x => x.id === m.user_id);
      return { id: m.id, body: m.body, created_at: m.created_at, user_id: m.user_id, name: u && u.name, avatar_color: u && u.avatar_color };
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
    return json(res, 201, { message: { ...msg, name: user.name, avatar_color: user.avatar_color } });
  }

  if (url === '/api/meetings' && req.method === 'GET') {
    const ctx = requireChama(false); if (!ctx) return;
    return json(res, 200, { meetings: db.meetings.filter(m => m.chama_id === ctx.chama.id) });
  }

  if (url.match(/^\/api\/meetings\/\d+\/attendance$/) && req.method === 'POST') {
    const ctx = requireChama(true); if (!ctx) return;
    const meetingId = parseInt(url.split('/')[3], 10);
    const meeting = db.meetings.find(m => m.id === meetingId && m.chama_id === ctx.chama.id);
    if (!meeting) return json(res, 404, { error: 'Meeting not found' });
    db.attendance = db.attendance.filter(a => !(a.meeting_id === meetingId && a.user_id === me.id));
    db.attendance.push({ meeting_id: meetingId, user_id: me.id, status: 'present' });
    save(db);
    return json(res, 200, { ok: true });
  }

  // Create chama
  if (url === '/api/chamas' && req.method === 'POST') {
    if (getMembership(db, me.id)) return json(res, 400, { error: 'Already in a chama' });
    const name = String(body.name || '').trim();
    if (!name) return json(res, 400, { error: 'Chama name required' });
    const plan = sub.getPlan(db, db.settings.default_plan_id || 1);
    const id = nextId(db, 'chamas');
    const trialDays = (plan && plan.trial_days) || (db.settings.trial_days) || 14;
    const trialEnd = sub.addDays(new Date().toISOString().slice(0, 10), trialDays);
    const code = name.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) + id;
    const chama = {
      id, name, description: body.description || '', status: 'ACTIVE', suspend_reason: null,
      max_members: plan.max_members, contribution_amount: parseInt(body.contribution_amount, 10) || 2000,
      owner_user_id: me.id, invite_code: code, created_at: new Date().toISOString(), last_active: new Date().toISOString(),
    };
    db.chamas.push(chama);
    const mid = nextId(db, 'members');
    db.members.push({ id: mid, chama_id: id, user_id: me.id, role: 'CHAMA_ADMIN', joined_at: new Date().toISOString(), status: 'ACTIVE' });
    const sid = nextId(db, 'subscriptions');
    db.subscriptions.push({
      id: sid, chama_id: id, plan_id: plan.id, status: trialDays > 0 ? 'TRIAL' : 'ACTIVE',
      started_at: new Date().toISOString(), trial_ends_at: trialDays > 0 ? trialEnd : null,
      current_period_start: new Date().toISOString().slice(0, 10),
      current_period_end: trialEnd, grace_ends_at: null, cancelled_at: null,
      amount: plan.price, currency: plan.currency,
    });
    audit(db, { actor_id: me.id, action: 'CHAMA_CREATED', target_type: 'chama', target_id: id, meta: { name, invite_code: code }, ip });
    save(db);
    return json(res, 201, { chama, invite_code: code, subscription_status: trialDays > 0 ? 'TRIAL' : 'ACTIVE', message: 'Chama created. Invite code: ' + code });
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
    const mid = nextId(db, 'members');
    db.members.push({ id: mid, chama_id: chama.id, user_id: me.id, role: 'MEMBER', joined_at: new Date().toISOString(), status: 'ACTIVE' });
    audit(db, { actor_id: me.id, action: 'CHAMA_JOINED', target_type: 'chama', target_id: chama.id, ip });
    save(db);
    return json(res, 200, { chama: { chama_id: chama.id, chama_name: chama.name, member_role: 'MEMBER' }, message: 'Joined ' + chama.name });
  }

  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const pathname = urlPath(req.url);
  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else if (pathname === '/owner' || pathname.startsWith('/owner/')) {
      fs.readFile(path.join(PUBLIC, 'owner', 'index.html'), (err, data) => {
        if (err) { res.writeHead(404); return res.end('Owner UI missing'); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
    } else {
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
    }
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ChamaHub Kenya PRODUCTION');
  console.log('  App:   http://localhost:' + PORT);
  console.log('  Owner: http://localhost:' + PORT + '/owner');
  console.log('  SUPER_ADMIN: 0700000001 / Owner@2026!');
  console.log('  Chair (dev): 0723456789 / 1234');
  console.log('');
});
