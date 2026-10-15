// THE INVARIANTS, PINNED. These checks are what makes a run's exit code mean
// something — before them the only thing standing between a broken map and the
// bots was a human reading five numbers out of a §6 one-liner.
//
// Each test is a way the map has already been wrong once:
//   [ ] a wrong-directory run opens a freshly CREATED, near-empty map
//   [ ] Phase B2 skipped → duplicate place_id → the Cyrillic name is lost
//   [ ] the calendar gate → unhidden open pairs reported as success
//   [ ] budget exhaustion → open pairs that are CORRECT, and must not fail

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { planCoverage, buildTiles, recordScan } from '../src/geo/tileCoverage';
import { verifyMapDb, MAP_MIN_POIS } from '../src/geo/runVerify';

const CATS = ['supermarket'] as const;

function mapDb(pois = 0): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE pois (
    name TEXT, type TEXT, lat REAL, lon REAL, source TEXT, place_id TEXT)`);
  const ins = db.prepare('INSERT INTO pois (name, type, lat, lon, source, place_id) VALUES (?,?,?,?,?,?)');
  const tx = db.transaction(() => {
    for (let i = 0; i < pois; i++) ins.run(`P${i}`, 'supermarket', 41.99, 21.43, 'google', `pid-${i}`);
  });
  tx();
  return db;
}

/** Record every pair of the grid as scanned. */
function closeGrid(db: Database.Database, cats: readonly string[] = CATS): void {
  for (const tile of buildTiles()) {
    for (const cat of cats) recordScan(db, tile, cat);
  }
}

const BUDGET = { searchesLeft: 2000, budgetFloor: 20 };

test('verify: a healthy, fully covered map reports no violations', () => {
  const db = mapDb(1200);
  closeGrid(db);
  const v = verifyMapDb(db, CATS, BUDGET);
  assert.deepEqual(v.violations, []);
  assert.deepEqual(v.warnings, []);
  assert.equal(v.integrity, 'ok');
  assert.equal(v.pois, 1200);
  assert.equal(v.duplicatedPlaceIds, 0);
  assert.equal(v.uncoveredPairs, 0);
  assert.equal(v.totalPairs, 135);
  db.close();
});

test('verify: an empty map is a violation (the wrong-directory signature)', () => {
  const db = mapDb(0);
  closeGrid(db);
  const v = verifyMapDb(db, CATS, BUDGET);
  const pois = v.violations.find(x => x.includes('pois = 0'));
  assert.ok(pois, `expected a pois violation, got ${JSON.stringify(v.violations)}`);
  assert.match(pois!, /wrong or empty map file/);
  assert.ok(v.violations.length === 1, 'coverage is fine, only the map is wrong');
  assert.ok(MAP_MIN_POIS > 0);
  db.close();
});

test('verify: duplicate place_id fails (Phase B2 did not merge)', () => {
  const db = mapDb(1200);
  closeGrid(db);
  // A second row sharing a place_id — the bug that drops the Cyrillic name.
  db.prepare('INSERT INTO pois (name, type, lat, lon, source, place_id) VALUES (?,?,?,?,?,?)')
    .run('Двојник', 'supermarket', 41.99, 21.43, 'osm', 'pid-0');
  const v = verifyMapDb(db, CATS, BUDGET);
  assert.equal(v.duplicatedPlaceIds, 1);
  assert.match(v.violations.join(' | '), /duplicate place_id groups = 1/);
  db.close();
});

test('verify: open pairs with budget available FAIL the run', () => {
  const db = mapDb(1200);
  // The calendar-gate signature: only a handful of the grid scanned, keys
  // plentiful — i.e. the pass stopped for a reason that was not the budget.
  recordScan(db, buildTiles()[0], 'supermarket');
  const v = verifyMapDb(db, CATS, BUDGET);
  assert.equal(v.uncoveredPairs, 134);
  assert.match(v.violations.join(' | '), /134 of 135 pairs unscanned/);
  assert.match(v.violations.join(' | '), /the budget was there/);
  assert.deepEqual(v.warnings, []);
  db.close();
});

test('verify: budget AT the floor is not "exhausted" — a phase would still run', () => {
  const db = mapDb(1200);
  recordScan(db, buildTiles()[0], 'supermarket');
  const v = verifyMapDb(db, CATS, { searchesLeft: 20, budgetFloor: 20 });
  assert.deepEqual(v.warnings, []);
  assert.match(v.violations.join(' | '), /the budget was there/);
  db.close();
});

test('verify: open pairs with the budget exhausted WARN, and the run still passes', () => {
  const db = mapDb(1200);
  recordScan(db, buildTiles()[0], 'supermarket');
  // Below the floor every phase stops, so the residual pairs are correct, not a
  // defect. AT the floor a phase would have kept going — that is a violation
  // (pinned separately below), which is precisely the distinction the log must
  // make between "out of keys" and "silently skipped".
  const v = verifyMapDb(db, CATS, { searchesLeft: 19, budgetFloor: 20 });
  assert.deepEqual(v.violations, [], 'stopping for budget is correct, not a defect');
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0], /budget exhausted; they resume on the next run/);
  db.close();
});

test('verify: a fresh DB with no ledger yet reads the plan safely', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE pois (name TEXT, type TEXT, lat REAL, lon REAL, source TEXT, place_id TEXT)');
  const v = verifyMapDb(db, CATS, BUDGET);
  // No ledger, no POIs → both the map and the coverage are violations, and
  // nothing threw trying to read a table that did not exist.
  assert.equal(v.totalPairs, 135);
  assert.equal(v.uncoveredPairs, 135);
  assert.ok(v.violations.length >= 2);
  const plan = planCoverage(db, CATS);
  assert.equal(plan.uncoveredPairs, 135);
  db.close();
});
