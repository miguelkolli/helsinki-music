// ═══════════════════════════════════════════════════════════════
//  Helsinki Music Events — Production Server
//  Stack: Node.js · Express · SQLite (better-sqlite3) · node-cron
// ═══════════════════════════════════════════════════════════════

const express    = require('express');
const Database   = require('better-sqlite3');
const cron       = require('node-cron');
const fetch      = (...a) => import('node-fetch').then(({default:f})=>f(...a));
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── CORS for local dev ──────────────────────────────────────────
app.use((req,res,next)=>{
  res.header('Access-Control-Allow-Origin','*');
  res.header('Access-Control-Allow-Headers','Content-Type');
  next();
});

// ════════════════════════════════════════════════════════════════
//  DATABASE SETUP  (SQLite — single file, zero config)
// ════════════════════════════════════════════════════════════════
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/events.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode — much faster for concurrent reads + writes
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');   // 64 MB page cache
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    venue       TEXT,
    date_iso    TEXT,
    date_ts     INTEGER,            -- Unix ms for fast range queries
    tags        TEXT DEFAULT '[]',  -- JSON array stored as text
    price       TEXT,
    url         TEXT,
    source      TEXT NOT NULL,
    raw_json    TEXT,               -- full original payload
    created_at  INTEGER DEFAULT (unixepoch('now') * 1000),
    updated_at  INTEGER DEFAULT (unixepoch('now') * 1000)
  );

  -- Fast lookup indexes
  CREATE INDEX IF NOT EXISTS idx_date    ON events(date_ts);
  CREATE INDEX IF NOT EXISTS idx_source  ON events(source);
  CREATE INDEX IF NOT EXISTS idx_name    ON events(name);

  -- Full-text search table
  CREATE VIRTUAL TABLE IF NOT EXISTS events_fts
    USING fts5(id UNINDEXED, name, venue, tags, content=events, content_rowid=rowid);

  -- Keep FTS in sync automatically
  CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, id, name, venue, tags)
    VALUES (new.rowid, new.id, new.name, new.venue, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, id, name, venue, tags)
    VALUES ('delete', old.rowid, old.id, old.name, old.venue, old.tags);
    INSERT INTO events_fts(rowid, id, name, venue, tags)
    VALUES (new.rowid, new.id, new.name, new.venue, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, id, name, venue, tags)
    VALUES ('delete', old.rowid, old.id, old.name, old.venue, old.tags);
  END;

  -- Crawl log table
  CREATE TABLE IF NOT EXISTS crawl_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    status     TEXT,               -- 'ok' | 'error' | 'running'
    events_raw INTEGER DEFAULT 0,
    events_new INTEGER DEFAULT 0,
    events_upd INTEGER DEFAULT 0,
    error_msg  TEXT
  );
`);

console.log(`✓ Database ready at ${DB_PATH}`);

// ── Prepared statements (compiled once, reused many times) ──────
const stmts = {
  upsert: db.prepare(`
    INSERT INTO events (id,name,venue,date_iso,date_ts,tags,price,url,source,raw_json,updated_at)
    VALUES (@id,@name,@venue,@date_iso,@date_ts,@tags,@price,@url,@source,@raw_json,@updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, venue=excluded.venue,
      date_iso=excluded.date_iso, date_ts=excluded.date_ts,
      tags=excluded.tags, price=excluded.price,
      url=excluded.url, raw_json=excluded.raw_json,
      updated_at=excluded.updated_at
  `),

  getAll: db.prepare(`
    SELECT id,name,venue,date_iso,tags,price,url,source
    FROM events
    WHERE date_ts >= @from
    ORDER BY date_ts ASC
    LIMIT @limit OFFSET @offset
  `),

  getBySource: db.prepare(`
    SELECT id,name,venue,date_iso,tags,price,url,source
    FROM events
    WHERE source=@source AND date_ts >= @from
    ORDER BY date_ts ASC
  `),

  search: db.prepare(`
    SELECT e.id,e.name,e.venue,e.date_iso,e.tags,e.price,e.url,e.source
    FROM events_fts f
    JOIN events e ON e.rowid = f.rowid
    WHERE events_fts MATCH @query AND e.date_ts >= @from
    ORDER BY rank
    LIMIT @limit
  `),

  countAll:    db.prepare(`SELECT COUNT(*) as n FROM events WHERE date_ts >= @from`),
  countSource: db.prepare(`SELECT source, COUNT(*) as n FROM events WHERE date_ts >= @from GROUP BY source`),
  logStart:    db.prepare(`INSERT INTO crawl_log (source,started_at,status) VALUES (@source,@ts,'running')`),
  logEnd:      db.prepare(`UPDATE crawl_log SET ended_at=@ts,status=@status,events_raw=@raw,events_new=@new,events_upd=@upd,error_msg=@err WHERE id=@id`),
  recentLogs:  db.prepare(`SELECT * FROM crawl_log ORDER BY started_at DESC LIMIT 50`),
};

// ── Batch upsert (wrapped in transaction for speed) ─────────────
const batchUpsert = db.transaction((events) => {
  let newCount = 0, updCount = 0;
  const now = Date.now();
  for (const e of events) {
    const existing = db.prepare('SELECT id FROM events WHERE id=?').get(e.id);
    stmts.upsert.run({
      id: e.id, name: e.name, venue: e.venue||'Helsinki',
      date_iso: e.date||null,
      date_ts: e.date ? new Date(e.date).getTime() : null,
      tags: JSON.stringify(e.tags||[]),
      price: e.price||null, url: e.url||null,
      source: e._source,
      raw_json: JSON.stringify(e),
      updated_at: now
    });
    existing ? updCount++ : newCount++;
  }
  return { newCount, updCount };
});

// ════════════════════════════════════════════════════════════════
//  CRAWLERS
// ════════════════════════════════════════════════════════════════
const MUSIC_KW = ['music','concert','gig','jazz','rock','pop','electronic','folk',
  'metal','blues','reggae','punk','indie','choir','orchestra','band','festival',
  'live','techno','house','soul','classical','musiikki','keikka'];

async function crawlLinkedEvents() {
  const days   = parseInt(process.env.CRAWL_DAYS||'90');
  const today  = new Date().toISOString().split('T')[0];
  const future = new Date(Date.now()+days*864e5).toISOString().split('T')[0];
  const url    = `https://api.hel.fi/linkedevents/v1/event/?start=${today}&end=${future}&language=en&keyword=yso:p1808&page_size=100&sort=start_time`;
  const r = await fetch(url);
  const d = await r.json();
  return (d.data||[])
    .filter(e=>{ const t=((e.name?.en||'')+(e.name?.fi||'')).toLowerCase(); return MUSIC_KW.some(k=>t.includes(k)); })
    .map(e=>({
      id: 'hel_'+e.id,
      name: e.name?.en||e.name?.fi||'',
      venue: e.location?.name?.en||e.location?.name?.fi||'Helsinki',
      date: e.start_time,
      tags: (e.keywords||[]).map(k=>k.name?.en||k.name?.fi||'').filter(Boolean).slice(0,4),
      price: null, url: e.info_url||null, _source:'hel'
    }));
}

// ════════════════════════════════════════════════════════════════
//  ## TICKETMASTER CRAWLER
//  API docs : https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
//  Free key : https://developer.ticketmaster.com  →  "Get Your API Key"
//  Env var  : TICKETMASTER_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//  Rate limit: 5 req/sec · 5 000 req/day on free tier
//  Pagination: page-based (?page=0..N), max size=200 per page
// ════════════════════════════════════════════════════════════════

async function crawlTicketmaster() {

  ## ── 1. KEY CHECK ────────────────────────────────────────────────
  ## Set TICKETMASTER_API_KEY in your .env file to activate this crawler.
  ## Leave it empty to skip silently (no crash).
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) {
    console.log('  [Ticketmaster] Skipped — no TICKETMASTER_API_KEY in .env');
    return [];
  }

  ## ── 2. BASE URL + QUERY PARAMS ──────────────────────────────────
  ## city=Helsinki            → only Helsinki area venues
  ## countryCode=FI           → Finland country filter (avoids false matches)
  ## classificationName=music → only music events (not sports, theatre etc.)
  ## size=200                 → max events per page (200 is the API limit)
  ## sort=date,asc            → chronological order
  ## includeTBA=yes           → include events with TBA dates
  ## includeTBD=yes           → include events with TBD dates
  const BASE_URL = 'https://app.ticketmaster.com/discovery/v2/events.json';
  const PARAMS = new URLSearchParams({
    apikey:             key,
    city:               'Helsinki',
    countryCode:        'FI',
    classificationName: 'music',
    size:               '200',
    sort:               'date,asc',
    includeTBA:         'yes',
    includeTBD:         'yes',
  });

  ## ── 3. FETCH ALL PAGES ──────────────────────────────────────────
  ## Ticketmaster uses page= param (0-indexed).
  ## First response tells us totalPages in page.totalPages.
  ## We fetch page 0 first, then loop through remaining pages.
  ## Rate limit: 5 req/sec → 220ms delay between requests to stay safe.

  const all = [];
  let page = 0;
  let totalPages = 1; ## updated after first response

  console.log('  [Ticketmaster] Starting paginated fetch...');

  while (page < totalPages) {

    try {
      ## Build URL for this page
      const url = `${BASE_URL}?${PARAMS}&page=${page}`;

      ## Fetch with timeout (10s) — Ticketmaster can be slow
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const r = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      ## Handle non-200 responses
      if (!r.ok) {
        console.error(`  [Ticketmaster] HTTP ${r.status} on page ${page} — stopping`);
        break;
      }

      const d = await r.json();

      ## On first page: read totalPages from response
      if (page === 0) {
        totalPages = d.page?.totalPages ?? 1;
        const totalElements = d.page?.totalElements ?? 0;
        console.log(`  [Ticketmaster] ${totalElements} events across ${totalPages} pages`);
      }

      ## Extract events from _embedded.events array
      ## _embedded may be missing if page has no results
      const events = d._embedded?.events ?? [];

      events.forEach(e => {

        ## ── 4. NORMALISE EACH EVENT ────────────────────────────────
        ## Map Ticketmaster fields to our unified schema.
        ## All fields are optional — use fallbacks for everything.

        ## Name: always present
        const name = e.name ?? 'Unknown event';

        ## Venue: nested inside _embedded.venues array
        const venue = e._embedded?.venues?.[0]?.name ?? 'Helsinki';

        ## Date: prefer dateTime (full ISO), fall back to localDate
        const date = e.dates?.start?.dateTime
                  ?? e.dates?.start?.localDate
                  ?? null;

        ## Tags: from classifications → genre name
        ## Filter out 'Undefined' which TM returns when genre is unknown
        const tags = (e.classifications ?? [])
          .flatMap(c => [c.genre?.name, c.subGenre?.name])
          .filter(t => t && t !== 'Undefined')
          .slice(0, 3);

        ## Price: priceRanges array — take the min of the first range
        ## Format as "€12+" to indicate "from" price
        const priceRange = e.priceRanges?.[0];
        const price = priceRange
          ? `€${Math.round(priceRange.min)}–€${Math.round(priceRange.max)}`
          : null;

        ## Images: grab the widest image for thumbnail use
        const image = (e.images ?? [])
          .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null;

        ## Ticket URL: direct buy link
        const url_link = e.url ?? null;

        ## Onsale status: 'onsale' | 'offsale' | 'cancelled' | 'rescheduled'
        const status = e.dates?.status?.code ?? null;

        all.push({
          id:     'tm_' + e.id,      ## prefix to avoid ID collision with other sources
          name,
          venue,
          date,
          tags,
          price,
          image,
          url:    url_link,
          status,
          _source: 'tm',
        });
      });

      console.log(`  [Ticketmaster] Page ${page + 1}/${totalPages} — ${events.length} events`);
      page++;

      ## ── 5. RATE LIMITING ──────────────────────────────────────────
      ## Free tier: 5 req/sec. 220ms between requests = ~4.5 req/sec.
      ## Increase delay if you hit 429 Too Many Requests errors.
      if (page < totalPages) {
        await new Promise(r => setTimeout(r, 220));
      }

    } catch (err) {
      ## AbortError = timeout, other = network/parse error
      console.error(`  [Ticketmaster] Error on page ${page}: ${err.message}`);
      break; ## stop pagination on error — return what we have so far
    }
  }

  console.log(`  [Ticketmaster] Done — ${all.length} events fetched`);
  return all;
}


// ════════════════════════════════════════════════════════════════
//  ## SONGKICK CRAWLER
//  API docs : https://www.songkick.com/developer/event-search
//  Free key : https://www.songkick.com/developer  →  apply (manual review)
//  Env var  : SONGKICK_API_KEY=xxxxxxxxxxxxxxxx
//  Rate limit: ~100 req/hour on free tier — be gentle
//  Helsinki metro area ID: 28878  (use /search/locations?query=Helsinki to verify)
//  Pagination: page= param (1-indexed), perPage max = 50
// ════════════════════════════════════════════════════════════════

async function crawlSongkick() {

  ## ── 1. KEY CHECK ────────────────────────────────────────────────
  ## Set SONGKICK_API_KEY in your .env file to activate this crawler.
  ## Songkick requires a manual application — allow a few days for approval.
  const key = process.env.SONGKICK_API_KEY;
  if (!key) {
    console.log('  [Songkick] Skipped — no SONGKICK_API_KEY in .env');
    return [];
  }

  ## ── 2. METRO AREA ID ────────────────────────────────────────────
  ## Songkick organises events by metro area, not city string.
  ## Helsinki metro area ID = 28878
  ## To look up other cities: GET /search/locations.json?query=Helsinki&apikey=KEY
  const METRO_ID = 28878;

  ## ── 3. BASE URL ─────────────────────────────────────────────────
  ## /metro_areas/{id}/calendar.json = all upcoming events in this metro
  ## This automatically includes all venues in the Helsinki metro area
  const BASE_URL = `https://api.songkick.com/api/3.0/metro_areas/${METRO_ID}/calendar.json`;

  ## ── 4. FETCH ALL PAGES ──────────────────────────────────────────
  ## Songkick pagination is 1-indexed (first page = 1).
  ## Response includes resultsPage.totalEntries and resultsPage.perPage.
  ## We calculate total pages from those values.
  ## Rate limit: ~100 req/hour → 40s between requests is safe.
  ## In practice: 50 events/page × 10 pages = 500 events comfortably within limits.

  const all = [];
  let page = 1;
  let totalPages = 1; ## updated after first response

  console.log('  [Songkick] Starting paginated fetch for Helsinki metro...');

  while (page <= totalPages) {

    try {
      const url = `${BASE_URL}?apikey=${key}&per_page=50&page=${page}`;

      ## Fetch with 10s timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const r = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      ## Handle errors
      if (!r.ok) {
        ## 401 = bad API key
        ## 403 = key not approved yet or banned
        ## 429 = rate limited — increase delay below
        console.error(`  [Songkick] HTTP ${r.status} on page ${page}`);
        if (r.status === 401) console.error('  [Songkick] Check your SONGKICK_API_KEY — may be invalid');
        if (r.status === 403) console.error('  [Songkick] Key may not be approved yet — apply at songkick.com/developer');
        break;
      }

      const d = await r.json();
      const resultsPage = d.resultsPage;

      ## ── 5. CALCULATE TOTAL PAGES ────────────────────────────────
      ## Songkick gives us totalEntries and perPage — we derive totalPages.
      if (page === 1) {
        const total = resultsPage?.totalEntries ?? 0;
        const perPage = resultsPage?.perPage ?? 50;
        totalPages = Math.ceil(total / perPage);
        console.log(`  [Songkick] ${total} events across ${totalPages} pages`);
      }

      ## ── 6. EXTRACT EVENTS ───────────────────────────────────────
      ## Events are in resultsPage.results.event (array).
      ## Songkick uses 'Concert' and 'Festival' as event types.
      const events = resultsPage?.results?.event ?? [];

      events.forEach(e => {

        ## ── 7. NORMALISE EACH EVENT ────────────────────────────────
        ## Songkick event structure is simpler than Ticketmaster.
        ## displayName = "Artist at Venue, City" — use as the event name.

        ## Name: displayName is the full formatted name e.g. "Haloo Helsinki! at Tavastia"
        const name = e.displayName ?? 'Unknown event';

        ## Venue: nested venue object
        ## venue.displayName = "Tavastia"
        ## venue.lat / venue.lng available too
        const venue = e.venue?.displayName ?? 'Helsinki';

        ## Date: start.datetime (full ISO) or start.date (date only)
        ## start.time is also available separately as "HH:MM:SS"
        const date = e.start?.datetime
                  ?? (e.start?.date ? e.start.date + 'T' + (e.start.time ?? '00:00:00') : null);

        ## Tags: Songkick doesn't provide genre tags per event.
        ## We use the event type + 'live music' as base tags.
        ## Artists list is available in e.performance[] if you want artist names as tags.
        const tags = [
          e.type === 'Festival' ? 'festival' : 'live music',
          ## Optionally add headliner name as a tag:
          ## e.performance?.[0]?.artist?.displayName,
        ].filter(Boolean);

        ## Artists: Songkick has full performance lineup
        ## e.performance = [{ artist: { displayName, uri }, billing: 'headline'|'support' }]
        ## Useful for enriching event data — stored in tags here
        const artists = (e.performance ?? [])
          .map(p => p.artist?.displayName)
          .filter(Boolean)
          .slice(0, 3);
        if (artists.length) tags.push(...artists);

        ## Ticket URL: Songkick links to their own event page
        ## uri = "https://www.songkick.com/concerts/12345"
        const url_link = e.uri ?? null;

        ## Songkick does not provide price data
        ## (prices come from linked ticket sellers on their site)
        const price = null;

        all.push({
          id:     'sk_' + e.id,     ## prefix to avoid ID collision
          name,
          venue,
          date,
          tags,
          price,
          url:    url_link,
          _source: 'sk',
        });
      });

      console.log(`  [Songkick] Page ${page}/${totalPages} — ${events.length} events`);
      page++;

      ## ── 8. RATE LIMITING ──────────────────────────────────────────
      ## Songkick free tier: ~100 req/hour.
      ## 40s delay = 1.5 req/min = 90 req/hour — safely under limit.
      ## If you have a paid plan with higher limits, reduce this delay.
      ## If you get 429 errors, increase to 60000 (1 per minute).
      if (page <= totalPages) {
        await new Promise(r => setTimeout(r, 40000)); ## 40 second delay
      }

    } catch (err) {
      console.error(`  [Songkick] Error on page ${page}: ${err.message}`);
      break;
    }
  }

  console.log(`  [Songkick] Done — ${all.length} events fetched`);
  return all;
}

// ── TIKETTI WEB CRAWLER ─────────────────────────────────────────
// Tiketti has no public developer API. Using HTTP scraper.
//
// TIKETTI API KEY — uncomment when/if Tiketti releases public API:
//
//   const TIKETTI_KEY  = process.env.TIKETTI_API_KEY;
//   const TIKETTI_BASE = 'https://api.tiketti.fi/v1';
//   const headers = { 'X-Api-Key': TIKETTI_KEY, 'Accept': 'application/json' };
//   const url = `${TIKETTI_BASE}/events?city=helsinki&category=music`;
//   const r = await fetch(url, { headers });
//
async function crawlTiketti() {
  try {
    const r = await fetch('https://www.tiketti.fi/en/events?category=concert&city=helsinki', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HelsinkiMusicBot/1.0)' }
    });
    const html = await r.text();
    // Parse events from JSON-LD structured data (most reliable)
    const ldMatches = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
    const results = [];
    for (const m of ldMatches) {
      try {
        const obj = JSON.parse(m[1]);
        const items = Array.isArray(obj) ? obj : obj['@graph'] ? obj['@graph'] : [obj];
        for (const item of items) {
          if(item['@type']==='MusicEvent'||item['@type']==='Event') {
            results.push({
              id: 'tiketti_'+(item.identifier||item.url?.split('/').pop()||results.length),
              name: item.name||'',
              venue: item.location?.name||'Helsinki',
              date: item.startDate||null,
              tags: ['tiketti', item.genre||'music'].filter(Boolean),
              price: item.offers?.price ? `€${item.offers.price}` : null,
              url: item.url||'https://www.tiketti.fi',
              _source:'tiketti'
            });
          }
        }
      } catch(_) {}
    }
    if(results.length > 0) return results;
    console.log('  Tiketti: JSON-LD parse returned 0 — site may have changed');
    return [];
  } catch(e) {
    console.error('  Tiketti crawl error:', e.message);
    return [];
  }
}

// ── Master crawl runner ─────────────────────────────────────────
async function runCrawl(sources = ['hel','tm','sk','tiketti']) {
  console.log(`\n[${new Date().toISOString()}] ── Starting crawl: ${sources.join(', ')}`);
  const crawlers = { hel: crawlLinkedEvents, tm: crawlTicketmaster, sk: crawlSongkick, tiketti: crawlTiketti };
  const logIds = {};

  // Log start for each source
  sources.forEach(s => {
    const r = stmts.logStart.run({ source:s, ts:Date.now() });
    logIds[s] = r.lastInsertRowid;
  });

  const results = await Promise.allSettled(sources.map(s => crawlers[s]()));

  let totalNew=0, totalUpd=0;
  sources.forEach((s,i) => {
    const result = results[i];
    if(result.status==='fulfilled') {
      const events = result.value;
      const { newCount, updCount } = batchUpsert(events);
      totalNew += newCount; totalUpd += updCount;
      stmts.logEnd.run({ id:logIds[s], ts:Date.now(), status:'ok', raw:events.length, new:newCount, upd:updCount, err:null });
      console.log(`  ✓ ${s}: ${events.length} fetched, ${newCount} new, ${updCount} updated`);
    } else {
      stmts.logEnd.run({ id:logIds[s], ts:Date.now(), status:'error', raw:0, new:0, upd:0, err:result.reason?.message||'unknown' });
      console.error(`  ✗ ${s}: ${result.reason?.message}`);
    }
  });
  console.log(`  ── Done. ${totalNew} new, ${totalUpd} updated`);
}

// ════════════════════════════════════════════════════════════════
//  CRON SCHEDULES
// ════════════════════════════════════════════════════════════════
cron.schedule('0 */6 * * *',  () => runCrawl(['hel']));       // Every 6h  — LinkedEvents
cron.schedule('0 */12 * * *', () => runCrawl(['tm']));        // Every 12h — Ticketmaster
cron.schedule('0 8 * * *',    () => runCrawl(['sk']));        // Daily 8am — Songkick
cron.schedule('0 */8 * * *',  () => runCrawl(['tiketti']));   // Every 8h  — Tiketti crawl

// ── TIKETTI API cron (commented out — activate when API available):
// cron.schedule('0 */6 * * *', () => runCrawl(['tiketti']));
// ───────────────────────────────────────────────────────────────

console.log('✓ Cron schedules registered');

// ════════════════════════════════════════════════════════════════
//  REST API ROUTES
// ════════════════════════════════════════════════════════════════
const NOW_MS = () => Date.now();

// GET /api/events — paginated list
app.get('/api/events', (req, res) => {
  const { page=1, limit=50, source, q } = req.query;
  const from = NOW_MS();
  const offset = (parseInt(page)-1) * parseInt(limit);

  let events;
  if(q) {
    // Full-text search via SQLite FTS5
    try {
      events = stmts.search.all({ query: q+'*', from, limit: parseInt(limit) });
    } catch(_) { events = []; }
  } else if(source) {
    events = stmts.getBySource.all({ source, from });
  } else {
    events = stmts.getAll.all({ from, limit: parseInt(limit), offset });
  }

  const total = stmts.countAll.get({ from }).n;
  const bySource = stmts.countSource.all({ from });

  res.json({
    events: events.map(e=>({ ...e, tags: JSON.parse(e.tags||'[]') })),
    meta: { total, page:parseInt(page), limit:parseInt(limit), bySource }
  });
});

// GET /api/stats — dashboard numbers
app.get('/api/stats', (req, res) => {
  const from   = NOW_MS();
  const week   = from + 7*864e5;
  const total  = stmts.countAll.get({ from }).n;
  const bySource = stmts.countSource.all({ from });
  const thisWeek = db.prepare('SELECT COUNT(*) as n FROM events WHERE date_ts BETWEEN @from AND @to')
    .get({ from, to: week }).n;
  const logs = stmts.recentLogs.all();
  res.json({ total, thisWeek, bySource, lastCrawlLogs: logs.slice(0,10) });
});

// POST /api/crawl — trigger manual crawl
app.post('/api/crawl', async (req, res) => {
  const { sources } = req.body;
  res.json({ ok:true, message:'Crawl started', sources });
  runCrawl(sources||['hel','tm','sk','tiketti']); // fire and forget
});

// GET /api/logs — crawl history
app.get('/api/logs', (req,res) => res.json(stmts.recentLogs.all()));

// GET /api/export — download full DB as JSON
app.get('/api/export', (req,res) => {
  const all = db.prepare('SELECT * FROM events WHERE date_ts >= ?').all(NOW_MS());
  res.setHeader('Content-Disposition','attachment; filename="helsinki_music_events.json"');
  res.json({ exported: new Date().toISOString(), total: all.length, events: all });
});

// ════════════════════════════════════════════════════════════════

// ── HEALTH CHECK (Railway checks this every 30s) ────────────────
app.get('/health', (req, res) => {
  try {
    const total  = stmts.countAll.get({ from: 0 }).n;
    const uptime = Math.round(process.uptime());
    res.json({
      status: 'ok',
      uptime: `${uptime}s`,
      db:     { total_events: total, path: DB_PATH },
      node:   process.version,
      env:    process.env.NODE_ENV || 'development',
    });
  } catch(e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── SERVE FRONTEND ──────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// Catch-all SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── START ───────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n Helsinki Music Server running at http://localhost:${PORT}`);
  console.log(`   DB:  ${DB_PATH}`);
  console.log(`   ENV: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   TM key: ${process.env.TICKETMASTER_API_KEY ? 'SET' : 'NOT SET'}`);
  console.log(`   SK key: ${process.env.SONGKICK_API_KEY     ? 'SET' : 'NOT SET'}`);
  if (process.env.CRAWL_ON_START !== 'false') {
    console.log('   Running initial crawl...');
    const sources = ['hel', 'tiketti'];
    if (process.env.TICKETMASTER_API_KEY) sources.push('tm');
    if (process.env.SONGKICK_API_KEY)     sources.push('sk');
    await runCrawl(sources);
  }
});
