/**
 * Development seed only. Do NOT run in production with real users.
 * Usage: SEED_DEMO=1 node scripts/seed.js
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db } = require('../server/db');

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== '1') {
  console.error('Refusing to seed in production. Set ALLOW_PROD_SEED=1 to override.');
  process.exit(1);
}

const pin = bcrypt.hashSync('1234', 10);
const ownerPin = bcrypt.hashSync(process.env.OWNER_PIN || 'Owner@2026!', 10);

const run = db.transaction(() => {
  // Owner
  let owner = db.prepare(`SELECT id FROM users WHERE phone = '0700000001'`).get();
  if (!owner) {
    const r = db.prepare(`
      INSERT INTO users (phone, pin_hash, name, email, platform_role, status, avatar_color)
      VALUES ('0700000001', ?, 'Platform Owner', 'owner@chamahub.co.ke', 'SUPER_ADMIN', 'ACTIVE', '#C9A227')
    `).run(ownerPin);
    owner = { id: r.lastInsertRowid };
  }

  const users = [
    ['0723456789', 'Alex Kamau', '#1A7A5C'],
    ['0712345678', 'Jane Mwangi', '#0D5C45'],
    ['0734567890', 'Grace Wanjiku', '#C9A227'],
    ['0745678901', 'David Ochieng', '#2E9B78'],
    ['0756789012', 'Sarah Njeri', '#0A3D2E'],
  ];
  const ids = {};
  users.forEach(([phone, name, color]) => {
    let u = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
    if (!u) {
      const r = db.prepare(`
        INSERT INTO users (phone, pin_hash, name, platform_role, status, avatar_color)
        VALUES (?, ?, ?, 'USER', 'ACTIVE', ?)
      `).run(phone, pin, name, color);
      u = { id: r.lastInsertRowid };
    }
    ids[phone] = u.id;
  });

  let chama = db.prepare(`SELECT id FROM chamas WHERE invite_code = 'UMOJA2026'`).get();
  if (!chama) {
    const plan = db.prepare('SELECT id, price, max_members FROM plans ORDER BY sort_order LIMIT 1').get();
    const r = db.prepare(`
      INSERT INTO chamas (name, description, status, max_members, contribution_amount, owner_user_id, invite_code, last_active)
      VALUES ('Umoja Savings', 'Demo community savings', 'ACTIVE', ?, 2000, ?, 'UMOJA2026', datetime('now'))
    `).run(plan.max_members, ids['0723456789']);
    chama = { id: r.lastInsertRowid };

    const members = [
      [ids['0723456789'], 'CHAMA_ADMIN'],
      [ids['0712345678'], 'TREASURER'],
      [ids['0734567890'], 'SECRETARY'],
      [ids['0745678901'], 'MEMBER'],
      [ids['0756789012'], 'MEMBER'],
    ];
    const insM = db.prepare(`INSERT INTO chama_members (chama_id, user_id, role, status) VALUES (?, ?, ?, 'ACTIVE')`);
    members.forEach(([uid, role]) => insM.run(chama.id, uid, role));

    const end = new Date();
    end.setMonth(end.getMonth() + 1);
    db.prepare(`
      INSERT INTO subscriptions (chama_id, plan_id, status, amount, current_period_start, current_period_end)
      VALUES (?, ?, 'ACTIVE', ?, date('now'), ?)
    `).run(chama.id, plan.id, plan.price, end.toISOString().slice(0, 10));

    const methods = [
      ['MPESA_PHONE', 'M-Pesa to Treasurer', '0712345678 (Jane Mwangi)', 'Send via M-Pesa. Put your name in the message.', 1],
      ['MPESA_TILL', 'Buy Goods Till', 'Till 562891', 'Lipa na M-Pesa → Buy Goods → 562891', 0],
      ['BANK', 'Co-op Bank', 'Account 0110XXXXXX', 'Use your full name as reference', 0],
      ['CASH', 'Cash at meeting', 'Hand to Treasurer', 'Bring exact amount', 0],
    ];
    const insPm = db.prepare(`
      INSERT INTO payment_methods (chama_id, type, label, details, instructions, is_default)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    methods.forEach(m => insPm.run(chama.id, ...m));

    db.prepare(`
      INSERT INTO contributions (chama_id, user_id, amount, status, method, payment_method_label, reference, recorded_by, confirmed_by, confirmed_at)
      VALUES (?, ?, 2000, 'SUCCESS', 'MPESA_PHONE', 'M-Pesa to Treasurer', 'QK7A2B9C', ?, ?, datetime('now'))
    `).run(chama.id, ids['0712345678'], ids['0712345678'], ids['0712345678']);

    db.prepare(`
      INSERT INTO messages (chama_id, user_id, body) VALUES (?, ?, ?)
    `).run(chama.id, ids['0723456789'], 'Welcome to Umoja Savings. Pay outside the app, then record your contribution.');
  }
});

run();
console.log('Seed complete.');
console.log('  Owner:  0700000001 /', process.env.OWNER_PIN || 'Owner@2026!');
console.log('  Chair:  0723456789 / 1234');
console.log('  Member: 0745678901 / 1234');
console.log('  Invite: UMOJA2026');
