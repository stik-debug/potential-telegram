require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { DB_FILE } = require('./db');
const authRoutes = require('./routes/auth');
const chamaRoutes = require('./routes/chama');
const ownerRoutes = require('./routes/owner');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || 'development',
    db: path.basename(DB_FILE),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api', chamaRoutes);
app.use('/api/owner', ownerRoutes);

// SPA fallback
app.get('/owner', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'owner', 'index.html'));
});
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api')) return next();
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log('');
  console.log('  ChamaHub Kenya');
  console.log('  http://localhost:' + PORT);
  console.log('  Owner: http://localhost:' + PORT + '/owner');
  console.log('  DB:', DB_FILE);
  console.log('  NODE_ENV:', process.env.NODE_ENV || 'development');
  if (process.env.SEED_DEMO === '1') {
    console.log('  SEED_DEMO=1 — run npm run seed if DB is empty');
  }
  console.log('');
});
