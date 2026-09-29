const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin) + 'chamahub-v4').digest('hex');
}

function load() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (_) {}
  return null;
}

function save(data) {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function nextId(data, key) {
  data.seq[key] = (data.seq[key] || 0) + 1;
  return data.seq[key];
}

function defaultPlans() {
  return [
    { id: 1, name: 'Starter', price: 500, currency: 'KES', billing_cycle: 'monthly', max_members: 15, trial_days: 14, description: 'Small chama — up to 15 members', features: ['contributions', 'loans', 'chat', 'meetings'], active: true, sort_order: 1 },
    { id: 2, name: 'Growth', price: 1000, currency: 'KES', billing_cycle: 'monthly', max_members: 30, trial_days: 14, description: 'Growing groups — up to 30 members', features: ['contributions', 'loans', 'chat', 'meetings', 'reports'], active: true, sort_order: 2 },
    { id: 3, name: 'Pro', price: 2000, currency: 'KES', billing_cycle: 'monthly', max_members: 50, trial_days: 14, description: 'Established chamas — up to 50 members', features: ['contributions', 'loans', 'chat', 'meetings', 'reports', 'exports'], active: true, sort_order: 3 },
    { id: 4, name: 'Enterprise', price: 5000, currency: 'KES', billing_cycle: 'monthly', max_members: 200, trial_days: 7, description: 'Large networks — up to 200 members', features: ['all'], active: true, sort_order: 4 },
  ];
}

function seed() {
  const pin = hashPin('1234');
  const ownerPin = hashPin('Owner@2026!');
  const periodEnd = new Date();
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  const data = {
    users: [
      { id: 1, phone: '0700000001', pin_hash: ownerPin, name: 'Platform Owner', email: 'owner@chamahub.co.ke', platform_role: 'SUPER_ADMIN', status: 'ACTIVE', avatar_color: '#C9A227', created_at: '2026-01-01T00:00:00Z', last_login: null },
      { id: 2, phone: '0723456789', pin_hash: pin, name: 'Alex Kamau', email: null, platform_role: 'USER', status: 'ACTIVE', avatar_color: '#1A7A5C', created_at: '2026-01-15T10:00:00Z', last_login: null },
      { id: 3, phone: '0712345678', pin_hash: pin, name: 'Jane Mwangi', email: null, platform_role: 'USER', status: 'ACTIVE', avatar_color: '#0D5C45', created_at: '2026-01-15T10:00:00Z', last_login: null },
      { id: 4, phone: '0734567890', pin_hash: pin, name: 'Grace Wanjiku', email: null, platform_role: 'USER', status: 'ACTIVE', avatar_color: '#C9A227', created_at: '2026-01-15T10:00:00Z', last_login: null },
      { id: 5, phone: '0745678901', pin_hash: pin, name: 'David Ochieng', email: null, platform_role: 'USER', status: 'ACTIVE', avatar_color: '#2E9B78', created_at: '2026-02-01T10:00:00Z', last_login: null },
      { id: 6, phone: '0756789012', pin_hash: pin, name: 'Sarah Njeri', email: null, platform_role: 'USER', status: 'ACTIVE', avatar_color: '#0A3D2E', created_at: '2026-02-10T10:00:00Z', last_login: null },
    ],
    chamas: [{
      id: 1,
      name: 'Umoja Savings',
      description: 'Community savings group',
      status: 'ACTIVE',
      suspend_reason: null,
      max_members: 15,
      contribution_amount: 2000,
      owner_user_id: 2,
      invite_code: 'UMOJA2026',
      payment_methods: [
        { id: 1, type: 'MPESA_PHONE', label: 'M-Pesa to Treasurer', details: '0712345678 (Jane Mwangi)', instructions: 'Send via M-Pesa. Put your name in the message.', is_default: true },
        { id: 2, type: 'MPESA_TILL', label: 'Buy Goods Till', details: 'Till 562891', instructions: 'Lipa na M-Pesa → Buy Goods → 562891', is_default: false },
        { id: 3, type: 'BANK', label: 'Co-op Bank', details: 'Account 0110XXXXXX', instructions: 'Use your full name as reference', is_default: false },
        { id: 4, type: 'CASH', label: 'Cash at meeting', details: 'Hand to Treasurer', instructions: 'Bring exact amount to monthly meeting', is_default: false },
      ],
      created_at: '2026-01-15T10:00:00Z',
      last_active: new Date().toISOString(),
    }],
    members: [
      { id: 1, chama_id: 1, user_id: 2, role: 'CHAMA_ADMIN', joined_at: '2026-01-15T10:00:00Z', status: 'ACTIVE' },
      { id: 2, chama_id: 1, user_id: 3, role: 'TREASURER', joined_at: '2026-01-15T10:00:00Z', status: 'ACTIVE' },
      { id: 3, chama_id: 1, user_id: 4, role: 'SECRETARY', joined_at: '2026-01-15T10:00:00Z', status: 'ACTIVE' },
      { id: 4, chama_id: 1, user_id: 5, role: 'MEMBER', joined_at: '2026-02-01T10:00:00Z', status: 'ACTIVE' },
      { id: 5, chama_id: 1, user_id: 6, role: 'MEMBER', joined_at: '2026-02-10T10:00:00Z', status: 'ACTIVE' },
    ],
    plans: defaultPlans(),
    subscriptions: [{
      id: 1, chama_id: 1, plan_id: 1, status: 'ACTIVE',
      started_at: '2026-01-15T10:00:00Z', trial_ends_at: null,
      current_period_start: new Date().toISOString().slice(0, 10),
      current_period_end: periodEnd.toISOString().slice(0, 10),
      grace_ends_at: null, cancelled_at: null, amount: 500, currency: 'KES',
    }],
    contributions: [
      { id: 1, chama_id: 1, user_id: 3, amount: 2000, status: 'SUCCESS', method: 'MPESA_PHONE', payment_method_id: 1, payment_method_label: 'M-Pesa to Treasurer', mpesa_ref: 'QK7A2B9C', recorded_by: 3, confirmed_by: 3, confirmed_at: '2026-09-28T10:00:00Z', created_at: '2026-09-28T09:00:00Z' },
      { id: 2, chama_id: 1, user_id: 2, amount: 2000, status: 'SUCCESS', method: 'MPESA_PHONE', payment_method_id: 1, payment_method_label: 'M-Pesa to Treasurer', mpesa_ref: 'QK8C3D1E', recorded_by: 2, confirmed_by: 3, confirmed_at: '2026-09-27T10:00:00Z', created_at: '2026-09-27T09:00:00Z' },
      { id: 3, chama_id: 1, user_id: 5, amount: 2000, status: 'SUCCESS', method: 'MPESA_TILL', payment_method_id: 2, payment_method_label: 'Buy Goods Till', mpesa_ref: 'QK9F4G2H', recorded_by: 5, confirmed_by: 3, confirmed_at: '2026-09-26T10:00:00Z', created_at: '2026-09-26T09:00:00Z' },
    ],
    loans: [
      { id: 1, chama_id: 1, user_id: 5, principal: 10000, interest: 1000, amount_repaid: 3000, status: 'ACTIVE', next_payment: '2026-10-20', created_at: '2026-08-20T10:00:00Z' },
    ],
    messages: [
      { id: 1, chama_id: 1, user_id: 2, body: 'Welcome to Umoja Savings!', created_at: '2026-09-28T08:00:00Z' },
      { id: 2, chama_id: 1, user_id: 3, body: 'Contribution due this Friday. Pay to 0712345678 then record in the app.', created_at: '2026-09-28T09:00:00Z' },
    ],
    meetings: [
      { id: 1, chama_id: 1, title: 'Monthly Meeting', description: 'Contribution review', meeting_at: '2026-10-03T19:00:00Z', location: 'Online' },
    ],
    payments: [],
    payment_webhooks: [],
    attendance: [],
    audit_logs: [],
    notifications: [],
    settings: {
      platform_name: 'ChamaHub Kenya',
      support_email: 'support@chamahub.co.ke',
      support_phone: '+254700000000',
      currency: 'KES',
      trial_days: 14,
      grace_days: 3,
      default_plan_id: 1,
      maintenance_mode: false,
      maintenance_message: 'ChamaHub is temporarily unavailable. Your data is safe.',
    },
    payment_method_seq: 4,
    seq: { users: 6, chamas: 1, members: 5, contributions: 3, loans: 1, messages: 2, meetings: 1, payments: 0, subscriptions: 1, plans: 4, audit_logs: 0 },
  };
  save(data);
  return data;
}

function getDb() {
  let data = load();
  if (!data) data = seed();
  if (!data.plans) data.plans = defaultPlans();
  if (!data.seq) data.seq = {};
  if (!data.audit_logs) data.audit_logs = [];
  if (!data.settings) data.settings = { trial_days: 14, grace_days: 3, maintenance_mode: false };
  if (data.payment_method_seq == null) data.payment_method_seq = 0;
  data.chamas.forEach(c => {
    if (!Array.isArray(c.payment_methods)) c.payment_methods = [];
    if (!c.payment_methods.length) {
      data.payment_method_seq += 1;
      c.payment_methods.push({
        id: data.payment_method_seq,
        type: 'MPESA_PHONE',
        label: 'M-Pesa (update this)',
        details: 'Ask Treasurer for number',
        instructions: 'Chair: open Chama tab → Add payment method with your real number.',
        is_default: true,
      });
    }
    if (!c.status) c.status = 'ACTIVE';
  });
  return data;
}

function audit(data, entry) {
  const id = nextId(data, 'audit_logs');
  data.audit_logs.push({
    id,
    actor_id: entry.actor_id || null,
    action: entry.action,
    target_type: entry.target_type || null,
    target_id: entry.target_id || null,
    meta: entry.meta || {},
    ip: entry.ip || null,
    created_at: new Date().toISOString(),
  });
}

module.exports = { getDb, save, hashPin, nextId, seed, audit, defaultPlans };
