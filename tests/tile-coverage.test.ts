// THE SPEND GUARD, PINNED. Two blind full-grid passes drained every key
// because Phase B had no memory of what it had already scanned. The ledger
// must (1) count the true grid size, (2) skip already-scanned pairs, (3) be
// seedable from existing Google POIs so a resumed run scans only the gaps,
// and (4) estimate the spend BEFORE a single key is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  buildTiles, tileFor, tileKey,
  seedTileScansFromPois, planCoverage, uncoveredPairs, recordScan, loadTileScans,
} from '../src/geo/tileCoverage';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE pois (name TEXT, type TEXT, lat REAL, lon REAL, source TEXT)`);
  return db;
}

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
