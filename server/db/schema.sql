-- ChamaHub Kenya — production schema (SQLite)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  platform_role TEXT NOT NULL DEFAULT 'USER' CHECK (platform_role IN ('SUPER_ADMIN', 'USER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  avatar_color TEXT DEFAULT '#0D5C45',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KES',
  billing_cycle TEXT NOT NULL DEFAULT 'monthly',
  max_members INTEGER NOT NULL DEFAULT 15,
  trial_days INTEGER NOT NULL DEFAULT 14,
  description TEXT,
  features TEXT DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chamas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  suspend_reason TEXT,
  max_members INTEGER NOT NULL DEFAULT 15,
  contribution_amount INTEGER NOT NULL DEFAULT 2000,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  invite_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active TEXT
);

CREATE TABLE IF NOT EXISTS chama_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chama_id INTEGER NOT NULL REFERENCES chamas(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'MEMBER'
    CHECK (role IN ('CHAMA_ADMIN', 'TREASURER', 'SECRETARY', 'MEMBER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REMOVED')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (chama_id, user_id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chama_id INTEGER NOT NULL UNIQUE REFERENCES chamas(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'TRIAL'
    CHECK (status IN ('TRIAL','ACTIVE','PAST_DUE','GRACE_PERIOD','EXPIRED','SUSPENDED','CANCELLED')),
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KES',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  trial_ends_at TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  grace_ends_at TEXT,
  cancelled_at TEXT
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chama_id INTEGER NOT NULL REFERENCES chamas(id),
  type TEXT NOT NULL DEFAULT 'OTHER',
  label TEXT NOT NULL,
  details TEXT NOT NULL,
  instructions TEXT DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chama_id INTEGER NOT NULL REFERENCES chamas(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'SUCCESS', 'REJECTED')),
  method TEXT DEFAULT 'EXTERNAL',
  payment_method_id INTEGER REFERENCES payment_methods(id),
  payment_method_label TEXT,
  reference TEXT,
  note TEXT,
  recorded_by INTEGER REFERENCES users(id),
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chama_id INTEGER NOT NULL REFERENCES chamas(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  principal INTEGER NOT NULL,
  interest INTEGER NOT NULL DEFAULT 0,
  amount_repaid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  next_payment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chama_id INTEGER NOT NULL REFERENCES chamas(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chama_id INTEGER NOT NULL REFERENCES chamas(id),
  title TEXT NOT NULL,
  description TEXT,
  meeting_at TEXT NOT NULL,
  location TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chama_id INTEGER NOT NULL REFERENCES chamas(id),
  user_id INTEGER REFERENCES users(id),
  amount INTEGER NOT NULL,
  currency TEXT DEFAULT 'KES',
  type TEXT DEFAULT 'SUBSCRIPTION',
  method TEXT DEFAULT 'MANUAL',
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'SUCCESS',
  applied INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  meta TEXT DEFAULT '{}',
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_members_chama ON chama_members(chama_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON chama_members(user_id);
CREATE INDEX IF NOT EXISTS idx_contrib_chama ON contributions(chama_id);
CREATE INDEX IF NOT EXISTS idx_messages_chama ON messages(chama_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
