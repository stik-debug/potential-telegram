const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_FILE = process.env.SQLITE_PATH || path.join(DATA_DIR, 'chamahub.sqlite');
const SCHEMA = path.join(__dirname, 'schema.sql');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(SCHEMA, 'utf8'));

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function ensureDefaults() {
  const planCount = db.prepare('SELECT COUNT(*) AS c FROM plans').get().c;
  if (planCount === 0) {
    const insert = db.prepare(`
      INSERT INTO plans (name, price, currency, billing_cycle, max_members, trial_days, description, features, active, sort_order)
      VALUES (?, ?, 'KES', 'monthly', ?, ?, ?, ?, 1, ?)
    `);
    insert.run('Starter', 500, 15, 14, 'Small chama — up to 15 members', '["contributions","loans","chat","meetings"]', 1);
    insert.run('Growth', 1000, 30, 14, 'Growing groups — up to 30 members', '["contributions","loans","chat","meetings","reports"]', 2);
    insert.run('Pro', 2000, 50, 14, 'Established chamas — up to 50 members', '["contributions","loans","chat","meetings","reports","exports"]', 3);
    insert.run('Enterprise', 5000, 200, 7, 'Large networks — up to 200 members', '["all"]', 4);
  }
  if (!getSetting('platform_name')) setSetting('platform_name', 'ChamaHub Kenya');
  if (!getSetting('trial_days')) setSetting('trial_days', '14');
  if (!getSetting('grace_days')) setSetting('grace_days', '3');
  if (!getSetting('currency')) setSetting('currency', 'KES');
}

ensureDefaults();

module.exports = { db, getSetting, setSetting, DB_FILE };
