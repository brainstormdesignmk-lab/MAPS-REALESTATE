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
let serpApiLeft = 250;

async function serpApiSearch(query: string, ll?: string): Promise<any> {
  if (SERPAPI_KEYS.length === 0) return null;
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
    if (data?.error?.includes('run out')) {
      keyIdx++;
      if (keyIdx >= SERPAPI_KEYS.length) return null;
      return serpApiSearch(query, ll);
    }
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
      keyIdx++;
      if (keyIdx >= SERPAPI_KEYS.length) return null;
      return serpApiGeocode(address);
    }
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
            const type = el.tags?.amenity ?? el.tags?.shop ?? el.tags?.leisure ?? el.tags?.tourism ?? el.tags?.office ?? el.tags?.craft ?? el.tags?.building ?? 'place';
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

  return inserted;
}

// ── PHASE B: SerpApi top-up ──────────────────────────────────────────────────
async function phaseB(db: Database.Database): Promise<number> {
  log('PHASE B: SerpApi top-up');

  if (SERPAPI_KEYS.length === 0) {
    log('  No SerpApi keys — skipping');
    return 0;
  }

  // 0.01° tile grid over urban Skopje (~36 tiles)
  const tiles: Array<{ lat: number; lon: number }> = [];
  for (let lat = 41.96; lat <= 42.04; lat += 0.01) {
    for (let lon = 21.36; lon <= 21.50; lon += 0.01) {
      tiles.push({ lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 });
    }
  }

  const queries = ['supermarket', 'pharmacy'];
  let inserted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO pois (name, type, lat, lon, source) VALUES (?, ?, ?, ?, 'google')`
  );

  for (const tile of tiles) {
    if (serpApiLeft < 20) {
      log(`  ⚠ Quota low (${serpApiLeft} left) — stopping SerpApi top-up`);
      break;
    }

    for (const q of queries) {
      if (serpApiLeft < 20) break;
      const ll = `@${tile.lat},${tile.lon},15z`;
      const data = await serpApiSearch(q, ll);
      await sleep(1100);

      const results = data?.local_results ?? data?.place_results ?? [];
      // place_results can be a single object instead of array
      const resultArray = Array.isArray(results) ? results : (results.title ? [results] : []);
      for (const r of resultArray) {
        const name = r.title;
        if (!name || name.length < 2) continue;
        const lat = r.gps_coordinates?.latitude;
        const lon = r.gps_coordinates?.longitude;
        if (!lat || !lon) continue;
        const type = r.type ?? q;
        const info = insert.run(name, type, lat, lon);
        if (info.changes > 0) inserted++;
      }
    }
  }

  log(`  Inserted ${inserted} new Google POIs (SerpApi left: ${serpApiLeft})`);
  return inserted;
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

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log('=== refresh-monthly: monthly POI refresh ===\n');

  const db = new Database(POIS_DB);

  const initialCount = (db.prepare('SELECT COUNT(*) as c FROM pois').get() as { c: number }).c;
  log(`Initial POI count: ${initialCount}\n`);

  // Phase A: OSM restore
  const osmInserted = await phaseA(db);
  console.log('');

  // Phase B: SerpApi top-up
  const googleInserted = await phaseB(db);
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
  log(`  Queue drained: ${queueDrained}`);
  log(`  Poison sweep downgraded: ${poisonDowngraded}`);
  log(`  SerpApi remaining: ${serpApiLeft}`);

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
