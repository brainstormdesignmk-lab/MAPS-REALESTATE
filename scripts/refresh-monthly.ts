#!/usr/bin/env tsx
/**
 * refresh-monthly.ts — Monthly POI refresh + queue drain + poison sweep.
 *
 * PHASE A: OSM restore (free) — Overpass query, Skopje bbox
 * PHASE B: SerpApi top-up (budget ≤ 80 searches/month)
 * PHASE C: Queue drain — re-resolve queued properties offline
 * PHASE D: Poison sweep — re-check low-confidence landmarks
 *
 * Crontab: 0 4 1 * * cd /srv/app && npx tsx scripts/refresh-monthly.ts >> logs/refresh.log 2>&1
 */

import '../src/compat/node16';

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as dotenv from 'dotenv';
import { distM } from '../src/geo/precision';
import { identityHeal } from './identity-heal';
import { stripBlindFusions } from './strip-blind-fusions';

// Load env from ~/.lina/lina.env (SUPABASE_URL/KEY, DB_PATH, SKOPJE_POIS_DB)
dotenv.config({ path: path.join(os.homedir(), '.lina', 'lina.env') });

const SKOPJE_BBOX = '(41.95,21.35,42.05,21.50)';
const POIS_DB = process.env.SKOPJE_POIS_DB ?? path.join(process.cwd(), 'data', 'skopje-pois.db');
const LINA_DB = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'lina.db');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// ── SerpApi keys ─────────────────────────────────────────────────────────────
function loadSerpApiKeys(): string[] {
  const keys: string[] = [];
  if (process.env.SERPAPI_KEY) keys.push(process.env.SERPAPI_KEY);
  if (fs.existsSync('data/serpapi-key.txt')) {
    const k = fs.readFileSync('data/serpapi-key.txt', 'utf8').trim();
    if (k && !keys.includes(k)) keys.push(k);
  }
  if (fs.existsSync('GOOGLEMAPS_API_KEY.txt')) {
    const lines = fs.readFileSync('GOOGLEMAPS_API_KEY.txt', 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || /^[A-Z]/.test(trimmed)) continue;
      if (/^[0-9a-f]{40,}$/i.test(trimmed) && !keys.includes(trimmed)) {
        keys.push(trimmed);
      }
    }
  }
  return keys;
}

const SERPAPI_KEYS = loadSerpApiKeys();
let keyIdx = 0;
// SerpApi no longer sends the `x-serpapi-searches-left` response header, so
// the old live counter never moved — the budget guard was blind and one run
// burned 4 keys. /account is the authoritative ledger and is FREE. keyLeft[i]
// = that key's remaining searches (-1 = not yet probed).
let serpApiLeft = 0;
const keyLeft: number[] = SERPAPI_KEYS.map(() => -1);

async function refreshBudget(): Promise<number> {
  let total = 0;
  for (let i = 0; i < SERPAPI_KEYS.length; i++) {
    try {
      const res = await fetch(`https://serpapi.com/account?api_key=${SERPAPI_KEYS[i]}`);
      const j = await res.json();
      keyLeft[i] = typeof j.total_searches_left === 'number' ? j.total_searches_left : 0;
    } catch { /* keep previous value */ }
    total += Math.max(0, keyLeft[i]);
  }
  serpApiLeft = total;
  return total;
}

/** Spend one search against the current key's ledger (best-effort; /account
 *  is re-probed on rotation and before each phase). */
function spendOne(): void {
  const i = keyIdx % Math.max(1, SERPAPI_KEYS.length);
  if (keyLeft[i] > 0) keyLeft[i]--;
  if (serpApiLeft > 0) serpApiLeft--;
}

/** SerpApi enforces 250 searches per HOUR per account ON TOP OF the monthly
 *  250 — `{"error":"Your account has been throttled. You are exceeding 250
 *  searches per hour."}`. This is the true cause of the September and October
 *  429 storms: the 1100 ms pacing is ~3,270 searches/hour, over ten times the
 *  cap, so ONE key gets throttled after 250 searches and every request after
 *  that is rejected. A throttled key is not spent — just rate-blocked until
 *  the rolling hour passes. */
const KEY_THROTTLE_MS = 60 * 60 * 1000;
const keyBlockedUntil: number[] = SERPAPI_KEYS.map(() => 0);

/** Advance keyIdx to the next key that can actually serve a search: it must
 *  have monthly budget left AND not be hour-throttled. False when every key
 *  is spent or blocked — the signal to stop cleanly instead of grinding. */
function selectKey(): boolean {
  const n = SERPAPI_KEYS.length;
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    const j = keyIdx % n;
    if (keyLeft[j] > 0 && keyBlockedUntil[j] <= Date.now()) return true;
    keyIdx++;
  }
  return false;
}

// Cadence override: --full / --light on the command line wins over the
// calendar (quarterly Jan/Apr/Jul/Oct = full, other months = light).
const RUN_FLAG: '--full' | '--light' | undefined =
  process.argv.includes('--full') ? '--full'
  : process.argv.includes('--light') ? '--light' : undefined;

// THE SPEND GUARD (the drained-keys lesson): --dry-run reports exactly how
// many searches a real run would spend — from the tile×category ledger — and
// exits WITHOUT touching a key. --limit=N caps a real run at N searches so a
// partial pass can be sized to the budget on hand. No run spends blind again.
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='));
const SEARCH_LIMIT = LIMIT_ARG
  ? Math.max(0, parseInt(LIMIT_ARG.split('=')[1] ?? '', 10) || 0)
  : Infinity;

// --rescan=<file.json>: the REPAIR path. Re-scans an EXPLICIT list of
// {tile, category} pairs, deliberately bypassing the ledger's "already
// scanned" filter. Exists because a rejected request used to be counted as a
// completed scan: on 2026-10-08 730 pairs were recorded as done with no data
// behind them, and the ledger's own promise ("never repeated") meant they
// would never be retried. Runs Phase B only — see main().
const RESCAN_ARG = process.argv.find(a => a.startsWith('--rescan='));
const RESCAN_FILE = RESCAN_ARG ? RESCAN_ARG.split('=')[1] || null : null;

async function serpApiSearch(query: string, ll?: string): Promise<any> {
  if (!selectKey()) return null;
  const key = SERPAPI_KEYS[keyIdx % SERPAPI_KEYS.length];
  let url = `https://serpapi.com/search?engine=google_maps&type=search&q=${encodeURIComponent(query)}&hl=en&api_key=${key}`;
  if (ll) url += `&ll=${encodeURIComponent(ll)}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json();
    const left = res.headers.get('x-serpapi-searches-left');
    if (left) serpApiLeft = parseInt(left, 10);
    // ONE error path for every rejection. SerpApi answers a rejected request
    // with an `error` string and bills NOTHING for it. Never count it as a
    // scan: that is exactly how 730 phantom pairs were written on 2026-10-08,
    // and the ledger then refuses to retry them, so the tile stays empty
    // forever.
    if (typeof data?.error === 'string') {
      const idx = keyIdx % Math.max(1, SERPAPI_KEYS.length);
      const msg: string = data.error;
      if (/run out|exhaust/i.test(msg)) {
        keyLeft[idx] = 0;                                  // monthly 250 gone
      } else if (/throttl|exceed|too many|rate limit/i.test(msg)) {
        keyBlockedUntil[idx] = Date.now() + KEY_THROTTLE_MS; // hourly cap
        console.warn(`  ⚠ SerpApi throttled (250/hr) — key ${idx + 1} blocked 60 min, rotating`);
      } else {
        console.warn(`  ⚠ SerpApi error (not billed, not recorded): ${msg.slice(0, 80)}`);
      }
      keyIdx++;                    // never re-hit the key that just refused
      return serpApiSearch(query, ll);
    }
    spendOne();
    // ROUND-ROBIN on success: spread the load so no single account can eat its
    // 250/hour cap and stall the whole pass on one key.
    keyIdx++;
    return data;
  } catch (e) {
    console.warn(`  ⚠ SerpApi failed: ${(e as Error).message}`);
    return null;
  }
}

// ── Supabase REST helpers (property rows for the queue drain) ────────────────
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://qkgioqotxjxffiaufgwd.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrZ2lvcW90eGp4ZmZpYXVmZ3dkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxMTU0NjUsImV4cCI6MjA3MDY5MTQ2NX0.WVno6c6_rvFqFwj1fN8UWHYmlit0C-6J_h57P8d5eOI';

function restHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };
}

interface SupabasePropertyRow {
  property_number: string;
  address?: string | null;
  neighborhood?: string | null;
  lat?: number | null;
  lon?: number | null;
  geo_source?: string | null;
}

/** Fetch ONE property row by EB number (the queue's property_id key). */
async function fetchPropertyByNumber(n: string): Promise<SupabasePropertyRow | undefined> {
  const url = `${SUPABASE_URL}/rest/v1/properties?select=property_number,address,neighborhood,lat,lon,geo_source&property_number=eq.${encodeURIComponent(n)}`;
  const res = await fetch(url, { headers: restHeaders() });
  if (!res.ok) throw new Error(`fetch property ${n}: ${res.status} ${await res.text()}`);
  const rows = await res.json() as SupabasePropertyRow[];
  return rows[0];
}

/** Persist an upgraded center onto the property row (google_cached only). */
async function patchProperty(propertyNumber: string, data: {
  lat: number; lon: number; geo_source: string; geocoded_at: string;
}): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/properties?property_number=eq.${encodeURIComponent(propertyNumber)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: restHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`patch EB ${propertyNumber}: ${res.status} ${await res.text()}`);
}

/** ONE SerpApi geocode (address → coordinate), budget shared with the top-up
 *  (serpApiLeft tracks X-SerpApi-Searches-Left live). Returns null on a miss
 *  or key exhaustion — never a fabricated coordinate. */
async function serpApiGeocode(address: string): Promise<{ lat: number; lon: number } | null> {
  if (SERPAPI_KEYS.length === 0) return null;
  const key = SERPAPI_KEYS[keyIdx % SERPAPI_KEYS.length];
  const q = `${address}, Skopje`;
  const url = `https://serpapi.com/search?engine=google_maps&type=search&q=${encodeURIComponent(q)}&hl=en&api_key=${key}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json();
    const left = res.headers.get('x-serpapi-searches-left');
    if (left) {
      serpApiLeft = parseInt(left, 10);
      log(`    🔑 SerpApi searches left: ${left}`);
    }
    if (data?.error?.includes('run out')) {
      log('  ⚠ Key exhausted, rotating...');
      keyLeft[keyIdx % Math.max(1, SERPAPI_KEYS.length)] = 0;
      keyIdx++;
      if (keyIdx >= SERPAPI_KEYS.length) { serpApiLeft = 0; return null; }
      await refreshBudget();
      if (serpApiLeft < 20) return null;
      return serpApiGeocode(address);
    }
    spendOne();
    const coords = data?.local_results?.[0]?.gps_coordinates
      ?? data?.place_results?.gps_coordinates;
    if (coords?.latitude && coords?.longitude) {
      return { lat: coords.latitude, lon: coords.longitude };
    }
  } catch (e) {
    log(`  ⚠ SerpApi geocode failed for "${address}": ${(e as Error).message}`);
  }
  return null;
}

// ── PHASE A: OSM restore ─────────────────────────────────────────────────────
async function phaseA(db: Database.Database): Promise<number> {
  log('PHASE A: OSM restore via Overpass');

  const OVERPASS_QUERIES = [
    // Query 0: NAMED TRANSIT STOPS — the single most-used navigation anchor
    // in Skopje speech ("спроти автобуската", "кај станицата"). Named
    // bus/tram stops only (unnamed stops are dirt), one cheap query.
    `[out:json][timeout:300];(nwr["highway"~"bus_stop|tram_stop"]["name"]${SKOPJE_BBOX};nwr["railway"~"tram_stop|station"]["name"]${SKOPJE_BBOX};nwr["amenity"="bus_station"]["name"]${SKOPJE_BBOX};);out center;`,
    // Query 1: Core named POIs — shops, restaurants, services, institutions
    `[out:json][timeout:300];(nwr["name"]["amenity"~"pharmacy|bank|police|fire_station|school|hospital|cafe|restaurant|museum|university|place_of_worship|kindergarten|dentist|clinic|library|cinema|theatre|community_centre|marketplace|car_wash|veterinary|bicycle_rental|fuel|parking|bar|pub|nightclub|bureau_de_change|social_facility|fast_food|internet_cafe|driving_school|language_school|music_school|casino|doctors|post_office|townhall|courthouse|atm|arts_centre|car_rental|vehicle_inspection|shelter|fountain|recycling|vending_machine|parcel_locker"]${SKOPJE_BBOX};nwr["name"]["shop"~"supermarket|mall|department_store|greengrocer|bakery|butcher|electronics|furniture|clothing|convenience|car_repair|optician|jewelry|books|florist|kiosk|doityourself|mobile_phone|sports|outdoor|shoes|hairdresser|beauty|garden_centre|video|music|photo|pet|travel_agency|laundry|dry_cleaning|tailor|chemist|hardware|car_parts|stationery|copyshop|confectionery|pastry|car|bicycle|computer|office|tyres|cosmetics|gift|art|craft|locksmith|plumber|signmaker|stonemason|sweets|tea|wine"]${SKOPJE_BBOX};nwr["name"]["leisure"~"park|stadium|sports_centre|swimming_pool|playground|fitness_centre|garden|bowling_alley|ice_rink|water_park|amusement_arcade|horse_riding"]${SKOPJE_BBOX};nwr["name"]["tourism"~"hotel|hostel|motel|guest_house|attraction|viewpoint|artwork|information|museum|gallery|apartment|camp_site"]${SKOPJE_BBOX};nwr["name"]["office"~"company|lawyer|insurance|travel_agent|estate_agent|government|ngo|accountant|architect|consulting|employment_agency|it|notary"]${SKOPJE_BBOX};nwr["name"]["craft"~"electrician|plumber|carpenter|painter|roofer|tiler|gardener"]${SKOPJE_BBOX};nwr["name"]["building"~"commercial|retail|office|hotel|public|civic|stadium|school|hospital|university|train_station|transportation|mixed_use"]${SKOPJE_BBOX};nwr["name"]["man_made"~"tower|water_tower|windmill"]${SKOPJE_BBOX};nwr["name"]["historic"~"castle|memorial|monument|ruins|archaeological_site|wayside_cross|wayside_shrine|fort|tomb"]${SKOPJE_BBOX};);out center;`,
    // Query 2: Named buildings, extended amenities, historic, military, landuse
    `[out:json][timeout:300];(nwr["name"]["building"~"apartments|apartment|house|detached|residential|dormitory|yes|public|civic|commercial|retail|office|hotel|university|school|hospital|stadium|train_station|transportation|mixed_use|industrial|warehouse"]${SKOPJE_BBOX};nwr["name"]["amenity"~"bar|pub|nightclub|fast_food|ice_cream|food_court|casino|internet_cafe|post_office|townhall|courthouse|atm|arts_centre|car_rental|vehicle_inspection|animal_boarding|nursing_home|shelter|fountain|recycling|vending_machine|parcel_locker|water_point|bicycle_rental"]${SKOPJE_BBOX};nwr["name"]["shop"~"supermarket|convenience|bakery|butcher|clothing|shoes|jewelry|books|florist|kiosk|car_repair|optician|electronics|furniture|hairdresser|beauty|sports|outdoor|mobile_phone|garden_centre|doityourself|computer|photo|pet|travel_agency|laundry|dry_cleaning|tailor|chemist|hardware|car_parts|stationery|copyshop|confectionery|pastry|car|bicycle|tyres|cosmetics|gift|wholesale|charity|carpet|music|video"]${SKOPJE_BBOX};nwr["name"]["tourism"~"hotel|hostel|motel|guest_house|attraction|viewpoint|artwork|information|museum|gallery|apartment|camp_site|zoo|aquarium|theme_park"]${SKOPJE_BBOX};nwr["name"]["office"~"company|lawyer|insurance|travel_agent|estate_agent|government|ngo|accountant|architect|consulting|employment_agency|it|notary|psychologist|tax_advisor|newspaper|telecommunication|religion|political_party|association|diplomatic"]${SKOPJE_BBOX};nwr["name"]["historic"~"castle|memorial|monument|ruins|archaeological_site|wayside_cross|wayside_shrine|fort|tower|tomb|manor|boundary_stone|city_gate"]${SKOPJE_BBOX};nwr["name"]["man_made"~"tower|lighthouse|observatory|communications_tower|water_tower|windmill|chimney|silo|mast"]${SKOPJE_BBOX};nwr["name"]["military"~"barracks|airfield|base"]${SKOPJE_BBOX};nwr["name"]["landuse"~"cemetery|retail|commercial|industrial|institutional"]${SKOPJE_BBOX};);out center;`,
    // Query 3: Broader sweep for any missed named POIs across all categories
    `[out:json][timeout:300];(nwr["name"]["amenity"]${SKOPJE_BBOX};nwr["name"]["shop"]${SKOPJE_BBOX};nwr["name"]["leisure"]${SKOPJE_BBOX};nwr["name"]["tourism"]${SKOPJE_BBOX};nwr["name"]["office"]${SKOPJE_BBOX};nwr["name"]["craft"]${SKOPJE_BBOX};nwr["name"]["building"]${SKOPJE_BBOX};nwr["name"]["historic"]${SKOPJE_BBOX};nwr["name"]["man_made"]${SKOPJE_BBOX};nwr["name"]["military"]${SKOPJE_BBOX};);out center;`,
  ];

  let inserted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO pois (name, type, lat, lon, source, osm_key) VALUES (?, ?, ?, ?, 'osm', ?)`
  );

  for (const query of OVERPASS_QUERIES) {
    for (const mirror of [
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
    ]) {
      try {
        log(`  Querying Overpass: ${mirror}`);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 300_000);
        const res = await fetch(`${mirror}?data=${encodeURIComponent(query)}`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const elements = data?.elements ?? [];
        log(`  Got ${elements.length} elements from Overpass`);

        const tx = db.transaction(() => {
          for (const el of elements) {
            const name = el.tags?.name;
            if (!name || name.length < 2) continue;
            const lat = el.lat ?? el.center?.lat;
            const lon = el.lon ?? el.center?.lon;
            if (!lat || !lon) continue;
            const type = el.tags?.amenity ?? el.tags?.shop ?? el.tags?.leisure ?? el.tags?.tourism ?? el.tags?.office ?? el.tags?.craft ?? el.tags?.building
              ?? (el.tags?.highway === 'bus_stop' || el.tags?.highway === 'tram_stop' ? 'bus_station' : undefined)
              ?? (el.tags?.railway === 'tram_stop' || el.tags?.railway === 'station' ? 'bus_station' : undefined)
              ?? 'place';
            const osmKey = `${el.type}/${el.id}`;
            const info = insert.run(name, type, lat, lon, osmKey);
            if (info.changes > 0) inserted++;
          }
        });
        tx();
        log(`  Inserted ${inserted} new OSM POIs`);
        break; // success — skip other mirrors
      } catch (e) {
        log(`  ⚠ Overpass mirror failed: ${(e as Error).message}`);
      }
    }
  }

  // ── SELF-PRUNE: purge any POI outside the Skopje bbox before top-up.    ──
  // (Google's fuzzy expansion and one bad Overpass mirror pulled in 1,118
  // foreign rows — Walgreens in California, a New York hospital. A POI
  // outside Skopje can never be an honest "во близина" landmark.)
  const prePrune = db.prepare(
    `SELECT COUNT(*) AS n FROM pois WHERE lat IS NOT NULL AND lon IS NOT NULL
       AND (lat < 41.95 OR lat > 42.05 OR lon < 21.35 OR lon > 21.50)`
  ).get() as { n: number };
  if (prePrune.n > 0) {
    db.prepare(
      `DELETE FROM pois WHERE lat IS NOT NULL AND lon IS NOT NULL
         AND (lat < 41.95 OR lat > 42.05 OR lon < 21.35 OR lon > 21.50)`
    ).run();
    log(`  ✓ Pruned ${prePrune.n} outside-bbox POIs (Walgreens-class contamination)`);
  }

  return inserted;
}

  // ── PHASE B: SerpApi top-up ──────────────────────────────────────────
async function phaseB(db: Database.Database): Promise<number> {
  const { categoriesForRun, capturePoi, insideSkopjeBbox } = await import('../src/geo/serpCapture');
  const cats = categoriesForRun(RUN_FLAG);
  log(`PHASE B: SerpApi top-up — ${cats.length} categories (${RUN_FLAG ?? 'auto: ' + (cats.length > 2 ? 'FULL' : 'LIGHT')})`);

  if (SERPAPI_KEYS.length === 0) {
    log('  No SerpApi keys — skipping');
    return 0;
  }

  // THE LEDGER: seed (tile × category) coverage from the Google POIs we
  // already hold, then walk ONLY the unscanned pairs. A resumed run scans the
  // gaps, never the ground a previous run already covered.
  const { seedTileScansFromPois, uncoveredPairs, recordScan } = await import('../src/geo/tileCoverage');
  const seeded = seedTileScansFromPois(db, cats);
  // --rescan: an explicit pair list REPLACES the ledger-derived one. Bypassing
  // the "unscanned" filter is the whole point — these pairs are recorded in
  // the ledger but were never really searched.
  let pairs: Array<{ tile: { lat: number; lon: number; key: string }; category: string }>;
  if (RESCAN_FILE) {
    const want = JSON.parse(fs.readFileSync(RESCAN_FILE, 'utf8')) as Array<{ tile: string; category: string }>;
    pairs = [];
    for (const w of want) {
      if (!(cats as readonly string[]).includes(w.category)) continue;
      const [latS, lonS] = w.tile.split(',');
      const lat = parseFloat(latS), lon = parseFloat(lonS);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      pairs.push({ tile: { lat, lon, key: w.tile }, category: w.category });
    }
    log(`  --rescan: ${pairs.length} explicit pair(s) from ${RESCAN_FILE} (ledger filter bypassed)`);
  } else {
    pairs = uncoveredPairs(db, cats);
  }
  log(`  Coverage ledger: seeded ${seeded} pair(s); ${pairs.length} pair(s) to scan`
    + (SEARCH_LIMIT !== Infinity ? `, capped at ${SEARCH_LIMIT}` : ''));
  if (pairs.length === 0) {
    log('  ✓ Every tile × category already scanned — nothing to spend');
    return 0;
  }

  // THE IDENTITY RULE (the 678-row sin, never again): SerpApi returns
  // data_id (hex pair) + data_cid (decimal) on EVERY place in EVERY response.
  // They are the place's ID card — the only thing that merges "Амбасада на
  // Црна Гора" and "Црногорска Амбасада" into ONE place, and the key that
  // makes ?cid= place-card links work cluster-wide. Capture on EVERY row,
  // even rows we already have (the UPDATE path backfills identity for free).
  let inserted = 0;
  let identityBackfilled = 0;
  let enriched = 0;
  // THE SCRAPER CONTRACT: every field captured via serpCapture.capturePoi —
  // one mapping, unit-tested, no field silently dropped.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO pois (name, type, lat, lon, source, place_id,
      review_count, rating, plus_code, phone, website, price_level, closed, types)
     VALUES (?, ?, ?, ?, 'google', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const findByCid = db.prepare(`SELECT rowid FROM pois WHERE place_id = ?`);
  const updateCoords = db.prepare(`UPDATE pois SET lat = ?, lon = ? WHERE rowid = ?`);
  // Enrichment backfill: an existing row (by place_id) gets any capture
  // fields it predates — identity pattern, now applied to all fields.
  const updateAll = db.prepare(
    `UPDATE pois SET lat = ?, lon = ?, review_count = ?, rating = ?, plus_code = ?,
       phone = ?, website = ?, price_level = ?, closed = ?, types = ?
     WHERE rowid = ?`
  );
  let spent = 0;
  let consecutiveMisses = 0;
  for (const { tile, category: q } of pairs) {
    if (serpApiLeft < 20) {
      // The local counter can drift BELOW the truth (a stale keyLeft from a
      // failed /account probe reads as 0). On 2026-10-08 that phantom "19
      // left" abandoned ~740 real searches. /account is free — re-probe
      // before giving up budget.
      await refreshBudget();
      if (serpApiLeft < 20) {
        log(`  ⚠ Quota low (${serpApiLeft} left) — stopping SerpApi top-up`);
        break;
      }
    }
    if (spent >= SEARCH_LIMIT) {
      log(`  ⚠ Search limit (${SEARCH_LIMIT}) reached — stopping SerpApi top-up`);
      break;
    }
    const ll = `@${tile.lat},${tile.lon},15z`;
    const data = await serpApiSearch(q, ll);
    await sleep(1100);

    if (data == null) {
      // Every key is spent or hour-throttled, or the request failed. Nothing
      // was billed and nothing was recorded, so the pair stays UNCOVERED in
      // the ledger and the next run retries it. Stop cleanly rather than
      // grinding through the remaining list achieving nothing.
      if (++consecutiveMisses >= 5) {
        log(`  ⚠ No usable SerpApi key (spent or 250/hr-throttled) — stopping after ${spent} search(es)`);
        break;
      }
      continue;
    }
    consecutiveMisses = 0;

    const results = data?.local_results ?? data?.place_results ?? [];
    // place_results can be a single object instead of array
    const resultArray = Array.isArray(results) ? results : (results.title ? [results] : []);
    for (const r of resultArray) {
      const cap = capturePoi(r, q);
      if (!cap) continue;
      // BBOX GATE (the Walgreens lesson): Google's fuzzy geographic expansion
      // returns places FAR outside the map bounds — a Skopje search can still
      // surface "Walgreens Pharmacy" (California) or a New York hospital.
      // A POI outside Skopje can never be honestly "во близина" of anything.
      if (!insideSkopjeBbox(cap.lat, cap.lon)) continue;
      const info = insert.run(
        cap.name, cap.type, cap.lat, cap.lon, cap.place_id,
        cap.review_count, cap.rating, cap.plus_code, cap.phone,
        cap.website, cap.price_level, cap.closed, cap.types,
      );
      if (info.changes > 0) {
        inserted++;
      } else if (cap.place_id) {
        // Row exists but may predate identity/capture — backfill EVERYTHING
        // by place_id (coords + all capture fields).
        const existing = findByCid.get(cap.place_id) as { rowid: number } | undefined;
        if (existing) {
          updateAll.run(
            cap.lat, cap.lon, cap.review_count, cap.rating, cap.plus_code,
            cap.phone, cap.website, cap.price_level, cap.closed, cap.types,
            existing.rowid,
          );
          identityBackfilled++;
          enriched++;
        }
      }
    }
    // Record the pair ONLY on a real response — a network failure must be
    // retried next run, not marked done.
    if (data != null) {
      recordScan(db, tile, q);
      spent++;
    }
  }

  log(`  Inserted ${inserted} new Google POIs, backfilled ${identityBackfilled} rows (${enriched} with capture fields) (SerpApi left: ${serpApiLeft})`);
  return inserted;
}

// ── PHASE B2: Identity propagation — the map heals itself (bilingual) ──
// Two passes, in this order:
//   1. stripBlindFusions — undoes any pre-guard heal that adopted a WRONG
//      anchor (a row fused to the wrong embassy), releasing the stolen
//      identity so the row can be healed correctly below.
//   2. identityHeal — the bilingual merge: transliteration, a semantic
//      lexicon (Амбасада на Црна Гора ≡ Embassy of Montenegro), embassy
//      uniqueness, and a country-contradiction guard. This is what merges
//      the cross-language twins a same-normalized-name-only pass misses.
// Every OSM row that provably describes the same physical place as an
// IDENTIFIED Google anchor adopts Google's exact coordinates + place_id.
// This is the merge doing BY IDENTITY what the override file used to do BY
// HAND; wrong-pin-near-right-pin stops being a bug class.
function phaseB2(db: Database.Database): number {
  log('PHASE B2: Identity propagation (OSM ← Google anchors, bilingual)');
  const stripped = stripBlindFusions(db);
  const { healed } = identityHeal(db);
  if (stripped.stripped > 0) {
    log(`  Stripped ${stripped.stripped} blind fusions before healing (${stripped.kept} kept)`);
  }
  log(`  Healed ${healed} OSM rows from Google anchors (translit + semantic lexicon + embassy uniqueness)`);
  return healed;
}

// ── PHASE C: Queue drain ─────────────────────────────────────────────────────
async function phaseC(): Promise<number> {
  log('PHASE C: Queue drain');

  // The queue + landmarks cache live in the runtime DB (src/store/db schema).
  const { Db } = await import('../src/store/db');
  const runtimeDb = new Db(LINA_DB);

  let offlineMap: any = null;
  try {
    const mod = await import('../src/geo/offlineMap');
    offlineMap = new mod.OfflineMapStore(POIS_DB);
    if (!offlineMap.available) offlineMap = null;
  } catch {
    log('  ⚠ Offline map unavailable — cannot drain queue');
    runtimeDb.close();
    return 0;
  }

  // Real re-resolution (replaces the old delete-only stub):
  //   1. No trusted center → ONE budget-guarded SerpApi geocode → bbox-valid
  //      → geo_source upgraded to google_cached (never geocoded again).
  //   2. Landmark re-resolved OFFLINE against the refreshed merged POI table
  //      (cacheLandmark upgrade-only: osm_poi → google).
  //   3. Queue row deleted — outside-bbox / geocode-miss rows are drained too
  //      (never left looping); budget exhaustion leaves the rest for next month.
  const { drainQueue } = await import('../src/geo/queueDrain');
  const result = await drainQueue({
    db: runtimeDb,
    offlineMap,
    getProperty: async (propertyId: number) => {
      const row = await fetchPropertyByNumber(String(propertyId));
      if (!row) return undefined;
      return {
        propertyId,
        address: row.address ?? undefined,
        location: row.neighborhood ?? undefined,
        lat: row.lat,
        lon: row.lon,
        geo_source: row.geo_source,
      };
    },
    updatePropertyGeo: (propertyId: number, geo) => patchProperty(String(propertyId), geo),
    geocode: serpApiGeocode,
    searchesLeft: () => serpApiLeft,
  });

  log(`  Drained: ${result.processed} rows`);
  log(`    google_cached upgrades: ${result.googleUpgraded}`);
  log(`    landmarks re-cached: ${result.landmarkCached}`);
  if (result.budgetStopped > 0) {
    log(`  ⚠ Budget low — ${result.budgetStopped} rows left queued for next month`);
  }
  log(`  Queue now: ${result.leftInQueue} rows`);

  runtimeDb.close();
  return result.processed;
}

// ── PHASE D: Poison sweep ────────────────────────────────────────────────────
async function phaseD(): Promise<number> {
  log('PHASE D: Poison sweep');

  // Re-checks every CACHED landmark with a low-confidence tier (osm_poi /
  // osm_low_confidence) against the property's TRUSTED center + the refreshed
  // merged POI table. Stale ones are downgraded to osm_low_confidence
  // (landmark_name untouched — canServeLandmark blocks serving) and enqueued
  // with reason 'poison_sweep' so next month's Phase C re-resolves them.
  const { Db } = await import('../src/store/db');
  const runtimeDb = new Db(LINA_DB);

  let offlineMap: any = null;
  try {
    const mod = await import('../src/geo/offlineMap');
    offlineMap = new mod.OfflineMapStore(POIS_DB);
    if (!offlineMap.available) offlineMap = null;
  } catch {
    log('  ⚠ Offline map unavailable — cannot poison sweep');
    runtimeDb.close();
    return 0;
  }

  const { sweepPoison } = await import('../src/geo/poisonSweep');
  const result = await sweepPoison({
    db: runtimeDb,
    offlineMap,
    getProperty: async (propertyId: number) => {
      const row = await fetchPropertyByNumber(String(propertyId));
      if (!row) return undefined;
      return {
        propertyId,
        lat: row.lat,
        lon: row.lon,
        geo_source: row.geo_source,
      };
    },
  });

  log(`  Checked: ${result.checked} cached landmarks (osm_poi/osm_low_confidence)`);
  log(`    downgraded to osm_low_confidence: ${result.downgraded}`);
  log(`    verified (kept): ${result.verified}`);
  log(`    orphan cache rows deleted: ${result.orphaned}`);
  log(`    enqueued for next drain: ${result.queued}`);
  log(`  geo_reresolve_queue now: ${result.leftQueued} rows`);

  runtimeDb.close();
  return result.downgraded;
}

// ── PHASE B3: Map self-learning — teach the map every missing street ────────
// For EVERY Supabase property whose street the local snapshot can't resolve
// (import-time low-confidence), ask Google ONCE and write the street+number
// → coords pair back into skopje-pois.db. After this pass, the SAME street
// resolves OFFLINE forever — including for future properties on it. Google
// Maps finds any street a human can find; this pass copies that knowledge
// into the hybrid so "street not found" converges to zero.
async function phaseB3(): Promise<{ taught: number; alreadyKnown: number; upgraded: number; failed: number }> {
  log('PHASE B3: Map self-learning (teach every unknown street via Google)');
  const stats = { taught: 0, alreadyKnown: 0, upgraded: 0, failed: 0 };
  if (SERPAPI_KEYS.length === 0) {
    log('  No SerpApi keys — skipping');
    return stats;
  }
  const { insideBbox, BUDGET_STOP } = await import('../src/geo/queueDrain');
  const { OfflineMapStore } = await import('../src/geo/offlineMap');

  // The live map DB (read-write — learnAddress writes into it).
  const map = new OfflineMapStore(POIS_DB);
  if (!map.available) {
    log('  ⚠ Offline map unavailable — cannot teach');
    return stats;
  }

  // Every property in the feed, paginated.
  const props: SupabasePropertyRow[] = [];
  for (let from = 0; ; from += 1000) {
    const url = `${SUPABASE_URL}/rest/v1/properties?select=property_number,address,neighborhood,lat,lon,geo_source&limit=1000&offset=${from}`;
    const res = await fetch(url, { headers: restHeaders() });
    if (!res.ok) { log(`  ⚠ Supabase fetch failed: ${res.status}`); break; }
    const page = await res.json() as SupabasePropertyRow[];
    props.push(...page);
    if (page.length < 1000) break;
  }
  log(`  Feed rows: ${props.length}`);

  for (const p of props) {
    if (serpApiLeft < BUDGET_STOP) {
      log(`  ⚠ Quota low (${serpApiLeft} left) — stopping B3; remaining streets teach next month`);
      break;
    }
    if (!p.address || p.address.trim().length < 3) continue;
    // Only rows the map canNOT resolve trusted — the exact gap B3 exists to close.
    const offline = map.resolvePropertyOffline(p.address);
    if (offline.trusted) { stats.alreadyKnown++; continue; }

    const geo = await serpApiGeocode(p.address);
    if (!geo || !insideBbox(geo.lat, geo.lon)) {
      stats.failed++;
      log(`  ✗ EB ${p.property_number} "${p.address}" — geocode miss/outside bbox`);
      continue;
    }
    // Teach the map (the growth loop) AND upgrade the property row when it
    // was still low-confidence — one Google call fixes both.
    if (map.learnAddress(p.address, geo.lat, geo.lon)) stats.taught++;
    if (p.geo_source === 'osm_low_confidence') {
      try {
        await patchProperty(String(p.property_number), {
          lat: geo.lat, lon: geo.lon,
          geo_source: 'google_cached',
          geocoded_at: new Date().toISOString(),
        });
        stats.upgraded++;
      } catch (e) { log(`  ⚠ patch EB ${p.property_number} failed: ${(e as Error).message}`); }
    }
    log(`  ✓ EB ${p.property_number} "${p.address}" → taught (${geo.lat},${geo.lon})`);
    await sleep(1100);
  }

  log(`  Streets taught: ${stats.taught} (already known: ${stats.alreadyKnown}, properties upgraded: ${stats.upgraded}, misses: ${stats.failed})`);
  map.close();
  return stats;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log('=== refresh-monthly: monthly POI refresh ===\n');

  const db = new Database(POIS_DB);

  // SCHEMA SELF-UPGRADE (appliance rule: the script upgrades any DB it runs
  // against — Lenovo, T60, T620, atom — never fails on an older file).
  // osm_key: OSM identity ("node/123") — UNIQUE index makes phaseA's
  // INSERT OR IGNORE actually dedupe across monthly runs. place_id: Google
  // identity — indexed (non-unique: two spellings of one place share an id
  // BY DESIGN; the query-time merge collapses them).
  // place_id gets a partial UNIQUE so re-scrapes UPDATE existing rows
  // instead of INSERT-ing duplicates. The non-unique idx_pois_place_id stays
  // for fast lookups; the UNIQUE one enforces identity-level dedupe.
  const cols = (db.prepare('PRAGMA table_info(pois)').all() as Array<{ name: string }>).map(c => c.name);
  if (!cols.includes('osm_key')) db.exec('ALTER TABLE pois ADD COLUMN osm_key TEXT');
  if (!cols.includes('place_id')) db.exec('ALTER TABLE pois ADD COLUMN place_id TEXT');

  // THE IDENTITY RULE (Fix C, runtime): before the UNIQUE(place_id) index,
  // collapse any pre-existing duplicate place_id rows into one survivor.
  // We keep the MIN(rowid) per place_id (oldest, most-established row);
  // Phase B's re-scrape backfills ALL capture fields via updateAll on the
  // next pass, so no data is permanently lost. This is idempotent — a DB
  // that's already clean skips the block. Without this, the UNIQUE index
  // creation fails with SQLITE_CONSTRAINT_UNIQUE on legacy dupes.
  const dupeGroups = (db.prepare(
    `SELECT place_id FROM pois WHERE place_id IS NOT NULL GROUP BY place_id HAVING COUNT(*) > 1`
  ).all() as Array<{ place_id: string }>).length;
  if (dupeGroups > 0) {
    log(`  Collapsing ${dupeGroups} duplicate place_id groups`);
    db.exec(
      `DELETE FROM pois
         WHERE place_id IS NOT NULL
         AND rowid NOT IN (
           SELECT MIN(rowid) FROM pois WHERE place_id IS NOT NULL GROUP BY place_id
         )`
    );
    log(`  ✓ Collapsed to one row per place_id`);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pois_osm_key ON pois(osm_key) WHERE osm_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_pois_place_id ON pois(place_id) WHERE place_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pois_place_id_unique ON pois(place_id) WHERE place_id IS NOT NULL;
  `);

  const initialCount = (db.prepare('SELECT COUNT(*) as c FROM pois').get() as { c: number }).c;
  log(`Initial POI count: ${initialCount}\n`);

  // THE SCRAPER CONTRACT, schema-first: make sure the live map carries every
  // capture column BEFORE Phase B writes (old DBs get the new columns here,
  // one-time). Idempotent — a current schema adds nothing.
  try {
    const { OfflineMapStore } = await import('../src/geo/offlineMap');
    const upgradeMap = new OfflineMapStore(POIS_DB);
    if (upgradeMap.available) {
      const added = upgradeMap.ensurePoiColumns();
      if (added.length > 0) log(`Schema self-upgrade: added pois columns: ${added.join(', ')}`);
      upgradeMap.close();
    }
  } catch (e) { log(`⚠ Schema self-upgrade skipped: ${(e as Error).message}`); }

  // ── DRY RUN ─────────────────────────────────────────────────────────
  // Report the exact spend a real run would incur and exit. No key is
  // touched, no POI is written. This is the check that must be read before
  // any real pass (the drained-keys lesson).
  if (DRY_RUN) {
    const { planCoverage, seedTileScansFromPois } = await import('../src/geo/tileCoverage');
    const { categoriesForRun } = await import('../src/geo/serpCapture');
    const cats = categoriesForRun(RUN_FLAG);
    const seeded = seedTileScansFromPois(db, cats);
    const plan = planCoverage(db, cats);
    log('=== DRY RUN (no keys touched) ===');
    log(`  Cadence: ${RUN_FLAG ?? 'auto'} — ${cats.length} categories`);
    log(`  Grid: ${plan.totalTiles} tiles × ${cats.length} categories = ${plan.totalPairs} pairs`);
    log(`  Already scanned: ${plan.scannedPairs} pairs (ledger seeded this run: ${seeded})`);
    log(`  Unscanned pairs (tiles touched: ${plan.uncoveredTiles}): ${plan.uncoveredPairs}`);
    log(`  ESTIMATED SEARCHES to finish the pass: ${plan.estimatedSearches}`);
    log(`  Keys loaded: ${SERPAPI_KEYS.length} (free plan = 250 each)`);
    if (SEARCH_LIMIT !== Infinity) log(`  --limit would cap this run at: ${SEARCH_LIMIT}`);
    log(`  Budget floor per run: 20 searches (hard stop)`);
    db.close();
    return;
  }

  // Phase A: OSM restore. Skipped on a --rescan repair run: OSM rows have
  // nothing to do with the ledger being repaired, and Overpass is by far the
  // slowest, flakiest part of the pipeline (mirrors throwing 504/406/429 have
  // stalled it for minutes while a repair run only needed Phase B).
  const osmInserted = RESCAN_FILE ? 0 : await phaseA(db);
  if (!RESCAN_FILE) console.log('');

  // Phase B: SerpApi top-up
  await refreshBudget();
  log(`SerpApi budget: ${serpApiLeft} searches left across ${SERPAPI_KEYS.length} keys`);
  const googleInserted = await phaseB(db);
  console.log('');

  // A --rescan run is a TARGETED Phase-B repair: it stops here on purpose, so
  // it neither spends the street-teach budget nor touches Supabase. Run the
  // normal pipeline for B2/B3/C/D.
  if (RESCAN_FILE) {
    log('=== Rescan summary (Phase B only) ===');
    log(`  Google inserted: ${googleInserted}`);
    log(`  SerpApi remaining: ${serpApiLeft}`);
    db.close();
    return;
  }

  // Phase B2: Identity propagation
  const healed = phaseB2(db);
  console.log('');

  // Phase B3: Map self-learning — teach every unknown street via Google
  const learned = await phaseB3();
  console.log('');

  // Phase C: Queue drain
  const queueDrained = await phaseC();
  console.log('');

  // Phase D: Poison sweep
  const poisonDowngraded = await phaseD();
  console.log('');

  // Summary
  const finalCount = (db.prepare('SELECT COUNT(*) as c FROM pois').get() as { c: number }).c;
  const bySource = db.prepare('SELECT source, COUNT(*) as c FROM pois GROUP BY source').all() as Array<{ source: string; c: number }>;

  log('=== Summary ===');
  log(`  POIs: ${initialCount} → ${finalCount} (+${finalCount - initialCount})`);
  for (const s of bySource) log(`    ${s.source}: ${s.c}`);
  log(`  OSM inserted: ${osmInserted}`);
  log(`  Google inserted: ${googleInserted}`);
  log(`  Identity-healed OSM rows: ${healed}`);
  log(`  Map streets taught: ${learned.taught} (properties upgraded: ${learned.upgraded})`);
  log(`  Queue drained: ${queueDrained}`);
  log(`  Poison sweep downgraded: ${poisonDowngraded}`);
  log(`  SerpApi remaining: ${serpApiLeft}`);

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
