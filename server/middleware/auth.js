const jwt = require('jsonwebtoken');
const { db } = require('../db');

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-chamahub';

function signToken(user) {
  return jwt.sign(
    { id: user.id, phone: user.phone, platform_role: user.platform_role },
    SECRET,
    { expiresIn: process.env.JWT_EXPIRES || '7d' }
  );
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Please log in' });
  }
  try {
    const payload = jwt.verify(header.slice(7), SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!user || user.status === 'SUSPENDED') {
      return res.status(401).json({ error: 'Account unavailable' });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Log in again.' });
  }
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.platform_role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'SUPER_ADMIN access required' });
  }
  next();
}

function getMembership(userId) {
  return db.prepare(`
    SELECT m.*, c.name AS chama_name, c.status AS chama_status, c.suspend_reason,
           c.invite_code, c.contribution_amount, c.max_members
    FROM chama_members m
    JOIN chamas c ON c.id = m.chama_id
    WHERE m.user_id = ? AND m.status = 'ACTIVE'
  `).get(userId);
}

function canManage(role) {
  return ['CHAMA_ADMIN', 'TREASURER', 'SECRETARY'].includes(role);
}

function canConfirm(role) {
  return ['CHAMA_ADMIN', 'TREASURER'].includes(role);
}

function requireChamaAccess(options = {}) {
  const needWrite = !!options.write;
  return (req, res, next) => {
    const membership = getMembership(req.user.id);
    if (!membership) {
      return res.status(404).json({ error: 'You are not in a chama' });
    }
    if (membership.chama_status === 'SUSPENDED') {
      return res.status(403).json({
        error: 'SUSPENDED',
        message: 'Your Chama account is currently suspended.',
        suspend_reason: membership.suspend_reason,
      });
    }
    const sub = db.prepare('SELECT * FROM subscriptions WHERE chama_id = ?').get(membership.chama_id);
    if (sub && ['SUSPENDED', 'EXPIRED', 'CANCELLED'].includes(sub.status)) {
      return res.status(403).json({
        error: sub.status,
        message: 'Subscription is ' + sub.status.toLowerCase() + '. Access restricted.',
        subscription: sub,
      });
    }
    if (needWrite && sub && ['PAST_DUE', 'GRACE_PERIOD'].includes(sub.status)) {
      return res.status(403).json({
        error: 'PAYMENT_REQUIRED',
        message: 'Subscription past due. Renew to continue transactions.',
        subscription: sub,
      });
    }
    req.membership = membership;
    req.subscription = sub || null;
    next();
  };
}

function audit(actorId, action, targetType, targetId, meta, ip) {
  db.prepare(`
    INSERT INTO audit_logs (actor_id, action, target_type, target_id, meta, ip)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(actorId || null, action, targetType || null, targetId || null, JSON.stringify(meta || {}), ip || null);
}

function normalizePhone(p) {
  let s = String(p || '').replace(/\s+/g, '').replace(/^\+254/, '0');
  if (s.startsWith('254') && s.length === 12) s = '0' + s.slice(3);
  return s;
}

module.exports = {
  signToken,
  authRequired,
  requireSuperAdmin,
  getMembership,
  canManage,
  canConfirm,
  requireChamaAccess,
  audit,
  normalizePhone,
  SECRET,
};
