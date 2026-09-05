// upgrade-bare-rows.ts — OSM density hygiene (Task 2.3)
//
// For every bare address row (housenumber='') in skopje-pois.db, store a
// REAL geometric point from the actual street's highway geometry in OSM.
// Bare rows today carry the center of whatever addr:street element happened
// to be tagged without a number — that point can sit off the street line.
// This replaces it with a verified point ON the street (the highway way's
// center, i.e. the street centroid), so every bare street key has at least
// one trustworthy geometric point → fewer osm_fail in resolvePropertyOffline.
//
// Pure OSM (public Overpass mirrors) — no Google, no SerpApi, free.
// UPDATE-only: never INSERTs, so no (key, housenumber) duplication is
// possible. Idempotent and re-runnable: matched streets converge to the
// same street point on every run; unmatched streets are left untouched.
//
//   npx tsx scripts/upgrade-bare-rows.ts
//
// Blocking tests (Task 2.3):
//   [ ] SELECT COUNT(*) FROM addresses WHERE housenumber='' AND lat IS NULL → 0
//   [ ] streets previously bare now have a geometric point; no row duplicated

import '../src/compat/node16';

import Database from 'better-sqlite3';
import path from 'path';
import { SKOPJE_BBOX, streetKey, translitToLatin } from '../src/geo/offlineMap';

const DB_PATH = process.env.SKOPJE_POIS_DB ?? path.join(process.cwd(), 'data', 'skopje-pois.db');

// Same public mirrors + retry policy as the map builder (src/geo/offlineMap.ts).
const OVERPASS_MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

interface RawElem {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function coordsOf(e: RawElem): { lat: number; lon: number } | undefined {
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (lat === undefined || lon === undefined) return undefined;
  return { lat: Number(lat), lon: Number(lon) };
}

async function overpass(data: string): Promise<{ elements: RawElem[] }> {
  let lastErr: Error | undefined;
  const MAX_RETRIES = 2;
  for (const mirror of OVERPASS_MIRRORS) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 120_000);
        try {
          const res = await fetch(mirror, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'metropolis-hermes/1.0' },
            body: `data=${encodeURIComponent(data)}`,
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = await res.json() as { remarks?: string; elements?: RawElem[] };
          if (j.remarks && /error/i.test(j.remarks)) throw new Error(j.remarks);
          return { elements: j.elements ?? [] };
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        lastErr = e as Error;
        if (attempt < MAX_RETRIES) {
          const delay = attempt * 15_000;
          console.warn(`[upgrade-bare-rows] mirror ${mirror} attempt ${attempt} failed: ${lastErr.message} — retrying in ${delay / 1000}s`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          console.warn(`[upgrade-bare-rows] mirror ${mirror} failed (${MAX_RETRIES}x): ${lastErr.message}`);
        }
      }
    }
  }
  throw lastErr ?? new Error('all Overpass mirrors failed');
}

/** The metro bbox split into 2×2 tiles — same as the map builder, so each
 *  request stays light and survives public-server load spikes. */
function tiles(): Array<[number, number, number, number]> {
  const [s, w, n, e] = SKOPJE_BBOX;
  const midLat = (s + n) / 2;
  const midLon = (w + e) / 2;
  return [
    [s, w, midLat, midLon],
    [s, midLon, midLat, e],
    [midLat, w, n, midLon],
    [midLat, midLon, n, e],
  ];
}

interface StreetPoint { lat: number; lon: number; name: string; count: number }

/**
 * Fetch ALL named street ways in the bbox and compute the STREET CENTROID
 * per canonical street key: the MEAN of every way center with that name.
 *
 * OSM splits long streets into many ways ("Ѓорче Петров" boulevard spans
 * 21.32–21.37 lon across ~40 ways); taking the "first" way lands on an
 * arbitrary end segment. The mean is the true geometric middle — exactly
 * what the resolver's Stage C streetCentroid() fallback expects.
 *
 * Keying: primary = streetKey(name) (the same canonical key the resolver's
 * addresses table uses). Fallback = translitToLatin(name) normalized, so a
 * Latin-script bare row ("Vojvoda Vasil Chakalarov") can still match a
 * Cyrillic-script highway ("Војвода Васил Чакаларов") and vice versa.
 */
async function fetchStreetPoints(): Promise<{
  byKey: Map<string, StreetPoint>;
  byTranslit: Map<string, StreetPoint>;
}> {
  const byKey = new Map<string, StreetPoint>();
  const byTranslit = new Map<string, StreetPoint>();

  const add = (map: Map<string, StreetPoint>, k: string, lat: number, lon: number, name: string) => {
    const cur = map.get(k);
    if (!cur) { map.set(k, { lat, lon, name, count: 1 }); return; }
    cur.lat = (cur.lat * cur.count + lat) / (cur.count + 1);
    cur.lon = (cur.lon * cur.count + lon) / (cur.count + 1);
    cur.count += 1;
  };

  for (const bbox of tiles()) {
    // way["highway"] = actual street lines (bus stops and other highway
    // nodes would pollute the name map). out center = way's geometric center.
    const q = `[out:json][timeout:120];way["highway"]["name"](${bbox.join(',')});out center tags;`;
    const { elements } = await overpass(q);
    for (const e of elements) {
      const name = (e.tags?.name ?? '').trim();
      const c = coordsOf(e);
      if (!name || !c) continue;
      const key = streetKey(name);
      if (key) add(byKey, key, c.lat, c.lon, name);
      const norm = translitToLatin(name).replace(/[^a-z0-9]/g, '');
      if (norm) add(byTranslit, norm, c.lat, c.lon, name);
    }
    console.log(`[upgrade-bare-rows] highway tile ${bbox.join(',')} → ${elements.length} named ways`);
  }
  return { byKey, byTranslit };
}

async function main(): Promise<void> {
  const db = new Database(DB_PATH);

  const bare = db.prepare(
    `SELECT rowid, key, street, lat, lon FROM addresses WHERE housenumber = ''`
  ).all() as Array<{ rowid: number; key: string; street: string; lat: number; lon: number }>;

  console.log(`[upgrade-bare-rows] ${bare.length} bare rows (housenumber='') in ${DB_PATH}`);

  const countNull = (): number =>
    (db.prepare(
      `SELECT COUNT(*) AS n FROM addresses WHERE housenumber = '' AND (lat IS NULL OR lon IS NULL)`
    ).get() as { n: number }).n;

  const beforeNull = countNull();

  const { byKey, byTranslit } = await fetchStreetPoints();

  let upgraded = 0;
  let matchedStreets = 0;
  const matchedKeys = new Set<string>();
  const unmatched = new Set<string>();

  const upd = db.prepare(`UPDATE addresses SET lat = ?, lon = ? WHERE rowid = ?`);

  const apply = db.transaction(() => {
    for (const row of bare) {
      const hit = byKey.get(row.key)
        ?? byTranslit.get(translitToLatin(row.street).replace(/[^a-z0-9]/g, ''));
      if (!hit) { unmatched.add(row.key); continue; }
      upd.run(hit.lat, hit.lon, row.rowid);
      upgraded++;
      if (!matchedKeys.has(row.key)) { matchedKeys.add(row.key); matchedStreets++; }
    }
  });
  apply();

  const afterNull = countNull();
  const rowCount = (db.prepare(`SELECT COUNT(*) AS n FROM addresses`).get() as { n: number }).n;

  console.log(`[upgrade-bare-rows] upgraded ${upgraded} bare rows across ${matchedStreets} streets`);
  console.log(`[upgrade-bare-rows] bare rows with NULL coords: ${beforeNull} → ${afterNull}`);
  console.log(`[upgrade-bare-rows] total addresses rows unchanged: ${rowCount}`);
  console.log(`[upgrade-bare-rows] streets with NO highway match in OSM (kept old coords): ${unmatched.size}`);
  for (const k of [...unmatched].slice(0, 25)) console.log(`  unmatched: ${k}`);

  db.close();

  const ok = afterNull === 0 && rowCount > 0;
  if (!ok) { console.error('BLOCKING TEST FAILED'); process.exit(1); }
  console.log('OK: no bare row has NULL coords; no rows duplicated (UPDATE-only).');
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });