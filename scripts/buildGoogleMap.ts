/**
 * Build skopje-pois.db from Google Maps via SerpApi.
 *
 * Tiles Skopje into a grid, queries Google Maps for POIs in each tile,
 * and writes the results to the same SQLite schema used by OfflineMapStore.
 *
 * Usage:
 *   npx tsx scripts/buildGoogleMap.ts              # full build
 *   npx tsx scripts/buildGoogleMap.ts --dry-run    # report only, no writes
 *   npx tsx scripts/buildGoogleMap.ts --pilot 3    # test with 3 tiles only
 *
 * Requires: SERPAPI_KEY env var or data/serpapi-key.txt
 */

import '../src/compat/node16';

import { writeMap } from '../src/geo/offlineMap';
import * as fs from 'fs';
import * as path from 'path';

process.on('uncaughtException', (err) => {
  console.error('[build-google-map] UNCAUGHT:', err.message, err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (err: any) => {
  console.error('[build-google-map] UNHANDLED REJECTION:', err?.message ?? err);
  process.exit(1);
});

// ── Config ──────────────────────────────────────────────────────────────────

const SERPAPI_KEY =
  process.env.SERPAPI_KEY
  ?? (fs.existsSync('data/serpapi-key.txt')
    ? fs.readFileSync('data/serpapi-key.txt', 'utf8').trim()
    : fs.existsSync('GOOGLEMAPS_API_KEY.txt')
    ? fs.readFileSync('GOOGLEMAPS_API_KEY.txt', 'utf8').trim()
    : '');

const DB_PATH = process.env.SKOPJE_POIS_DB || 'data/skopje-pois.db';

// Skopje bounding box
const LAT_MIN = 41.95;
const LAT_MAX = 42.03;
const LON_MIN = 21.37;
const LON_MAX = 21.47;
const TILE_SIZE = 0.009; // ~1km tiles

// POI types to search for — these are the landmarks people use for navigation.
// Free tier: 50 queries/hour → 3 types per tile = 324 total queries = ~6.5 hours.
// Each type covers a broad category that Google Maps groups well.
const POI_TYPES = [
  'school hospital clinic',     // institutional — schools, clinics are top navigation landmarks
  'supermarket mall pharmacy',   // shopping — Ramstore, Tinex, Eurofarm are universally known
];
// Note: 3rd type (park church mosque hotel) dropped to stay under 250/month free tier.
// 108 tiles × 2 types = 216 queries — fits within 243 remaining.

// Type mapping: SerpApi type → our DB type
const TYPE_MAP: Record<string, string> = {
  'school': 'school',
  'primary school': 'school',
  'high school': 'school',
  'university': 'university',
  'college': 'university',
  'hospital': 'hospital',
  'general hospital': 'hospital',
  'university hospital': 'hospital',
  'clinic': 'clinic',
  'supermarket': 'supermarket',
  'convenience store': 'supermarket',
  'grocery store': 'supermarket',
  'shopping mall': 'mall',
  'shopping centre': 'mall',
  'department store': 'mall',
  'pharmacy': 'pharmacy',
  'chemist': 'pharmacy',
  'bank': 'bank',
  'atm': 'bank',
  'hotel': 'hotel',
  'motel': 'hotel',
  'hostel': 'hotel',
  'park': 'park',
  'garden': 'park',
  'playground': 'park',
  'church': 'church',
  'mosque': 'mosque',
  'synagogue': 'church',
  'museum': 'museum',
  'library': 'library',
  'stadium': 'stadium',
  'sports centre': 'stadium',
  'theatre': 'theatre',
  'cinema': 'theatre',
  'restaurant': 'restaurant',
  'cafe': 'cafe',
  'bar': 'bar',
  'tourist attraction': 'tourist_attraction',
  'historical landmark': 'tourist_attraction',
  'bridge': 'tourist_attraction',
  'square': 'square',
  'embassy': 'embassy',
  'diplomatic': 'embassy',
  'police': 'police',
  'fire station': 'fire_station',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

interface Poi {
  name: string;
  type: string;
  lat: number;
  lon: number;
}

interface Tile {
  lat: number;
  lon: number;
  row: number;
  col: number;
}

/** Generate the grid of tiles covering Skopje. */
function generateTiles(): Tile[] {
  const tiles: Tile[] = [];
  let row = 0;
  for (let lat = LAT_MIN; lat < LAT_MAX; lat += TILE_SIZE) {
    let col = 0;
    for (let lon = LON_MIN; lon < LON_MAX; lon += TILE_SIZE) {
      tiles.push({
        lat: lat + TILE_SIZE / 2,
        lon: lon + TILE_SIZE / 2,
        row,
        col,
      });
      col++;
    }
    row++;
  }
  return tiles;
}

/** Map a SerpApi result type to our DB type. */
function mapType(rawType: string): string {
  const lower = rawType.toLowerCase();
  // Direct match
  if (TYPE_MAP[lower]) return TYPE_MAP[lower];
  // Partial match
  for (const [key, val] of Object.entries(TYPE_MAP)) {
    if (lower.includes(key)) return val;
  }
  return 'other';
}

/** Fetch POIs from SerpApi for a given query and coordinates. */
async function fetchSerpApi(
  query: string,
  lat: number,
  lon: number,
): Promise<Poi[]> {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_maps');
  url.searchParams.set('q', query);
  url.searchParams.set('type', 'search');
  url.searchParams.set('ll', `@${lat},${lon},15z`);
  url.searchParams.set('nearby', 'true');
  url.searchParams.set('api_key', SERPAPI_KEY);
  url.searchParams.set('hl', 'en');

  let res: Response;
  try {
    res = await fetch(url.toString());
  } catch (err: any) {
    console.warn(`  ⚠ Network error for "${query}": ${err.message} — SKIPPING`);
    return [];
  }
  // On 429: wait 90s then retry ONCE. If still 429, skip — progress file keeps it for next run.
  if (res.status === 429) {
    console.log(`  ⏳ Rate limited on "${query}", waiting 90s...`);
    await sleep(90_000);
    try {
      res = await fetch(url.toString());
    } catch (err: any) {
      console.warn(`  ⚠ Network error on retry: ${err.message} — SKIPPING`);
      return [];
    }
  }
  if (res.status === 429) {
    console.warn(`  ⚠ Still rate limited for "${query}" — will resume on next run`);
    return [];
  }
  if (!res.ok) {
    console.warn(`  ⚠ HTTP ${res.status} for "${query}" — SKIPPING`);
    return [];
  }

  const data = await res.json() as any;
  const results = data.local_results ?? [];
  const pois: Poi[] = [];

  for (const r of results) {
    const gps = r.gps_coordinates;
    if (!gps?.latitude || !gps?.longitude) continue;
    const name = (r.title ?? '').trim();
    if (!name || name.length < 2) continue;
    const type = mapType(r.type ?? '');
    pois.push({ name, type, lat: gps.latitude, lon: gps.longitude });
  }

  return pois;
}

/** Fetch all POIs for a single tile (all POI types). */
async function fetchTile(tile: Tile): Promise<Poi[]> {
  const allPois: Poi[] = [];
  for (const poiType of POI_TYPES) {
    const query = `${poiType} near ${tile.lat.toFixed(4)} ${tile.lon.toFixed(4)} Skopje`;
    const pois = await fetchSerpApi(query, tile.lat, tile.lon);
    allPois.push(...pois);
    // Rate limit: 50/hour on free tier → 72s between requests.
    // Be conservative: 75s between requests to stay under limit.
    await sleep(75_000);
  }
  return allPois;
}

/** Dedupe POIs by name (case-insensitive). When same name appears multiple
 *  times (from different tiles), keep the first occurrence. */
function dedupe(pois: Poi[]): Poi[] {
  const seen = new Map<string, Poi>();
  for (const p of pois) {
    const key = p.name.toLowerCase().replace(/\s+/g, ' ');
    if (!seen.has(key)) {
      seen.set(key, p);
    }
  }
  return Array.from(seen.values());
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const pilotIdx = process.argv.indexOf('--pilot');
  const pilotCount = pilotIdx >= 0 ? parseInt(process.argv[pilotIdx + 1] || '3', 10) : 0;

  if (!SERPAPI_KEY) {
    console.error('No SERPAPI_KEY found. Set env var or create data/serpapi-key.txt');
    process.exit(1);
  }

  const tiles = generateTiles();
  const tilesToProcess = pilotCount > 0 ? tiles.slice(0, pilotCount) : tiles;

  console.log(`[build-google-map] Skopje grid: ${tiles.length} tiles`);
  console.log(`[build-google-map] Processing: ${tilesToProcess.length} tiles`);
  console.log(`[build-google-map] POI types per tile: ${POI_TYPES.length}`);
  console.log(`[build-google-map] Total queries: ${tilesToProcess.length * POI_TYPES.length}`);
  console.log(`[build-google-map] Estimated time: ~${Math.round(tilesToProcess.length * POI_TYPES.length * 2 / 60)} minutes`);
  console.log('');

  if (dryRun) {
    console.log('[build-google-map] DRY RUN — no queries will be made');
    tilesToProcess.forEach((t, i) => {
      console.log(`  Tile ${i + 1}: @${t.lat.toFixed(4)},${t.lon.toFixed(4)}`);
    });
    return;
  }

  // Load progress — resume from last completed tile
  const progressFile = path.join(path.dirname(DB_PATH), '.build-google-progress.json');
  let completedTiles = new Set<string>();
  let allPois: Poi[] = [];
  try {
    const progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
    completedTiles = new Set(progress.completedTiles ?? []);
    allPois = progress.pois ?? [];
    console.log(`[build-google-map] Resuming: ${completedTiles.size} tiles already done, ${allPois.length} POIs collected`);
  } catch { /* first run */ }

  let queriesMade = 0;
  const startTime = Date.now();

  for (let i = 0; i < tilesToProcess.length; i++) {
    const tile = tilesToProcess[i];
    const tileKey = `${tile.lat.toFixed(4)},${tile.lon.toFixed(4)}`;
    if (completedTiles.has(tileKey)) {
      console.log(`[tile ${i + 1}/${tilesToProcess.length}] @${tileKey} — already done, skipping`);
      continue;
    }

    const elapsed = Date.now() - startTime;
    const perTile = elapsed / (Math.max(1, completedTiles.size) - (completedTiles.size > 0 ? 0 : 0) + i + 1);
    const remaining = Math.round(perTile * (tilesToProcess.length - completedTiles.size - i - 1) / 60_000);
    console.log(`[tile ${i + 1}/${tilesToProcess.length}] @${tileKey} (ETA: ${remaining}min)`);

    const tilePois = await fetchTile(tile);
    allPois.push(...tilePois);
    queriesMade += POI_TYPES.length;
    completedTiles.add(tileKey);

    console.log(`  → ${tilePois.length} POIs (total: ${allPois.length}, queries: ${queriesMade})`);

    // Save progress after each tile
    fs.writeFileSync(progressFile, JSON.stringify({
      completedTiles: Array.from(completedTiles),
      pois: allPois,
    }));
  }

  // Dedupe
  const deduped = dedupe(allPois);
  console.log(`\n[build-google-map] Before dedup: ${allPois.length} POIs`);
  console.log(`[build-google-map] After dedup: ${deduped.length} POIs`);

  // Type breakdown
  const byType = new Map<string, number>();
  for (const p of deduped) {
    byType.set(p.type, (byType.get(p.type) ?? 0) + 1);
  }
  console.log('\n[build-google-map] By type:');
  for (const [type, count] of Array.from(byType.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  // Read existing addresses from current DB (preserve OSM address data)
  let existingAddresses: Array<{ street: string; housenumber: string; lat: number; lon: number }> = [];
  try {
    const Database = (await import('better-sqlite3')).default;
    const oldDb = new Database(DB_PATH, { readonly: true });
    existingAddresses = oldDb.prepare('SELECT street, housenumber, lat, lon FROM addresses').all() as any[];
    oldDb.close();
    console.log(`[build-google-map] Preserved ${existingAddresses.length} existing addresses`);
  } catch { /* no existing DB */ }

  // Write to DB
  console.log(`\n[build-google-map] Writing to ${DB_PATH}...`);
  const stats = writeMap(DB_PATH, deduped, existingAddresses);
  console.log(`[build-google-map] Done: ${stats.pois} POIs, ${stats.addresses ?? 0} addresses, ${stats.bytes} bytes`);
}

main().catch(e => {
  console.error('[build-google-map] FATAL:', e);
  process.exit(1);
});
