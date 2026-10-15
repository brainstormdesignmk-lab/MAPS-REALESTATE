// THE SPEND GUARD, PINNED. Two blind full-grid passes drained every key
// because Phase B had no memory of what it had already scanned. The ledger
// must (1) count the true grid size, (2) skip already-scanned pairs, (3) be
// seedable from existing Google POIs so a resumed run scans only the gaps,
// and (4) estimate the spend BEFORE a single key is touched.
//
// (5) THE CADENCE GATE. The calendar used to decide which categories ran:
// full only in Jan/Apr/Jul/Oct, otherwise 2. November therefore considered 270
// of 2025 pairs, worked 66 of the 510 open gaps, left 444 open — and printed a
// successful summary. Completeness must never depend on the month or on an
// operator remembering a flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  buildTiles, tileFor, tileKey,
  seedTileScansFromPois, planCoverage, uncoveredPairs, recordScan, loadTileScans,
} from '../src/geo/tileCoverage';
import { categoriesForRun, FULL_CATEGORIES, LIGHT_CATEGORIES, isFullPassMonth } from '../src/geo/serpCapture';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE pois (name TEXT, type TEXT, lat REAL, lon REAL, source TEXT)`);
  return db;
}

test('categoriesForRun: the COMPLETE pass is the default in EVERY month', () => {
  for (const month of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    const d = new Date(Date.UTC(2026, month, 1));
    assert.equal(categoriesForRun(undefined, d).length, FULL_CATEGORIES.length,
      `month ${month + 1} must plan a complete pass`);
    assert.equal(categoriesForRun('--full', d).length, FULL_CATEGORIES.length);
  }
  // November 2026 — the month the calendar gate would have halved the run.
  assert.equal(categoriesForRun(undefined, new Date(Date.UTC(2026, 10, 1))).length, 15);
  // A deliberately cheap month is still reachable, but only by asking.
  assert.deepEqual([...categoriesForRun('--light')], [...LIGHT_CATEGORIES]);
  // isFullPassMonth survives only as the deprecated predicate it always was.
  assert.equal(isFullPassMonth(new Date(Date.UTC(2026, 9, 1))), true);
  assert.equal(isFullPassMonth(new Date(Date.UTC(2026, 10, 1))), false);
});

test('buildTiles produces the 9×15 = 135-tile grid over urban Skopje', () => {
  const tiles = buildTiles();
  assert.equal(tiles.length, 135);
  assert.equal(tiles[0].key, '41.96,21.36');
  assert.equal(tiles[tiles.length - 1].key, '42.04,21.50');
});

test('tileFor snaps a coordinate into its 0.01° cell, null outside the grid', () => {
  assert.equal(tileFor(41.996, 21.425)?.key, '42.00,21.43');
  assert.equal(tileFor(41.90, 21.43), null, 'south of the grid');
  assert.equal(tileFor(42.04, 21.50)?.key, '42.04,21.50', 'corner included');
});

test('an empty ledger estimates the full grid spend', () => {
  const db = freshDb();
  const cats = ['supermarket', 'pharmacy'] as const;
  const plan = planCoverage(db, cats);
  assert.equal(plan.totalPairs, 270);
  assert.equal(plan.uncoveredPairs, 270);
  assert.equal(plan.estimatedSearches, 270);
  db.close();
});

test('seeding from existing Google POIs marks their tile×category as scanned', () => {
  const db = freshDb();
  // A supermarket in the 42.00,21.43 tile — that pair is already covered.
  db.prepare('INSERT INTO pois (name, type, lat, lon, source) VALUES (?,?,?,?,?)')
    .run('Веро', 'supermarket', 41.996, 21.425, 'google');
  const cats = ['supermarket', 'pharmacy'] as const;
  const seeded = seedTileScansFromPois(db, cats);
  assert.equal(seeded, 1);
  const plan = planCoverage(db, cats);
  assert.equal(plan.scannedPairs, 1);
  assert.equal(plan.estimatedSearches, 269);
  // Idempotent: seeding again adds nothing.
  assert.equal(seedTileScansFromPois(db, cats), 0);
  db.close();
});

test('recordScan removes a pair from the uncovered list (a resumed run scans gaps only)', () => {
  const db = freshDb();
  const cats = ['pharmacy'] as const;
  const before = uncoveredPairs(db, cats).length;
  const tile = buildTiles()[0];
  recordScan(db, tile, 'pharmacy');
  const after = uncoveredPairs(db, cats).length;
  assert.equal(after, before - 1);
  assert.equal(loadTileScans(db).get(`${tileKey(tile.lat, tile.lon)}|pharmacy`), 1);
  // A zero-result search is still recorded, so it never repeats.
  recordScan(db, tile, 'pharmacy');
  assert.equal(loadTileScans(db).get(`${tileKey(tile.lat, tile.lon)}|pharmacy`), 2);
  assert.equal(uncoveredPairs(db, cats).length, after);
  db.close();
});

test('a POI outside the tile grid does not seed the ledger', () => {
  const db = freshDb();
  db.prepare('INSERT INTO pois (name, type, lat, lon, source) VALUES (?,?,?,?,?)')
    .run('Walgreens', 'pharmacy', 37.77, -122.42, 'google');
  assert.equal(seedTileScansFromPois(db, ['pharmacy']), 0);
  db.close();
});
