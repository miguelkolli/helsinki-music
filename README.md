# 🎵 Helsinki Music Events — Production Server

Automated music event aggregator for Helsinki.  
**Stack:** Node.js · Express · SQLite (better-sqlite3) · node-cron

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy env file and fill in your API keys
cp .env.example .env
nano .env

# 3. Start server
npm start
# → http://localhost:3000
```

---

## Project structure

```
helsinki-music/
├── server/
│   └── index.js          ← Express server + crawlers + cron
├── public/
│   └── index.html        ← Frontend app (served by Express)
├── data/
│   └── events.db         ← SQLite database (auto-created)
├── .env.example          ← Config template
└── package.json
```

---

## Database (SQLite)

SQLite is used because:
- **Zero config** — single file, no server process needed
- **Fast** — WAL mode + indexes + 64MB page cache
- **Full-text search** — built-in FTS5 for event search
- **Portable** — copy `data/events.db` to back up everything

### Performance settings applied
```sql
PRAGMA journal_mode = WAL;      -- concurrent reads while writing
PRAGMA synchronous = NORMAL;    -- safe + fast
PRAGMA cache_size = -64000;     -- 64 MB in-memory page cache
```

### Indexes
```sql
CREATE INDEX idx_date   ON events(date_ts);   -- fast date range queries
CREATE INDEX idx_source ON events(source);    -- filter by source
CREATE INDEX idx_name   ON events(name);      -- name lookup
```

### Full-text search (FTS5)
Events are automatically indexed for full-text search across name, venue, and tags.  
Search via: `GET /api/events?q=jazz`

---

## REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/events` | List events (paginated) |
| GET | `/api/events?q=jazz` | Full-text search |
| GET | `/api/events?source=hel` | Filter by source |
| GET | `/api/events?page=2&limit=50` | Pagination |
| GET | `/api/stats` | DB stats + source counts |
| GET | `/api/logs` | Crawl history |
| GET | `/api/export` | Download all events as JSON |
| POST | `/api/crawl` | Trigger manual crawl |

### POST /api/crawl body
```json
{ "sources": ["hel", "tm", "sk", "tiketti"] }
```

---

## Crawl schedule

| Source | Interval | Notes |
|--------|----------|-------|
| LinkedEvents | Every 6h | Free, no key needed |
| Ticketmaster | Every 12h | Needs `TICKETMASTER_API_KEY` |
| Songkick | Every 24h | Needs `SONGKICK_API_KEY` |
| Tiketti | Every 8h | Web crawler, no API |

---

## Tiketti API key

Tiketti has **no public developer API**. The server uses a web crawler instead.

When/if Tiketti releases a public API, activate it in `server/index.js`:
```js
// Uncomment these lines:
// const TIKETTI_KEY  = process.env.TIKETTI_API_KEY;
// const TIKETTI_BASE = 'https://api.tiketti.fi/v1';
// headers: { 'X-Api-Key': TIKETTI_KEY }
```
And add to `.env`:
```
TIKETTI_API_KEY=your_key_here
```

---

## Deploy to production

### Option A — VPS (DigitalOcean, Hetzner, etc.)
```bash
# Install Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install nodejs

# Clone and start
git clone your-repo
cd helsinki-music
npm install --production
cp .env.example .env && nano .env

# Run with PM2 (keeps alive, auto-restart)
npm install -g pm2
pm2 start server/index.js --name helsinki-music
pm2 save && pm2 startup
```

### Option B — Railway / Render (free tier)
1. Push to GitHub
2. Connect repo to Railway or Render
3. Set env vars in dashboard
4. Deploy — persistent disk for SQLite

### Option C — Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "server/index.js"]
```
```bash
docker build -t helsinki-music .
docker run -p 3000:3000 -v $(pwd)/data:/app/data --env-file .env helsinki-music
```

---

## Upgrade database to PostgreSQL

When outgrowing SQLite, swap `better-sqlite3` for `pg`:

```js
// npm install pg
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Replace db.prepare().run() with:
await pool.query('INSERT INTO events ... ON CONFLICT DO UPDATE ...', [values]);
```

SQLite → PostgreSQL is the natural upgrade path. All SQL is standard.
