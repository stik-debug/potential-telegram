/**
 * ChamaHub Kenya — Production data layer (JSON file store)
 * Schema supports multi-tenant SaaS: plans, subscriptions lifecycle,
 * payments, audit logs, platform settings. Demo seed is DEV only.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
const IS_PROD = process.env.NODE_ENV === 'production';

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin) + (process.env.PIN_SALT || 'chamahub-salt-v2')).digest('hex');
}

function load() {
  if (!fs.existsSync(DB_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return null; }
}

function save(data) {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function defaultSettings() {
  return {
    platform_name: 'ChamaHub Kenya',
    support_email: 'support@chamahub.co.ke',
    support_phone: '+254700000000',
    currency: 'KES',
    trial_days: 14,
    grace_days: 3,
    default_plan_id: 1,
    maintenance_mode: false,
    maintenance_message: 'ChamaHub is temporarily unavailable for scheduled maintenance. Your data is safe.',
  };
}

function defaultPlans() {
  return [
    {
      id: 1,
      name: 'Starter',
      price: 500,
      currency: 'KES',
      billing_cycle: 'monthly',
      max_members: 15,
      trial_days: 14,
      features: ['contributions', 'loans', 'chat', 'meetings', 'basic_reports'],
      description: 'Small chama — up to 15 members',
      active: true,
      sort_order: 1,
    },
    {
      id: 2,
      name: 'Growth',
      price: 1000,
      currency: 'KES',
      billing_cycle: 'monthly',
      max_members: 30,
      trial_days: 14,
      features: ['contributions', 'loans', 'chat', 'meetings', 'reports', 'fines', 'announcements'],
      description: 'Growing groups — up to 30 members',
      active: true,
      sort_order: 2,
    },
    {
      id: 3,
      name: 'Pro',
      price: 2000,
      currency: 'KES',
      billing_cycle: 'monthly',
      max_members: 50,
      trial_days: 14,
      features: ['contributions', 'loans', 'chat', 'meetings', 'reports', 'fines', 'announcements', 'exports', 'priority_support'],
      description: 'Established chamas — up to 50 members',
      active: true,
      sort_order: 3,
    },
    {
      id: 4,
      name: 'Enterprise',
      price: 5000,
      currency: 'KES',
      billing_cycle: 'monthly',
      max_members: 200,
      trial_days: 7,
      features: ['contributions', 'loans', 'chat', 'meetings', 'reports', 'fines', 'announcements', 'exports', 'priority_support', 'multi_admin', 'api_access', 'custom_branding'],
      description: 'Large networks & federations — up to 200 members',
      active: true,
      sort_order: 4,
    },
  ];
}

function seed() {
  // Development seed only — production starts empty except super admin
  const pin = hashPin('1234');
  const ownerPin = hashPin(process.env.OWNER_PIN || 'Owner@2026!');

  const users = [
    { id: 1, phone: '0700000001', pin_hash: ownerPin, name: 'Platform Owner', email: 'owner@chamahub.co.ke', platform_role: 'SUPER_ADMIN', status: 'ACTIVE', avatar_color: '#C9A227', created_at: '2026-01-01T00:00:00Z', last_login: null },
  ];

  if (!IS_PROD) {
    users.push(
      { id: 2, phone: '0723456789', pin_hash: pin, name: 'Alex Kamau', email: 'alex@example.com', platform_role: 'USER', status: 'ACTIVE', avatar_color: '#1A7A5C', created_at: '2026-01-15T10:00:00Z', last_login: null },
      { id: 3, phone: '0712345678', pin_hash: pin, name: 'Jane Mwangi', email: 'jane@example.com', platform_role: 'USER', status: 'ACTIVE', avatar_color: '#0D5C45', created_at: '2026-01-15T10:00:00Z', last_login: null },
      { id: 4, phone: '0734567890', pin_hash: pin, name: 'Grace Wanjiku', email: null, platform_role: 'USER', status: 'ACTIVE', avatar_color: '#C9A227', created_at: '2026-01-15T10:00:00Z', last_login: null },
      { id: 5, phone: '0745678901', pin_hash: pin, name: 'David Ochieng', email: null, platform_role: 'USER', status: 'ACTIVE', avatar_color: '#2E9B78', created_at: '2026-02-01T10:00:00Z', last_login: null },
      { id: 6, phone: '0756789012', pin_hash: pin, name: 'Sarah Njeri', email: null, platform_role: 'USER', status: 'ACTIVE', avatar_color: '#0A3D2E', created_at: '2026-02-10T10:00:00Z', last_login: null },
    );
  }

  const plans = defaultPlans();
  const settings = defaultSettings();

  const chamas = [];
  const members = [];
  const subscriptions = [];
  const contributions = [];
  const loans = [];
  const messages = [];
  const meetings = [];

  if (!IS_PROD) {
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 10);
    const activeEnd = new Date();
    activeEnd.setMonth(activeEnd.getMonth() + 1);

    chamas.push({
      id: 1,
      name: 'Umoja Savings',
      description: 'Community savings group',
      status: 'ACTIVE', // platform-level: ACTIVE | SUSPENDED
      suspend_reason: null,
      max_members: 15,
      contribution_amount: 2000,
      owner_user_id: 2,
      invite_code: 'UMOJA2026',
      payment_methods: [
        { id: 1, type: 'MPESA_PHONE', label: 'M-Pesa to Treasurer', details: '0712345678 (Jane Mwangi)', instructions: 'Send contribution via M-Pesa to this number. Use your name as the message.', is_default: true },
        { id: 2, type: 'MPESA_TILL', label: 'Buy Goods Till', details: 'Till 562891', instructions: 'Use Lipa na M-Pesa → Buy Goods → Till 562891.', is_default: false },
        { id: 3, type: 'BANK', label: 'Co-op Bank', details: 'Account 0110XXXXXX · Co-operative Bank', instructions: 'Bank transfer. Use your full name as reference.', is_default: false },
        { id: 4, type: 'CASH', label: 'Cash at meeting', details: 'Hand to Treasurer at monthly meeting', instructions: 'Bring exact amount. Treasurer will confirm in the app.', is_default: false },
      ],
      created_at: '2026-01-15T10:00:00Z',
      last_active: new Date().toISOString(),
    });

    members.push(
      { id: 1, chama_id: 1, user_id: 2, role: 'CHAMA_ADMIN', joined_at: '2026-01-15T10:00:00Z', status: 'ACTIVE' },
      { id: 2, chama_id: 1, user_id: 3, role: 'TREASURER', joined_at: '2026-01-15T10:00:00Z', status: 'ACTIVE' },
      { id: 3, chama_id: 1, user_id: 4, role: 'SECRETARY', joined_at: '2026-01-15T10:00:00Z', status: 'ACTIVE' },
      { id: 4, chama_id: 1, user_id: 5, role: 'MEMBER', joined_at: '2026-02-01T10:00:00Z', status: 'ACTIVE' },
      { id: 5, chama_id: 1, user_id: 6, role: 'MEMBER', joined_at: '2026-02-10T10:00:00Z', status: 'ACTIVE' },
    );

    subscriptions.push({
      id: 1,
      chama_id: 1,
      plan_id: 1,
      status: 'ACTIVE', // TRIAL | ACTIVE | PAST_DUE | GRACE_PERIOD | EXPIRED | SUSPENDED | CANCELLED
      started_at: '2026-01-15T10:00:00Z',
      trial_ends_at: null,
      current_period_start: new Date().toISOString().slice(0, 10),
      current_period_end: activeEnd.toISOString().slice(0, 10),
      grace_ends_at: null,
      cancelled_at: null,
      amount: 500,
      currency: 'KES',
    });

    const refs = ['QK7A2B9C', 'QK8C3D1E', 'QK9F4G2H', 'QK1J5K3L', 'QK2M6N4P'];
    [3, 2, 4, 5, 6].forEach((uid, i) => {
      contributions.push({
        id: i + 1, chama_id: 1, user_id: uid, amount: 2000, status: 'SUCCESS',
        method: 'MPESA', mpesa_ref: refs[i], recorded_by: uid,
        created_at: `2026-09-${20 + i}T10:00:00Z`,
      });
    });

    loans.push({
      id: 1, chama_id: 1, user_id: 5, principal: 10000, interest: 1000,
      amount_repaid: 3000, status: 'ACTIVE', next_payment: '2026-10-20',
      created_at: '2026-08-20T10:00:00Z',
    });

    messages.push(
      { id: 1, chama_id: 1, user_id: 2, body: 'Welcome to Umoja Savings!', created_at: '2026-09-28T08:00:00Z' },
      { id: 2, chama_id: 1, user_id: 3, body: 'Contribution due this Friday.', created_at: '2026-09-28T09:00:00Z' },
    );

    meetings.push({
      id: 1, chama_id: 1, title: 'Monthly Meeting', description: 'Review contributions',
      meeting_at: '2026-10-03T19:00:00Z', location: 'Online',
    });
  }

  const data = {
    users,
    chamas,
    members,
    plans,
    subscriptions,
    payments: [],
    payment_webhooks: [],
    contributions,
    loans,
    loan_repayments: [],
    fines: [],
    messages,
    meetings,
    attendance: [],
    announcements: [],
    notifications: [],
    invites: [],
    payment_method_seq: 4,
    audit_logs: [],
    support_tickets: [],
    settings,
    seq: {
      users: users.length,
      chamas: chamas.length,
      members: members.length,
      subscriptions: subscriptions.length,
      payments: 0,
      contributions: contributions.length,
      loans: loans.length,
      messages: messages.length,
      meetings: meetings.length,
      audit_logs: 0,
      notifications: 0,
      support_tickets: 0,
      plans: plans.length,
    },
  };
  save(data);
  return data;
}

function migrate(data) {
  // Bring older DB shapes forward
  if (!data.plans) data.plans = defaultPlans();
  // Merge any missing default plans by id (never wipe custom plans)
  const defaults = defaultPlans();
  defaults.forEach(dp => {
    if (!data.plans.find(p => p.id === dp.id)) data.plans.push(dp);
  });
  data.seq.plans = Math.max(data.seq.plans || 0, ...data.plans.map(p => p.id));
  if (!data.subscriptions) data.subscriptions = [];
  if (!data.audit_logs) data.audit_logs = [];
  if (!data.settings) data.settings = defaultSettings();
  if (!data.notifications) data.notifications = [];
  if (!data.support_tickets) data.support_tickets = [];
  if (!data.payment_webhooks) data.payment_webhooks = [];
  if (!data.loan_repayments) data.loan_repayments = [];
  if (!data.fines) data.fines = [];
  if (!data.announcements) data.announcements = [];
  data.chamas.forEach(c => {
    if (!c.payment_methods) c.payment_methods = [];
    // If chama has no methods, seed a placeholder so UI is never empty for first-time deploy
    if (c.payment_methods.length === 0) {
      data.payment_method_seq = (data.payment_method_seq || 0) + 1;
      c.payment_methods.push({
        id: data.payment_method_seq,
        type: 'MPESA_PHONE',
        label: 'M-Pesa (set by Treasurer)',
        details: 'Ask Treasurer for the number',
        instructions: 'Chair/Treasurer: replace this with your real M-Pesa number, till or bank on the Chama tab.',
        is_default: true,
      });
    }
  });
  if (data.payment_method_seq == null) data.payment_method_seq = 0;
  if (!data.seq) data.seq = {};

  // Normalize user roles
  data.users.forEach(u => {
    if (!u.platform_role) {
      u.platform_role = (u.role === 'superadmin' || u.role === 'SUPER_ADMIN') ? 'SUPER_ADMIN' : 'USER';
    }
    if (!u.status) u.status = 'ACTIVE';
  });

  // Normalize member roles
  const roleMap = {
    chair: 'CHAMA_ADMIN', treasurer: 'TREASURER', secretary: 'SECRETARY',
    member: 'MEMBER', CHAMA_ADMIN: 'CHAMA_ADMIN', TREASURER: 'TREASURER',
    SECRETARY: 'SECRETARY', MEMBER: 'MEMBER',
  };
  data.members.forEach(m => {
    m.role = roleMap[m.role] || m.role || 'MEMBER';
    if (!m.status) m.status = 'ACTIVE';
  });

  // Ensure each chama has a subscription row
  data.chamas.forEach(c => {
    if (!c.status) c.status = c.subscription_status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE';
    const hasSub = data.subscriptions.some(s => s.chama_id === c.id);
    if (!hasSub) {
      const end = c.subscription_next || new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
      const st = (c.subscription_status || 'ACTIVE').toUpperCase();
      const status = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'EXPIRED', 'SUSPENDED', 'CANCELLED'].includes(st) ? st : 'ACTIVE';
      data.subscriptions.push({
        id: nextId(data, 'subscriptions'),
        chama_id: c.id,
        plan_id: 1,
        status,
        started_at: c.created_at || new Date().toISOString(),
        trial_ends_at: null,
        current_period_start: new Date().toISOString().slice(0, 10),
        current_period_end: end,
        grace_ends_at: null,
        cancelled_at: null,
        amount: 500,
        currency: 'KES',
      });
    }
    if (!c.invite_code) c.invite_code = 'CHAMA' + c.id;
    if (c.max_members == null) {
      const plan = data.plans.find(p => p.id === 1);
      c.max_members = plan ? plan.max_members : 15;
    }
  });

  // Normalize contribution status
  data.contributions.forEach(c => {
    if (c.status === 'completed') c.status = 'SUCCESS';
    if (c.status === 'pending') c.status = 'PENDING';
    if (!c.method) c.method = c.mpesa_ref ? 'MPESA' : 'MANUAL';
  });

  return data;
}

function getDb() {
  let data = load();
  if (!data) data = seed();
  else data = migrate(data);
  return data;
}

function nextId(data, key) {
  data.seq[key] = (data.seq[key] || 0) + 1;
  return data.seq[key];
}

function audit(data, { actor_id, action, target_type, target_id, meta, ip }) {
  const id = nextId(data, 'audit_logs');
  data.audit_logs.push({
    id,
    actor_id: actor_id || null,
    action,
    target_type: target_type || null,
    target_id: target_id || null,
    meta: meta || {},
    ip: ip || null,
    created_at: new Date().toISOString(),
  });
  return id;
}

module.exports = { getDb, save, hashPin, nextId, seed, audit, defaultPlans, defaultSettings, IS_PROD };
