# Deploy to Railway

## Prerequisites
- GitHub account (free)
- Railway account (free) → railway.app
- Optional: Ticketmaster API key for more events

---

## Step 1 — Push to GitHub

```bash
cd helsinki-music
git init
git add .
git commit -m "Helsinki music events server"
```

Create a new **empty** repo on github.com, then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/helsinki-music.git
git branch -M main
git push -u origin main
```

---

## Step 2 — Create Railway project

1. Go to **railway.app** → **New Project**
2. Choose **Deploy from GitHub repo**
3. Connect your GitHub account → select **helsinki-music**
4. Railway detects Node.js automatically → click **Deploy Now**

First deploy takes ~2–3 minutes (compiles `better-sqlite3` native module).

---

## Step 3 — Add a persistent volume ⚠️ IMPORTANT

Without a volume the SQLite database resets on every restart.

1. Railway project → click your service → **Volumes** tab
2. Click **Add Volume**
3. Set mount path: `/app/data`
4. Click **Add** → Railway redeploys automatically

---

## Step 4 — Set environment variables

Railway project → your service → **Variables** tab → add:

| Variable               | Value                    | Required |
|------------------------|--------------------------|----------|
| `NODE_ENV`             | `production`             | ✓        |
| `PORT`                 | `3000`                   | ✓        |
| `DB_PATH`              | `/app/data/mgevents.db`    | ✓        |
| `CRAWL_ON_START`       | `true`                   | ✓        |
| `CRAWL_DAYS`           | `90`                     | ✓        |
| `TICKETMASTER_API_KEY` | your key                 | optional |
| `SONGKICK_API_KEY`     | your key                 | optional |

Click **Deploy** after saving variables.

---

## Step 5 — Get your public URL

Railway service → **Settings** → **Networking** → **Generate Domain**

You'll get something like:
```
https://helsinki-music-production.up.railway.app
```

---

## Verify it's working

```
/health          → { "status": "ok", "db": { "total_events": 400 } }
/api/events      → paginated event list
/api/stats       → counts by source
/                → public events UI
/admin           → admin panel (add sites, browse events, ask AI)
```

---

## Crawl schedule (runs automatically)

| Source       | Frequency | Key needed |
|--------------|-----------|------------|
| Helsinki API | every 6h  | no (free)  |
| Ticketmaster | every 12h | yes        |
| Songkick     | every 24h | yes        |
| Tiketti      | every 8h  | no         |

---

## Free tier

Railway Hobby plan: $5 credit/month. This app uses ~80 MB RAM — well within limits.

---

## Trigger a crawl via API

```bash
curl -X POST https://your-app.up.railway.app/api/crawl \
  -H "Content-Type: application/json" \
  -d '{"sources": ["hel", "tiketti"]}'
```

Or use the **Admin panel** at `/admin` → Sources → "Crawl Now".
