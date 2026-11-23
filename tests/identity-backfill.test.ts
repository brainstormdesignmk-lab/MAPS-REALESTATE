import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  selectIdentityTargets, acceptIdentity, writeIdentity, hasIdentifiedTwin, identityCoverage,
  isLandmarkName, ANCHOR_CLASSES, MATCH_RADIUS_M, type IdentityCapture, type IdentityTarget,
} from '../src/geo/identityBackfill';

// A tiny map around 42.00 / 21.43 (Skopje centre-ish). ~0.001° lat = 111 m.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE pois (
    rowid INTEGER PRIMARY KEY,
    name TEXT, type TEXT, lat REAL, lon REAL, source TEXT,
    place_id TEXT, review_count INTEGER, rating REAL, plus_code TEXT,
    phone TEXT, website TEXT, price_level TEXT, closed INTEGER, types TEXT, place_url TEXT)`);
  return db;
}

function addPo(db: Database.Database, r: {
  name: string; type: string; lat: number; lon: number; place_id?: string | null;
}): number {
  const info = db.prepare(
    `INSERT INTO pois (name, type, lat, lon, source, place_id, closed) VALUES (?, ?, ?, ?, 'osm', ?, 0)`,
  ).run(r.name, r.type, r.lat, r.lon, r.place_id ?? null);
  return Number(info.lastInsertRowid);
}

const ORIGIN = [{ lat: 42.0, lon: 21.43 }];

function cap(over: Partial<IdentityCapture> = {}): IdentityCapture {
  return {
    name: 'Католичка црква', type: 'church', lat: 42.0002, lon: 21.4301, place_id: '0x1234:0x5678',
    review_count: 120, rating: 4.6, plus_code: '8GG8+AB', phone: null, website: null,
    closed: 0, types: '["church"]', ...over,
  };
}

test('select: a landmark near a property, not a shop, not an identified row, not junk', () => {
  const db = makeDb();
  const pharmacy = addPo(db, { name: 'Аптека Еурофарм', type: 'pharmacy', lat: 42.0001, lon: 21.4301 }); // ~11 m
  addPo(db, { name: 'Бутик Галион', type: 'clothes', lat: 42.0001, lon: 21.4301 });                      // rank 0
  addPo(db, { name: 'Аптека Далечна', type: 'pharmacy', lat: 42.03, lon: 21.43 });                       // ~3.3 km
  addPo(db, { name: 'Аптека Позната', type: 'pharmacy', lat: 42.0001, lon: 21.4302, place_id: '0xaa:0xbb' });
  addPo(db, { name: 'Непозната', type: 'pharmacy', lat: 42.0001, lon: 21.4301 });
  const targets = selectIdentityTargets(db, { origins: ORIGIN, classes: [] });
  assert.deepEqual(targets.map(t => t.rowid), [pharmacy]);
  assert.equal(targets[0].group, 'pool');
});

test('select: the feed order (rank first, then distance) decides what the budget buys', () => {
  const db = makeDb();
  const shop = addPo(db, { name: 'Маркет Близу', type: 'supermarket', lat: 42.00002, lon: 21.43 });   // ~2 m, rank 3
  const square = addPo(db, { name: 'Плоштад Слобода', type: 'square', lat: 42.0005, lon: 21.43 });   // ~55 m, rank 5
  const targets = selectIdentityTargets(db, { origins: ORIGIN, classes: [] });
  assert.deepEqual(targets.map(t => t.rowid), [square, shop]);
});

test('select: anchor classes are picked city-wide, and only those classes', () => {
  const db = makeDb();
  const church = addPo(db, { name: 'Црква Свети Димитрија', type: 'place_of_worship', lat: 41.99, lon: 21.45 });
  addPo(db, { name: 'Ресторан Далечен', type: 'restaurant', lat: 41.99, lon: 21.451 });
  const targets = selectIdentityTargets(db, { origins: ORIGIN, classes: ANCHOR_CLASSES });
  assert.deepEqual(targets.map(t => t.rowid), [church]);
  assert.equal(targets[0].group, 'class');
  assert.equal(targets[0].nearestPropertyM, Infinity);
});

test('select: the same row found by two properties appears once, nearest distance kept', () => {
  const db = makeDb();
  const row = addPo(db, { name: 'Општина Центар', type: 'townhall', lat: 42.0005, lon: 21.43 });
  const targets = selectIdentityTargets(db, {
    origins: [{ lat: 42.0004, lon: 21.43 }, { lat: 42.0015, lon: 21.43 }],
    classes: [],
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].rowid, row);
  assert.ok(targets[0].nearestPropertyM < 20);
});

test('accept: refuses without identity, outside Skopje, too far, or a different place', () => {
  const target: IdentityTarget = {
    rowid: 1, name: 'Католичка црква', type: 'place_of_worship',
    lat: 42.0, lon: 21.43, group: 'pool', nearestPropertyM: 10,
  };
  assert.deepEqual(acceptIdentity(target, cap({ place_id: null })), { ok: false, why: 'no-identity' });
  assert.deepEqual(acceptIdentity(target, cap({ lat: 40.0 })), { ok: false, why: 'outside-bbox' });
  const far = acceptIdentity(target, cap({ lat: 42.0 + 0.003 })); // ~334 m
  assert.equal(far.ok, false);
  assert.equal(!far.ok && far.why, 'too-far');
  assert.ok(!far.ok && (far.movedM ?? 0) > MATCH_RADIUS_M);
  // The refusal carries the metre count it refused on (useful to the operator),
  // so the assertion is the verdict, not the whole object.
  const other = acceptIdentity(target, cap({ name: 'Кафе Мока', type: 'cafe' }));
  assert.equal(other.ok, false);
  assert.equal(!other.ok && other.why, 'not-same-place');
});

test('accept: a translated name one building away is the same place (tight tier)', () => {
  const target: IdentityTarget = {
    rowid: 1, name: 'Правен факултет „Јустинијан Први“', type: 'university',
    lat: 42.0, lon: 21.43, group: 'class', nearestPropertyM: Infinity,
  };
  // Google answers Skopje landmarks in Latin; the token rule cannot see the
  // translation, but 23 m + an anchor class on both sides is one building.
  assert.deepEqual(acceptIdentity(target, cap({
    name: 'Iustinianus Primus Faculty of Law', type: 'University',
    lat: 42.00021, lon: 21.43, place_id: '0xaaa:0xbbb',
  })), { ok: true });
});

test('accept: the tight tier never adopts a city fallback or a shop neighbour', () => {
  const church: IdentityTarget = {
    rowid: 1, name: 'Плоштад ВМРО', type: 'square', lat: 42.0, lon: 21.43,
    group: 'pool', nearestPropertyM: 10,
  };
  // Google's "Skopje" answer is typed as a city (rank 0): however close, it is
  // not this place.
  const city = acceptIdentity(church, cap({ name: 'Skopje', type: 'City', lat: 42.0002, place_id: '0xccc:0xddd' }));
  assert.equal(city.ok, false);
  // A café 20 m away is a different kind of place entirely.
  const cafe = acceptIdentity(church, cap({ name: 'Кафе Мока', type: 'Cafe', lat: 42.0002, place_id: '0xeee:0xfff' }));
  assert.equal(cafe.ok, false);
});

test('accept: the same place, two encodings, tens of metres apart — accepted', () => {
  const target: IdentityTarget = {
    rowid: 1, name: 'Католичка црква', type: 'place_of_worship',
    lat: 42.0, lon: 21.43, group: 'pool', nearestPropertyM: 10,
  };
  assert.deepEqual(acceptIdentity(target, cap({ lat: 42.0003, lon: 21.4302 })), { ok: true });
});

test('write: identity and its fields land on the row; the map pin is never moved', () => {
  const db = makeDb();
  const rowid = addPo(db, { name: 'Црква Св. Климент', type: 'church', lat: 42.0, lon: 21.43 });
  const target: IdentityTarget = {
    rowid, name: 'Црква Св. Климент', type: 'church', lat: 42.0, lon: 21.43,
    group: 'pool', nearestPropertyM: 5,
  };
  assert.equal(writeIdentity(db, target, cap({ name: 'Црква Св. Климент' })), 'written');
  const row = db.prepare('SELECT lat, lon, place_id, review_count, rating, closed FROM pois WHERE rowid = ?')
    .get(rowid) as { lat: number; lon: number; place_id: string; review_count: number; rating: number; closed: number };
  assert.equal(row.place_id, '0x1234:0x5678');
  assert.equal(row.review_count, 120);
  assert.equal(row.rating, 4.6);
  assert.equal(row.lat, 42.0);        // untouched
  assert.equal(row.lon, 21.43);       // untouched
  // Idempotent: a second capture never rewrites an identity.
  assert.equal(writeIdentity(db, target, cap({ place_id: '0xffff:0x0000' })), 'already-identified');
  assert.equal((db.prepare('SELECT place_id FROM pois WHERE rowid = ?').get(rowid) as { place_id: string }).place_id,
    '0x1234:0x5678');
});

test('write: an identity already held by a twin row is refused, not duplicated', () => {
  const db = makeDb();
  addPo(db, { name: 'City Mall', type: 'mall', lat: 42.0002, lon: 21.4301, place_id: '0x1234:0x5678' });
  const rowid = addPo(db, { name: 'Сити Мол', type: 'mall', lat: 42.0, lon: 21.43 });
  const target: IdentityTarget = {
    rowid, name: 'Сити Мол', type: 'mall', lat: 42.0, lon: 21.43, group: 'pool', nearestPropertyM: 10,
  };
  // pois.place_id is UNIQUE — a second row may never carry a copy.
  assert.equal(writeIdentity(db, target, cap()), 'identity-taken');
  const row = db.prepare('SELECT place_id, review_count FROM pois WHERE rowid = ?').get(rowid) as
    { place_id: string | null; review_count: number | null };
  assert.equal(row.place_id, null);
  assert.equal(row.review_count, null);
});

test('hasIdentifiedTwin: a neighbouring row with the same place needs no second search', () => {
  const db = makeDb();
  const osm = addPo(db, { name: 'Сити Мол', type: 'mall', lat: 42.0, lon: 21.43 });
  addPo(db, { name: 'City Mall', type: 'mall', lat: 42.0002, lon: 21.4301, place_id: '0xabc:0xdef' });
  const target: IdentityTarget = {
    rowid: osm, name: 'Сити Мол', type: 'mall', lat: 42.0, lon: 21.43, group: 'pool', nearestPropertyM: 10,
  };
  // "Сити Мол" and "City Mall" share no token — the identity rule does NOT
  // claim they are one place, so this row still needs its own search.
  assert.equal(hasIdentifiedTwin(db, target), false);
  const twinTarget: IdentityTarget = { ...target, name: 'City Mall' };
  assert.equal(hasIdentifiedTwin(db, twinTarget), true);
});

test('isLandmarkName: placeholders are not worth a search', () => {
  assert.equal(isLandmarkName('Католичка црква'), true);
  assert.equal(isLandmarkName('Kipper Market'), true);
  assert.equal(isLandmarkName('Непозната'), false);
  assert.equal(isLandmarkName('unknown'), false);
  assert.equal(isLandmarkName('  - '), false);
  assert.equal(isLandmarkName('12'), false);
});

test('coverage: counts the pool and the thin classes it exists for', () => {
  const db = makeDb();
  addPo(db, { name: 'Аптека Позната', type: 'pharmacy', lat: 42.0001, lon: 21.4301, place_id: '0xaa:0xbb' });
  addPo(db, { name: 'Аптека Непозната', type: 'pharmacy', lat: 42.0001, lon: 21.4302 });
  addPo(db, { name: 'Црква Св. Климент', type: 'church', lat: 41.99, lon: 21.45 });
  const cov = identityCoverage(db, { origins: ORIGIN, classes: ANCHOR_CLASSES });
  assert.equal(cov.totalCandidates, 2);
  assert.equal(cov.withIdentity, 1);
  assert.equal(cov.poolMissing, 1);
  assert.equal(cov.classMissing, 1);
});
