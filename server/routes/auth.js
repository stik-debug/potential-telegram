const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { signToken, authRequired, getMembership, normalizePhone, audit } = require('../middleware/auth');

const router = express.Router();
const COLORS = ['#0D5C45', '#1A7A5C', '#C9A227', '#2E9B78', '#0A3D2E'];

router.post('/login', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const pin = String(req.body.pin || '');
  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user || !bcrypt.compareSync(pin, user.pin_hash)) {
    return res.status(401).json({ error: 'Invalid phone or PIN' });
  }
  if (user.status === 'SUSPENDED') {
    return res.status(403).json({ error: 'Your account is suspended' });
  }
  db.prepare('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?').run(user.id);
  audit(user.id, 'LOGIN', 'user', user.id, {}, req.ip);

  const membership = getMembership(user.id);
  let subscription = null;
  if (membership) {
    subscription = db.prepare('SELECT * FROM subscriptions WHERE chama_id = ?').get(membership.chama_id);
  }

  res.json({
    token: signToken(user),
    user: {
      id: user.id,
      phone: user.phone,
      name: user.name,
      email: user.email,
      platform_role: user.platform_role,
      avatar_color: user.avatar_color,
    },
    chama: membership
      ? {
          chama_id: membership.chama_id,
          chama_name: membership.chama_name,
          member_role: membership.role,
          invite_code: membership.invite_code,
          contribution_amount: membership.contribution_amount,
          max_members: membership.max_members,
        }
      : null,
    subscription,
    access: membership
      ? {
          allowed: membership.chama_status === 'ACTIVE',
          reason: membership.chama_status,
          suspend_reason: membership.suspend_reason,
        }
      : null,
  });
});

router.post('/register', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const name = String(req.body.name || '').trim();
  const pin = String(req.body.pin || '');
  if (!phone || phone.length < 10) return res.status(400).json({ error: 'Valid phone required' });
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (pin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits' });
  if (db.prepare('SELECT id FROM users WHERE phone = ?').get(phone)) {
    return res.status(409).json({ error: 'Phone already registered. Log in instead.' });
  }
  const pin_hash = bcrypt.hashSync(pin, 10);
  const info = db.prepare(`
    INSERT INTO users (phone, pin_hash, name, email, platform_role, status, avatar_color)
    VALUES (?, ?, ?, ?, 'USER', 'ACTIVE', ?)
  `).run(phone, pin_hash, name, req.body.email || null, COLORS[Math.floor(Math.random() * COLORS.length)]);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  audit(user.id, 'USER_REGISTERED', 'user', user.id, {}, req.ip);

  res.status(201).json({
    token: signToken(user),
    user: {
      id: user.id, phone: user.phone, name: user.name, email: user.email,
      platform_role: user.platform_role, avatar_color: user.avatar_color,
    },
    chama: null,
    subscription: null,
    access: null,
  });
});

router.get('/me', authRequired, (req, res) => {
  const membership = getMembership(req.user.id);
  const subscription = membership
    ? db.prepare('SELECT * FROM subscriptions WHERE chama_id = ?').get(membership.chama_id)
    : null;
  res.json({
    user: {
      id: req.user.id,
      phone: req.user.phone,
      name: req.user.name,
      email: req.user.email,
      platform_role: req.user.platform_role,
      avatar_color: req.user.avatar_color,
    },
    chama: membership
      ? {
          chama_id: membership.chama_id,
          chama_name: membership.chama_name,
          member_role: membership.role,
          invite_code: membership.invite_code,
          contribution_amount: membership.contribution_amount,
          max_members: membership.max_members,
        }
      : null,
    subscription,
    access: membership
      ? {
          allowed: membership.chama_status === 'ACTIVE',
          reason: membership.chama_status,
          suspend_reason: membership.suspend_reason,
        }
      : null,
  });
});

module.exports = router;
