// A CAPTURE MAY REFINE A PIN, NEVER RELOCATE THE PLACE.
//
// The November 2026 sweep re-pinned «Беверли Хилс» 847 m from its Капиштец
// building footprint to the sales agency's office by the cathedral, because the
// monthly top-up wrote Google's lat/lon unconditionally by place_id. Lina then
// answered «кај Беверли Хилс» with the neighbourhood ЦЕНТАР — the map's own
// landmark distances for that quarter were measured from the wrong side of town.
//
// Two rules carry the fix, and this file pins both:
//
//   [ ] captureMayMovePin: a move is a refinement up to 300 m, a relocation
//       beyond it — and a row with no pin yet may always be filled.
//   [ ] collapseGeometryTwins: a healed legacy row and the OSM element it
//       duplicates are ONE place — the element keeps its geometry and ADOPTS the
//       identity (142 such pairs sat in the November map, most at 0 m).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { CAPTURE_PIN_DRIFT_M, captureMayMovePin } from '../src/geo/precision';
import { collapseGeometryTwins } from '../scripts/identity-heal';

// ── the capture guard ───────────────────────────────────────────────────────
const KAPISTEC = { lat: 41.9936802, lon: 21.4162282 };   // OSM way/176189216
const CATHEDRAL_OFFICE = { lat: 41.9987718, lon: 21.4238968 }; // the capture's pin

test('the real 847 m swing is refused', () => {
  const v = captureMayMovePin(KAPISTEC, CATHEDRAL_OFFICE);
  assert.equal(v.ok, false);
  assert.ok(v.movedM > 800 && v.movedM < 900, `expected ~847 m, got ${v.movedM}`);
});

test('a block-sized refinement is accepted (Google and OSM disagree by ~50 m all over the map)', () => {
  const v = captureMayMovePin(KAPISTEC, { lat: 41.99413, lon: 21.41662 });
  assert.equal(v.ok, true);
  assert.ok(v.movedM < 60);
});

test('the threshold is the constant, and it is a bound (inclusive)', () => {
  assert.equal(CAPTURE_PIN_DRIFT_M, 300);
  const dLat = 300 / 111320; // 300 m due north
  const onTheLine = captureMayMovePin(KAPISTEC, { lat: KAPISTEC.lat + dLat, lon: KAPISTEC.lon });
  assert.equal(onTheLine.ok, true, 'exactly on the bound is still a refinement');
  const justOver = captureMayMovePin(KAPISTEC, { lat: KAPISTEC.lat + dLat * 1.01, lon: KAPISTEC.lon });
  assert.equal(justOver.ok, false, 'a metre past it is a relocation');
});

test('a row with no pin yet may always be filled', () => {
  assert.deepEqual(captureMayMovePin(undefined, CATHEDRAL_OFFICE), { ok: true, movedM: 0 });
  assert.deepEqual(
    captureMayMovePin({ lat: Number.NaN, lon: Number.NaN }, CATHEDRAL_OFFICE),
    { ok: true, movedM: 0 },
  );
});

// ── the geometry-twin collapse ──────────────────────────────────────────────
function mapDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE pois (
    rowid INTEGER PRIMARY KEY,
    name TEXT, type TEXT, lat REAL, lon REAL, source TEXT, place_id TEXT,
    osm_key TEXT, review_count INTEGER, rating REAL, plus_code TEXT, phone TEXT,
    website TEXT, price_level TEXT, types TEXT, place_url TEXT)`);
  return db;
}

function add(db: Database.Database, r: {
  name: string; type: string; lat: number; lon: number; source?: string;
  place_id?: string | null; osm_key?: string | null; review_count?: number;
}): number {
  const info = db.prepare(
    `INSERT INTO pois (name, type, lat, lon, source, place_id, osm_key, review_count)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(r.name, r.type, r.lat, r.lon, r.source ?? 'osm', r.place_id ?? null,
    r.osm_key ?? null, r.review_count ?? null);
  return Number(info.lastInsertRowid);
}

test('the healed legacy row folds INTO the element row (identity survives, geometry wins)', () => {
  const db = mapDb();
  // The real November shape: legacy row (place_id, no osm_key) on top of the
  // element row (osm_key, no identity) — the pair that made the map hold
  // «Амбасада на Турција» twice at the identical coordinate.
  add(db, { name: 'Амбасада на Турција', type: 'diplomatic', ...KAPISTEC, place_id: 'pid-tr', review_count: 72 });
  const element = add(db, { name: 'Амбасада на Турција', type: 'diplomatic', ...KAPISTEC, osm_key: 'way/176481168' });

  const res = collapseGeometryTwins(db);
  assert.deepEqual(res, { adopted: 1, dropped: 0, conflicts: 0 });

  const rows = db.prepare('SELECT rowid, place_id, osm_key, review_count FROM pois').all() as Array<
    { rowid: number; place_id: string | null; osm_key: string | null; review_count: number | null }
  >;
  assert.equal(rows.length, 1, 'one place, one row');
  assert.equal(rows[0].rowid, element, 'the ELEMENT row is the survivor (its geometry is ground truth)');
  assert.equal(rows[0].place_id, 'pid-tr', 'it adopted the identity');
  assert.equal(rows[0].review_count, 72, 'and the capture fields came with it');
  db.close();
});

test('the element row keeps its own capture fields (never overwritten with null)', () => {
  const db = mapDb();
  add(db, { name: 'Зегин', type: 'pharmacy', ...KAPISTEC, place_id: 'pid-1', review_count: 7 });
  const element = add(db, { name: 'Зегин', type: 'pharmacy', ...KAPISTEC, osm_key: 'node/1', review_count: 99 });

  collapseGeometryTwins(db);
  const row = db.prepare('SELECT place_id, review_count FROM pois WHERE rowid = ?').get(element) as
    { place_id: string | null; review_count: number | null };
  assert.equal(row.place_id, 'pid-1');
  assert.equal(row.review_count, 99, 'the element row already had a count — keep the better evidence');
  db.close();
});

test('a legacy row with no identity of its own is dropped as dead weight', () => {
  const db = mapDb();
  add(db, { name: 'Рептил', type: 'convenience', ...KAPISTEC });
  add(db, { name: 'Рептил', type: 'convenience', ...KAPISTEC, osm_key: 'node/10184098858' });

  const res = collapseGeometryTwins(db);
  assert.deepEqual(res, { adopted: 0, dropped: 1, conflicts: 0 });
  assert.equal((db.prepare('SELECT COUNT(*) c FROM pois').get() as { c: number }).c, 1);
  db.close();
});

test('neighbours 10 m apart are NOT twins — chain branches and shops in one hall survive', () => {
  const db = mapDb();
  add(db, { name: 'Зегин', type: 'pharmacy', lat: 41.98664, lon: 21.46686, place_id: 'pid-a' });
  add(db, { name: 'Зегин', type: 'pharmacy', lat: 41.98673, lon: 21.46686, osm_key: 'node/2' });

  const res = collapseGeometryTwins(db);
  assert.deepEqual(res, { adopted: 0, dropped: 0, conflicts: 0 });
  assert.equal((db.prepare('SELECT COUNT(*) c FROM pois').get() as { c: number }).c, 2);
  db.close();
});

test('a different type on the same spot is a different place (bank vs its ATM)', () => {
  const db = mapDb();
  add(db, { name: 'Стопанска Банка', type: 'bank', ...KAPISTEC, place_id: 'pid-bank' });
  add(db, { name: 'Стопанска Банка', type: 'atm', ...KAPISTEC, osm_key: 'node/3' });

  collapseGeometryTwins(db);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM pois').get() as { c: number }).c, 2);
  db.close();
});

test('a twin that already owns another identity is a conflict, left for the census', () => {
  const db = mapDb();
  add(db, { name: 'Веро', type: 'supermarket', ...KAPISTEC, place_id: 'pid-a' });
  add(db, { name: 'Веро', type: 'supermarket', ...KAPISTEC, osm_key: 'node/4', place_id: 'pid-b' });

  const res = collapseGeometryTwins(db);
  assert.deepEqual(res, { adopted: 0, dropped: 0, conflicts: 1 });
  assert.equal((db.prepare('SELECT COUNT(*) c FROM pois').get() as { c: number }).c, 2,
    'two identities is not a duplicate we may silently resolve');
  db.close();
});

test('the pass is idempotent', () => {
  const db = mapDb();
  add(db, { name: 'Амбасада на Турција', type: 'diplomatic', ...KAPISTEC, place_id: 'pid-tr' });
  add(db, { name: 'Амбасада на Турција', type: 'diplomatic', ...KAPISTEC, osm_key: 'way/176481168' });

  assert.equal(collapseGeometryTwins(db).adopted, 1);
  assert.deepEqual(collapseGeometryTwins(db), { adopted: 0, dropped: 0, conflicts: 0 });
  assert.equal((db.prepare('SELECT COUNT(*) c FROM pois').get() as { c: number }).c, 1);
  db.close();
});

test('a Google row is never touched — its identity IS its geometry', () => {
  const db = mapDb();
  // Google rows carry no osm_key by definition; the collapse must not read them
  // as "legacy duplicates" and delete the paid layer.
  add(db, { name: 'Беверли Хилс', type: 'mall', ...KAPISTEC, source: 'google', place_id: 'pid-g' });
  add(db, { name: 'Беверли Хилс', type: 'mall', ...KAPISTEC, osm_key: 'way/1' });

  const res = collapseGeometryTwins(db);
  assert.deepEqual(res, { adopted: 0, dropped: 0, conflicts: 0 });
  assert.equal((db.prepare('SELECT COUNT(*) c FROM pois').get() as { c: number }).c, 2);
  db.close();
});
