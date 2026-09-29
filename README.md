# ChamaHub Kenya

Multi-tenant chama (ROSCA) management app for Kenya.

**Money model:** the app is a **ledger only**. Members pay via M-Pesa / bank / cash **outside** the app. They record the contribution in-app; Chair/Treasurer confirms. ChamaHub never holds member funds.

## Stack

- Node.js 18+
- Express
- SQLite (`better-sqlite3`) — real SQL, transactions, indexes
- JWT auth + bcrypt PIN hashing
- Mobile-first web UI

## Quick start

```bash
npm install
cp .env.example .env
# edit JWT_SECRET
npm run seed          # demo data (dev only)
npm start
```

Open http://localhost:3000

### Demo logins (after seed)

| Role | Phone | PIN |
|------|--------|-----|
| SUPER_ADMIN | 0700000001 | Owner@2026! |
| Chair | 0723456789 | 1234 |
| Treasurer | 0712345678 | 1234 |
| Member | 0745678901 | 1234 |

Invite code: `UMOJA2026`

## Production

```bash
export NODE_ENV=production
export JWT_SECRET=your-long-secret
# Do NOT run seed on production with real users
npm install --omit=dev
npm start
```

Create the first SUPER_ADMIN manually (SQL) or temporarily seed then change PINs.

### Render deploy

1. Connect this repo
2. Build: `npm install`
3. Start: `npm start`
4. Disk: persist `data/` or set `SQLITE_PATH` on a volume
5. Env: `NODE_ENV=production`, `JWT_SECRET=...`

## Contribution flow (visible in app)

1. **Home** → big green **Record contribution**
2. **Bottom nav** → **Pay**
3. **Money** → **+ Record contribution**
4. Pick payment method → enter amount → **I have paid — record it**
5. Treasurer confirms under **Money**

## API overview

- `POST /api/auth/register` · `POST /api/auth/login` · `GET /api/auth/me`
- `GET /api/dashboard`
- `GET/POST /api/payment-methods`
- `GET /api/contributions` · `POST /api/contributions/record` · confirm/reject
- `GET/POST /api/members` · add/remove
- `POST /api/chamas` · `POST /api/chamas/join`
- `GET /api/owner/*` (SUPER_ADMIN only)

## License

UNLICENSED — private product.
