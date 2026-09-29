const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const {
  authRequired, requireChamaAccess, getMembership, canManage, canConfirm,
  audit, normalizePhone,
} = require('../middleware/auth');

const router = express.Router();
const COLORS = ['#0D5C45', '#1A7A5C', '#C9A227', '#2E9B78', '#0A3D2E'];

function memberLimit(chamaId) {
  const row = db.prepare(`
    SELECT COALESCE(c.max_members, p.max_members, 15) AS lim
    FROM chamas c
    LEFT JOIN subscriptions s ON s.chama_id = c.id
    LEFT JOIN plans p ON p.id = s.plan_id
    WHERE c.id = ?
  `).get(chamaId);
  return row ? row.lim : 15;
}

// Dashboard
router.get('/dashboard', authRequired, requireChamaAccess(), (req, res) => {
  const cid = req.membership.chama_id;
  const success = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total FROM contributions
    WHERE chama_id = ? AND status = 'SUCCESS'
  `).get(cid).total;

  const month = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total FROM contributions
    WHERE chama_id = ? AND status = 'SUCCESS'
      AND created_at >= date('now', 'start of month')
  `).get(cid).total;

  const loans = db.prepare(`
    SELECT COALESCE(SUM(principal + interest - amount_repaid),0) AS total FROM loans
    WHERE chama_id = ? AND status = 'ACTIVE'
  `).get(cid).total;

  const member_count = db.prepare(`
    SELECT COUNT(*) AS c FROM chama_members WHERE chama_id = ? AND status = 'ACTIVE'
  `).get(cid).c;

  const pending_count = db.prepare(`
    SELECT COUNT(*) AS c FROM contributions WHERE chama_id = ? AND status = 'PENDING'
  `).get(cid).c;

  const my_contributions = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total FROM contributions
    WHERE chama_id = ? AND user_id = ? AND status = 'SUCCESS'
  `).get(cid, req.user.id).total;

  const my_loan = db.prepare(`
    SELECT * FROM loans WHERE chama_id = ? AND user_id = ? AND status = 'ACTIVE'
  `).get(cid, req.user.id) || null;

  const recent = db.prepare(`
    SELECT c.*, u.name FROM contributions c
    JOIN users u ON u.id = c.user_id
    WHERE c.chama_id = ? AND c.status = 'SUCCESS'
    ORDER BY c.created_at DESC LIMIT 10
  `).all(cid);

  const lim = memberLimit(cid);

  res.json({
    chama: {
      id: cid,
      name: req.membership.chama_name,
      max_members: lim,
      contribution_amount: req.membership.contribution_amount,
      invite_code: req.membership.invite_code,
    },
    subscription: req.subscription,
    total_savings: success,
    month_contributions: month,
    outstanding_loans: loans,
    member_count,
    pending_count,
    my_contributions,
    my_loan,
    recent_contributions: recent,
    member_role: req.membership.role,
    can_manage: canManage(req.membership.role),
    can_confirm: canConfirm(req.membership.role),
  });
});

// Members
router.get('/members', authRequired, requireChamaAccess(), (req, res) => {
  const cid = req.membership.chama_id;
  const members = db.prepare(`
    SELECT u.id, u.name, u.phone, u.avatar_color, m.role, m.joined_at,
      (SELECT COALESCE(SUM(amount),0) FROM contributions
       WHERE user_id = u.id AND chama_id = m.chama_id AND status = 'SUCCESS') AS total_contributed
    FROM chama_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.chama_id = ? AND m.status = 'ACTIVE'
    ORDER BY
      CASE m.role WHEN 'CHAMA_ADMIN' THEN 1 WHEN 'TREASURER' THEN 2 WHEN 'SECRETARY' THEN 3 ELSE 4 END,
      u.name
  `).all(cid);

  res.json({
    members,
    invite_code: req.membership.invite_code,
    can_manage: canManage(req.membership.role),
    max_members: memberLimit(cid),
    member_count: members.length,
  });
});

router.post('/members/add', authRequired, requireChamaAccess({ write: true }), (req, res) => {
  if (!canManage(req.membership.role)) {
    return res.status(403).json({ error: 'Only Chair, Treasurer or Secretary can add members' });
  }
  const cid = req.membership.chama_id;
  const lim = memberLimit(cid);
  const count = db.prepare(`SELECT COUNT(*) AS c FROM chama_members WHERE chama_id = ? AND status = 'ACTIVE'`).get(cid).c;
  if (count >= lim) return res.status(400).json({ error: 'Member limit reached (' + lim + ')' });

  const phone = normalizePhone(req.body.phone);
  const name = String(req.body.name || '').trim();
  let role = String(req.body.role || 'MEMBER').toUpperCase();
  if (!['MEMBER', 'TREASURER', 'SECRETARY'].includes(role)) role = 'MEMBER';
  if (!phone || !name) return res.status(400).json({ error: 'Name and phone required' });

  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) {
    const pin_hash = bcrypt.hashSync('1234', 10);
    const info = db.prepare(`
      INSERT INTO users (phone, pin_hash, name, platform_role, status, avatar_color)
      VALUES (?, ?, ?, 'USER', 'ACTIVE', ?)
    `).run(phone, pin_hash, name, COLORS[count % COLORS.length]);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  } else {
    const existing = db.prepare(`
      SELECT id FROM chama_members WHERE user_id = ? AND status = 'ACTIVE'
    `).get(user.id);
    if (existing) return res.status(409).json({ error: 'This phone is already in a chama' });
  }

  db.prepare(`
    INSERT INTO chama_members (chama_id, user_id, role, status) VALUES (?, ?, ?, 'ACTIVE')
  `).run(cid, user.id, role);

  audit(req.user.id, 'MEMBER_ADDED', 'user', user.id, { chama_id: cid, role }, req.ip);

  res.status(201).json({
    member: { id: user.id, name: user.name, phone: user.phone, role, total_contributed: 0, avatar_color: user.avatar_color },
    message: name + ' added. They can log in with ' + phone + ' and PIN 1234',
  });
});

router.post('/members/remove', authRequired, requireChamaAccess({ write: true }), (req, res) => {
  if (!canManage(req.membership.role)) return res.status(403).json({ error: 'Not allowed' });
  const targetId = parseInt(req.body.user_id, 10);
  if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot remove yourself' });
  const target = db.prepare(`
    SELECT * FROM chama_members WHERE chama_id = ? AND user_id = ? AND status = 'ACTIVE'
  `).get(req.membership.chama_id, targetId);
  if (!target) return res.status(404).json({ error: 'Member not found' });
  if (target.role === 'CHAMA_ADMIN') return res.status(400).json({ error: 'Cannot remove Chair' });
  db.prepare(`UPDATE chama_members SET status = 'REMOVED' WHERE id = ?`).run(target.id);
  audit(req.user.id, 'MEMBER_REMOVED', 'user', targetId, { chama_id: req.membership.chama_id }, req.ip);
  res.json({ ok: true });
});

// Payment methods
router.get('/payment-methods', authRequired, requireChamaAccess(), (req, res) => {
  const methods = db.prepare(`
    SELECT * FROM payment_methods WHERE chama_id = ? ORDER BY is_default DESC, id
  `).all(req.membership.chama_id);
  res.json({
    methods,
    disclaimer: 'ChamaHub does not collect or process contribution money. Pay using your chama method, then record it here.',
  });
});

router.post('/payment-methods', authRequired, requireChamaAccess({ write: true }), (req, res) => {
  if (!canManage(req.membership.role)) {
    return res.status(403).json({ error: 'Only officials can manage payment methods' });
  }
  const label = String(req.body.label || '').trim();
  const details = String(req.body.details || '').trim();
  if (!label || !details) return res.status(400).json({ error: 'Label and details required' });
  const cid = req.membership.chama_id;
  const isDefault = req.body.is_default ? 1 : 0;
  if (isDefault) {
    db.prepare('UPDATE payment_methods SET is_default = 0 WHERE chama_id = ?').run(cid);
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM payment_methods WHERE chama_id = ?').get(cid).c;
  const info = db.prepare(`
    INSERT INTO payment_methods (chama_id, type, label, details, instructions, is_default)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    cid,
    String(req.body.type || 'OTHER').toUpperCase(),
    label,
    details,
    String(req.body.instructions || '').trim(),
    isDefault || (count === 0 ? 1 : 0)
  );
  const method = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ method });
});

router.delete('/payment-methods/:id', authRequired, requireChamaAccess({ write: true }), (req, res) => {
  if (!canManage(req.membership.role)) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM payment_methods WHERE id = ? AND chama_id = ?')
    .run(parseInt(req.params.id, 10), req.membership.chama_id);
  res.json({ ok: true });
});

// Contributions — ledger only
router.get('/contributions', authRequired, requireChamaAccess(), (req, res) => {
  const cid = req.membership.chama_id;
  const list = db.prepare(`
    SELECT c.*, u.name,
      CASE WHEN c.user_id = ? THEN 1 ELSE 0 END AS is_mine
    FROM contributions c
    JOIN users u ON u.id = c.user_id
    WHERE c.chama_id = ?
    ORDER BY c.created_at DESC
  `).all(req.user.id, cid);

  const success = list.filter(c => c.status === 'SUCCESS');
  res.json({
    contributions: list,
    total: success.reduce((s, c) => s + c.amount, 0),
    mine: success.filter(c => c.is_mine).reduce((s, c) => s + c.amount, 0),
    count: success.length,
    pending_count: list.filter(c => c.status === 'PENDING').length,
    can_confirm: canConfirm(req.membership.role),
  });
});

router.post('/contributions/record', authRequired, requireChamaAccess({ write: true }), (req, res) => {
  const amt = parseInt(req.body.amount, 10);
  if (!amt || amt < 1) return res.status(400).json({ error: 'Enter a valid amount' });

  const cid = req.membership.chama_id;
  const methods = db.prepare('SELECT * FROM payment_methods WHERE chama_id = ?').all(cid);
  const methodId = req.body.payment_method_id != null ? parseInt(req.body.payment_method_id, 10) : null;
  const method = methods.find(m => m.id === methodId) || methods.find(m => m.is_default) || methods[0] || null;

  if (!method) {
    return res.status(400).json({
      error: 'No payment methods set. Ask Chair/Treasurer to add how members should pay (Chama tab).',
    });
  }

  const auto = canConfirm(req.membership.role) && req.body.confirm_now === true;
  const status = auto ? 'SUCCESS' : 'PENDING';
  const reference = String(req.body.reference || '').trim() || null;

  const info = db.prepare(`
    INSERT INTO contributions (
      chama_id, user_id, amount, status, method, payment_method_id, payment_method_label,
      reference, recorded_by, confirmed_by, confirmed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cid, req.user.id, amt, status,
    method.type, method.id, method.label, reference, req.user.id,
    auto ? req.user.id : null,
    auto ? new Date().toISOString() : null
  );

  const row = db.prepare(`
    SELECT c.*, u.name FROM contributions c JOIN users u ON u.id = c.user_id WHERE c.id = ?
  `).get(info.lastInsertRowid);

  audit(req.user.id, 'CONTRIBUTION_REPORTED', 'contribution', row.id, { amount: amt, status }, req.ip);

  res.status(201).json({
    contribution: row,
    message: status === 'SUCCESS'
      ? 'Contribution recorded and confirmed on the ledger.'
      : 'Submitted. Treasurer will confirm after verifying payment outside the app.',
  });
});

router.post('/contributions/confirm', authRequired, requireChamaAccess({ write: true }), (req, res) => {
  if (!canConfirm(req.membership.role)) {
    return res.status(403).json({ error: 'Only Chair or Treasurer can confirm' });
  }
  const id = parseInt(req.body.contribution_id, 10);
  const c = db.prepare('SELECT * FROM contributions WHERE id = ? AND chama_id = ?')
    .get(id, req.membership.chama_id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  db.prepare(`
    UPDATE contributions SET status = 'SUCCESS', confirmed_by = ?, confirmed_at = datetime('now'),
      reference = COALESCE(?, reference)
    WHERE id = ?
  `).run(req.user.id, req.body.reference || null, id);
  audit(req.user.id, 'CONTRIBUTION_CONFIRMED', 'contribution', id, { amount: c.amount }, req.ip);
  const row = db.prepare('SELECT * FROM contributions WHERE id = ?').get(id);
  res.json({ contribution: row, message: 'Confirmed on ledger' });
});

router.post('/contributions/reject', authRequired, requireChamaAccess({ write: true }), (req, res) => {
  if (!canConfirm(req.membership.role)) return res.status(403).json({ error: 'Not allowed' });
  const id = parseInt(req.body.contribution_id, 10);
  const c = db.prepare('SELECT * FROM contributions WHERE id = ? AND chama_id = ?')
    .get(id, req.membership.chama_id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  db.prepare(`
    UPDATE contributions SET status = 'REJECTED', confirmed_by = ?, confirmed_at = datetime('now'),
      note = COALESCE(?, note)
    WHERE id = ?
  `).run(req.user.id, req.body.reason || null, id);
  res.json({ contribution: db.prepare('SELECT * FROM contributions WHERE id = ?').get(id) });
});

// Messages
router.get('/messages', authRequired, requireChamaAccess(), (req, res) => {
  const messages = db.prepare(`
    SELECT m.*, u.name FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.chama_id = ?
    ORDER BY m.created_at ASC
  `).all(req.membership.chama_id);
  res.json({ messages });
});

router.post('/messages', authRequired, requireChamaAccess({ write: true }), (req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message required' });
  const info = db.prepare(`
    INSERT INTO messages (chama_id, user_id, body) VALUES (?, ?, ?)
  `).run(req.membership.chama_id, req.user.id, body);
  const message = db.prepare(`
    SELECT m.*, u.name FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?
  `).get(info.lastInsertRowid);
  res.status(201).json({ message });
});

// Loans
router.get('/loans', authRequired, requireChamaAccess(), (req, res) => {
  const my_loan = db.prepare(`
    SELECT * FROM loans WHERE chama_id = ? AND user_id = ? AND status = 'ACTIVE'
  `).get(req.membership.chama_id, req.user.id) || null;
  const loans = db.prepare('SELECT * FROM loans WHERE chama_id = ?').all(req.membership.chama_id);
  res.json({ my_loan, loans });
});

router.post('/loans/apply', authRequired, requireChamaAccess({ write: true }), (req, res) => {
  const principal = parseInt(req.body.amount, 10);
  if (!principal || principal < 1000) return res.status(400).json({ error: 'Minimum loan KES 1,000' });
  const existing = db.prepare(`
    SELECT id FROM loans WHERE chama_id = ? AND user_id = ? AND status = 'ACTIVE'
  `).get(req.membership.chama_id, req.user.id);
  if (existing) return res.status(400).json({ error: 'You already have an active loan' });
  const interest = Math.round(principal * 0.1);
  const next = new Date();
  next.setMonth(next.getMonth() + 1);
  const info = db.prepare(`
    INSERT INTO loans (chama_id, user_id, principal, interest, amount_repaid, status, next_payment)
    VALUES (?, ?, ?, ?, 0, 'ACTIVE', ?)
  `).run(req.membership.chama_id, req.user.id, principal, interest, next.toISOString().slice(0, 10));
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ loan, message: 'Loan recorded' });
});

// Create / join chama
router.post('/chamas', authRequired, (req, res) => {
  if (getMembership(req.user.id)) {
    return res.status(400).json({ error: 'You are already in a chama' });
  }
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Chama name required' });

  const plan = db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY sort_order LIMIT 1').get();
  const trialDays = plan ? plan.trial_days : 14;
  const trialEnd = new Date();
  trialEnd.setDate(trialEnd.getDate() + trialDays);
  const code = name.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) + Date.now().toString(36).slice(-4).toUpperCase();

  const create = db.transaction(() => {
    const c = db.prepare(`
      INSERT INTO chamas (name, description, status, max_members, contribution_amount, owner_user_id, invite_code, last_active)
      VALUES (?, ?, 'ACTIVE', ?, ?, ?, ?, datetime('now'))
    `).run(
      name,
      req.body.description || '',
      plan ? plan.max_members : 15,
      parseInt(req.body.contribution_amount, 10) || 2000,
      req.user.id,
      code
    );
    const chamaId = c.lastInsertRowid;
    db.prepare(`
      INSERT INTO chama_members (chama_id, user_id, role, status) VALUES (?, ?, 'CHAMA_ADMIN', 'ACTIVE')
    `).run(chamaId, req.user.id);
    db.prepare(`
      INSERT INTO subscriptions (chama_id, plan_id, status, amount, trial_ends_at, current_period_start, current_period_end)
      VALUES (?, ?, 'TRIAL', ?, ?, date('now'), ?)
    `).run(chamaId, plan.id, plan.price, trialEnd.toISOString().slice(0, 10), trialEnd.toISOString().slice(0, 10));
    return chamaId;
  });

  const chamaId = create();
  audit(req.user.id, 'CHAMA_CREATED', 'chama', chamaId, { name, invite_code: code }, req.ip);
  const chama = db.prepare('SELECT * FROM chamas WHERE id = ?').get(chamaId);

  res.status(201).json({
    chama,
    invite_code: code,
    message: 'Chama created. Add a payment method so members know how to pay.',
  });
});

router.post('/chamas/join', authRequired, (req, res) => {
  if (getMembership(req.user.id)) {
    return res.status(400).json({ error: 'Already in a chama' });
  }
  const code = String(req.body.invite_code || '').trim().toUpperCase();
  const chama = db.prepare('SELECT * FROM chamas WHERE upper(invite_code) = ?').get(code);
  if (!chama) return res.status(404).json({ error: 'Invalid invite code' });
  if (chama.status === 'SUSPENDED') {
    return res.status(403).json({ error: 'This chama is suspended' });
  }
  const lim = memberLimit(chama.id);
  const count = db.prepare(`SELECT COUNT(*) AS c FROM chama_members WHERE chama_id = ? AND status = 'ACTIVE'`).get(chama.id).c;
  if (count >= lim) return res.status(400).json({ error: 'Chama is full' });

  db.prepare(`
    INSERT INTO chama_members (chama_id, user_id, role, status) VALUES (?, ?, 'MEMBER', 'ACTIVE')
  `).run(chama.id, req.user.id);
  audit(req.user.id, 'CHAMA_JOINED', 'chama', chama.id, {}, req.ip);
  res.json({ message: 'Joined ' + chama.name, chama_id: chama.id });
});

router.get('/subscription', authRequired, (req, res) => {
  const membership = getMembership(req.user.id);
  if (!membership) return res.status(404).json({ error: 'Not in a chama' });
  const sub = db.prepare('SELECT * FROM subscriptions WHERE chama_id = ?').get(membership.chama_id);
  const plan = sub ? db.prepare('SELECT * FROM plans WHERE id = ?').get(sub.plan_id) : null;
  res.json({
    plan: plan && plan.name,
    status: sub && sub.status,
    next_payment: sub && sub.current_period_end,
    max_members: memberLimit(membership.chama_id),
    price: (sub && sub.amount) || (plan && plan.price) || 500,
    chama_status: membership.chama_status,
    suspend_reason: membership.suspend_reason,
  });
});

router.get('/plans', (req, res) => {
  const plans = db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY sort_order, id').all();
  res.json({
    plans: plans.map(p => ({
      id: p.id,
      name: p.name,
      price: p.price,
      currency: p.currency,
      billing_cycle: p.billing_cycle,
      max_members: p.max_members,
      trial_days: p.trial_days,
      description: p.description,
      features: JSON.parse(p.features || '[]'),
    })),
  });
});

module.exports = router;
