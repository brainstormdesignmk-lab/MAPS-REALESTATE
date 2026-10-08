// THE SPEND-GUARD LEDGER (the drained-keys lesson, made policy):
// Phase B burns one SerpApi search per (tile × category). Two passes were
// fired without knowing what was already scanned, and the second re-walked
// ground the first had covered — 687 searches to gain 199 POIs. This module
// remembers every (tile, category) pair that has been scanned so a resumed
// run scans only the GAPS, and it can estimate the spend BEFORE a single
// key is touched. A run must never spend blind again.
//
// The ledger is seeded from existing Google POIs (a tile×cat that already
// produced a row has been searched) and then grows as phaseB records each
// completed search — including searches that returned nothing, so they are
// never repeated.

import type Database from 'better-sqlite3';

/** 0.01° grid over urban Skopje — identical to the original Phase B loop. */
export const TILE_STEP = 0.01;
export const TILE_LAT_MIN = 41.96;
export const TILE_LAT_MAX = 42.04;
export const TILE_LON_MIN = 21.36;
export const TILE_LON_MAX = 21.5;

export interface Tile {
  lat: number;
  lon: number;
  key: string;
}

/** Stable ledger key for a tile. Also the map from coords → tile. */
export function tileKey(lat: number, lon: number): string {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

/** The exact tile set Phase B walks. Integer-indexed so there is no float
 *  drift: 9 latitudes × 15 longitudes = 135 tiles. */
export function buildTiles(): Tile[] {
  const tiles: Tile[] = [];
  const nLat = Math.round((TILE_LAT_MAX - TILE_LAT_MIN) / TILE_STEP);
  const nLon = Math.round((TILE_LON_MAX - TILE_LON_MIN) / TILE_STEP);
  for (let i = 0; i <= nLat; i++) {
    for (let j = 0; j <= nLon; j++) {
      const lat = Math.round((TILE_LAT_MIN + i * TILE_STEP) * 100) / 100;
      const lon = Math.round((TILE_LON_MIN + j * TILE_STEP) * 100) / 100;
      tiles.push({ lat, lon, key: tileKey(lat, lon) });
    }
  }
  return tiles;
}

/** The tile a coordinate falls in, or null if outside the grid. */
export function tileFor(lat: number, lon: number): Tile | null {
  if (lat < TILE_LAT_MIN || lat > TILE_LAT_MAX || lon < TILE_LON_MIN || lon > TILE_LON_MAX) return null;
  const tLat = Math.round(Math.round(lat / TILE_STEP) * TILE_STEP * 100) / 100;
  const tLon = Math.round(Math.round(lon / TILE_STEP) * TILE_STEP * 100) / 100;
  return { lat: tLat, lon: tLon, key: tileKey(tLat, tLon) };
}

export function ensureTileScans(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tile_scans (
      tile_key  TEXT NOT NULL,
      category  TEXT NOT NULL,
      scans     INTEGER NOT NULL DEFAULT 0,
      last_scan TEXT,
      PRIMARY KEY (tile_key, category)
    );
  `);
}

/** ledger key → scan count. */
export function loadTileScans(db: Database.Database): Map<string, number> {
  ensureTileScans(db);
  const rows = db.prepare('SELECT tile_key, category, scans FROM tile_scans').all() as
    Array<{ tile_key: string; category: string; scans: number }>;
  const out = new Map<string, number>();
  for (const r of rows) out.set(`${r.tile_key}|${r.category}`, r.scans);
  return out;
}

function pairKey(tile: Tile, category: string): string {
  return `${tile.key}|${category}`;
}

/** Record that a (tile, category) search completed. Idempotent increments;
 *  also called for searches that returned zero results so they never repeat. */
export function recordScan(db: Database.Database, tile: Tile, category: string): void {
  ensureTileScans(db);
  db.prepare(
    `INSERT INTO tile_scans (tile_key, category, scans, last_scan) VALUES (?, ?, 1, ?)
       ON CONFLICT(tile_key, category) DO UPDATE SET scans = scans + 1, last_scan = excluded.last_scan`,
  ).run(tile.key, category, new Date().toISOString());
}

/** Map a stored POI type onto a scrape category (case/space tolerant). */
export function categoryForType(type: string | null): string | null {
  if (!type) return null;
  const t = type.trim().toLowerCase().replace(/_/g, ' ');
  const aliases: Record<string, string> = {
    'gas station': 'gas station',
    'gas': 'gas station',
    'fuel': 'fuel',
    'atm': 'atm',
    'shopping mall': 'shopping mall',
    'mall': 'shopping mall',
  };
  return aliases[t] ?? t;
}

/** SEED the ledger from what we already have: any Google POI means its
 *  (tile, category) search has already run, so mark it scanned. Idempotent.
 *  Returns how many pairs were newly marked. */
export function seedTileScansFromPois(db: Database.Database, categories: readonly string[]): number {
  ensureTileScans(db);
  const cats = new Set(categories.map(c => c.toLowerCase()));
  const rows = db.prepare(
    `SELECT type, lat, lon FROM pois WHERE source = 'google' AND lat IS NOT NULL AND lon IS NOT NULL`,
  ).all() as Array<{ type: string | null; lat: number; lon: number }>;
  const seen = new Set<string>();
  const existing = loadTileScans(db);
  let seeded = 0;
  for (const r of rows) {
    const tile = tileFor(r.lat, r.lon);
    if (!tile) continue;
    const cat = categoryForType(r.type);
    if (!cat || !cats.has(cat)) continue;
    const k = pairKey(tile, cat);
    if (seen.has(k) || existing.has(k)) continue;
    seen.add(k);
    db.prepare(
      `INSERT OR IGNORE INTO tile_scans (tile_key, category, scans, last_scan) VALUES (?, ?, 1, ?)`,
    ).run(tile.key, cat, new Date().toISOString());
    seeded++;
  }
  return seeded;
}

export interface CoveragePlan {
  totalTiles: number;
  totalPairs: number;
  scannedPairs: number;
  uncoveredPairs: number;
  uncoveredTiles: number;
  categories: string[];
  /** The exact number of SerpApi searches a resumed run would spend. */
  estimatedSearches: number;
}

/** The DRY-RUN brain: how many searches remain to cover the grid. Free —
 *  reads the ledger and the DB only, touches no key. */
export function planCoverage(db: Database.Database, categories: readonly string[]): CoveragePlan {
  const tiles = buildTiles();
  const ledger = loadTileScans(db);
  const uncoveredTileKeys = new Set<string>();
  let scanned = 0;
  let uncovered = 0;
  for (const tile of tiles) {
    for (const cat of categories) {
      if ((ledger.get(pairKey(tile, cat)) ?? 0) > 0) {
        scanned++;
      } else {
        uncovered++;
        uncoveredTileKeys.add(tile.key);
      }
    }
  }
  return {
    totalTiles: tiles.length,
    totalPairs: tiles.length * categories.length,
    scannedPairs: scanned,
    uncoveredPairs: uncovered,
    uncoveredTiles: uncoveredTileKeys.size,
    categories: [...categories],
    estimatedSearches: uncovered,
  };
}

/** The pairs a run still has to scan, in tile-then-category order. */
export function uncoveredPairs(
  db: Database.Database,
  categories: readonly string[],
): Array<{ tile: Tile; category: string }> {
  const ledger = loadTileScans(db);
  const out: Array<{ tile: Tile; category: string }> = [];
  for (const tile of buildTiles()) {
    for (const cat of categories) {
      if ((ledger.get(pairKey(tile, cat)) ?? 0) === 0) out.push({ tile, category: cat });
    }
  }
  return out;
}
