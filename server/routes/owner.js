const express = require('express');
const { db } = require('../db');
const { authRequired, requireSuperAdmin, audit } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired, requireSuperAdmin);

router.get('/stats', (req, res) => {
  const total_users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const active_users = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE status = 'ACTIVE'`).get().c;
  const total_chamas = db.prepare('SELECT COUNT(*) AS c FROM chamas').get().c;
  const active_chamas = db.prepare(`SELECT COUNT(*) AS c FROM chamas WHERE status = 'ACTIVE'`).get().c;
  const suspended_chamas = db.prepare(`SELECT COUNT(*) AS c FROM chamas WHERE status = 'SUSPENDED'`).get().c;
  const byStatus = (st) => db.prepare('SELECT COUNT(*) AS c FROM subscriptions WHERE status = ?').get(st).c;
  const mrr = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS s FROM subscriptions WHERE status IN ('ACTIVE','TRIAL')
  `).get().s;
  const total_members = db.prepare(`SELECT COUNT(*) AS c FROM chama_members WHERE status = 'ACTIVE'`).get().c;

  res.json({
    total_users, active_users, total_chamas, active_chamas, suspended_chamas,
    trial_chamas: byStatus('TRIAL'),
    paid_chamas: byStatus('ACTIVE'),
    past_due_chamas: byStatus('PAST_DUE') + byStatus('GRACE_PERIOD'),
    mrr,
    total_members,
  });
});

router.get('/chamas', (req, res) => {
  const search = String(req.query.search || '').toLowerCase();
  let rows = db.prepare(`
    SELECT c.*, s.status AS subscription_status, s.current_period_end AS period_end, s.amount,
           p.name AS plan_name,
           (SELECT COUNT(*) FROM chama_members m WHERE m.chama_id = c.id AND m.status = 'ACTIVE') AS member_count,
           (SELECT u.name FROM chama_members m JOIN users u ON u.id = m.user_id
            WHERE m.chama_id = c.id AND m.role = 'CHAMA_ADMIN' AND m.status = 'ACTIVE' LIMIT 1) AS admin_name,
           (SELECT u.phone FROM chama_members m JOIN users u ON u.id = m.user_id
            WHERE m.chama_id = c.id AND m.role = 'CHAMA_ADMIN' AND m.status = 'ACTIVE' LIMIT 1) AS admin_phone
    FROM chamas c
    LEFT JOIN subscriptions s ON s.chama_id = c.id
    LEFT JOIN plans p ON p.id = s.plan_id
    ORDER BY c.created_at DESC
  `).all();

  if (search) {
    rows = rows.filter(c =>
      (c.name || '').toLowerCase().includes(search) ||
      String(c.id).includes(search) ||
      (c.admin_name || '').toLowerCase().includes(search) ||
      (c.admin_phone || '').includes(search)
    );
  }
  res.json({ chamas: rows });
});

router.post('/chamas/:id/suspend', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reason = String(req.body.reason || 'Administrative suspension');
  const chama = db.prepare('SELECT * FROM chamas WHERE id = ?').get(id);
  if (!chama) return res.status(404).json({ error: 'Chama not found' });

  db.transaction(() => {
    db.prepare(`UPDATE chamas SET status = 'SUSPENDED', suspend_reason = ? WHERE id = ?`).run(reason, id);
    db.prepare(`UPDATE subscriptions SET status = 'SUSPENDED' WHERE chama_id = ? AND status != 'CANCELLED'`).run(id);
  })();

  audit(req.user.id, 'CHAMA_SUSPENDED', 'chama', id, { reason }, req.ip);
  res.json({
    chama: db.prepare('SELECT * FROM chamas WHERE id = ?').get(id),
    message: 'Chama suspended. All data preserved.',
  });
});

router.post('/chamas/:id/reactivate', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const days = parseInt(req.body.extend_days, 10) || 30;
  const chama = db.prepare('SELECT * FROM chamas WHERE id = ?').get(id);
  if (!chama) return res.status(404).json({ error: 'Chama not found' });

  db.transaction(() => {
    db.prepare(`UPDATE chamas SET status = 'ACTIVE', suspend_reason = NULL WHERE id = ?`).run(id);
    db.prepare(`
      UPDATE subscriptions SET status = 'ACTIVE', grace_ends_at = NULL,
        current_period_end = date(COALESCE(current_period_end, date('now')), '+' || ? || ' days')
      WHERE chama_id = ?
    `).run(days, id);
  })();

  audit(req.user.id, 'CHAMA_REACTIVATED', 'chama', id, { extend_days: days }, req.ip);
  res.json({
    chama: db.prepare('SELECT * FROM chamas WHERE id = ?').get(id),
    subscription: db.prepare('SELECT * FROM subscriptions WHERE chama_id = ?').get(id),
    message: 'Chama reactivated',
  });
});

router.get('/plans', (req, res) => {
  res.json({ plans: db.prepare('SELECT * FROM plans ORDER BY sort_order, id').all() });
});

router.post('/plans', (req, res) => {
  const name = String(req.body.name || '').trim();
  const price = parseInt(req.body.price, 10);
  const max_members = parseInt(req.body.max_members, 10);
  if (!name || !price || !max_members) {
    return res.status(400).json({ error: 'name, price, max_members required' });
  }
  const info = db.prepare(`
    INSERT INTO plans (name, price, max_members, trial_days, description, active, sort_order)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(
    name, price, max_members,
    parseInt(req.body.trial_days, 10) || 14,
    req.body.description || '',
    parseInt(req.body.sort_order, 10) || 99
  );
  res.status(201).json({ plan: db.prepare('SELECT * FROM plans WHERE id = ?').get(info.lastInsertRowid) });
});

router.get('/users', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.name, u.phone, u.email, u.platform_role, u.status, u.last_login, u.created_at,
      (SELECT c.name FROM chama_members m JOIN chamas c ON c.id = m.chama_id
       WHERE m.user_id = u.id AND m.status = 'ACTIVE' LIMIT 1) AS chama_name,
      (SELECT m.role FROM chama_members m WHERE m.user_id = u.id AND m.status = 'ACTIVE' LIMIT 1) AS chama_role
    FROM users u
    ORDER BY u.created_at DESC
  `).all();
  res.json({ users });
});

router.get('/audit', (req, res) => {
  const logs = db.prepare(`
    SELECT a.*, u.name AS actor_name FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_id
    ORDER BY a.created_at DESC LIMIT 200
  `).all();
  res.json({ logs });
});

module.exports = router;
