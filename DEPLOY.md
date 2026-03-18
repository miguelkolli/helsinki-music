# 🚀 Deploy to Railway — Step by Step

## What you need
- A GitHub account (free)
- A Railway account (free) → railway.app
- Your Ticketmaster API key

---

## Step 1 — Push to GitHub

```bash
# In your project folder:
git init
git add .
git commit -m "Helsinki music events server"

# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/helsinki-music.git
git push -u origin main
```

---

## Step 2 — Create Railway project

1. Go to **railway.app** → click **"Start a New Project"**
2. Choose **"Deploy from GitHub repo"**
3. Connect your GitHub account if not already connected
4. Select your **helsinki-music** repository
5. Railway detects Node.js automatically → click **"Deploy Now"**

Your first deploy starts immediately (takes ~2 minutes).

---

## Step 3 — Add a persistent volume (IMPORTANT for SQLite)

Railway containers restart occasionally. Without a volume, the database resets on every restart.

1. In your Railway project → click your service
2. Go to **"Volumes"** tab → click **"Add Volume"**
3. Set mount path to: `/app/data`
4. Click **"Add"**

This keeps your `events.db` file alive across restarts and redeploys.

---

## Step 4 — Set environment variables

In Railway → your service → **"Variables"** tab → add these:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `DB_PATH` | `/app/data/events.db` |
| `CRAWL_ON_START` | `true` |
| `CRAWL_DAYS` | `90` |
| `TICKETMASTER_API_KEY` | `your_key_here` |

Leave `SONGKICK_API_KEY` empty for now — add it when you have it.

Click **"Deploy"** after adding variables to redeploy with the new config.

---

## Step 5 — Get your public URL

Railway gives you a free URL automatically:

1. Go to your service → **"Settings"** tab
2. Under **"Networking"** → click **"Generate Domain"**
3. You get a URL like: `https://helsinki-music-production.up.railway.app`

That's your live public API. Share it with anyone.

---

## Step 6 — Add your own domain (later)

When you buy a domain (e.g. `helsinkimusic.fi`):

1. Railway → Settings → Networking → **"Add Custom Domain"**
2. Type your domain → Railway shows you a CNAME record
3. In your domain registrar's DNS settings → add that CNAME
4. Wait 5–15 minutes for DNS to propagate
5. Railway auto-provisions a free SSL certificate (HTTPS)

---

## Step 7 — Verify it's working

Once deployed, test these URLs (replace with your Railway URL):

```
GET  https://your-app.up.railway.app/health
     → { "status": "ok", "db": { "total_events": 423 } }

GET  https://your-app.up.railway.app/api/events?limit=5
     → { "events": [...], "meta": { "total": 423 } }

GET  https://your-app.up.railway.app/api/stats
     → source counts, last crawl time

GET  https://your-app.up.railway.app/
     → the full web app UI
```

---

## Cron schedule (runs automatically)

Once live, the server crawls on its own schedule forever:

| Source | Schedule | Notes |
|---|---|---|
| LinkedEvents | Every 6h | Free, no key |
| Ticketmaster | Every 12h | Needs key |
| Tiketti | Every 8h | Web crawler |
| Songkick | Every 24h | Add key when ready |

---

## Free tier limits on Railway

Railway's free Hobby plan includes:
- $5 free credit/month (enough for a small always-on server)
- 512 MB RAM
- Shared CPU
- 1 GB volume storage

This app uses ~80 MB RAM and ~50 MB disk. Well within limits.

---

## Trigger a manual crawl via API

```bash
curl -X POST https://your-app.up.railway.app/api/crawl \
  -H "Content-Type: application/json" \
  -d '{"sources": ["hel", "tm", "tiketti"]}'
```

---

## Adding Songkick later

When your Songkick key is approved:
1. Railway → Variables → add `SONGKICK_API_KEY=your_key`
2. Click Deploy
3. The Songkick crawler activates automatically on next cron run

No code changes needed.
