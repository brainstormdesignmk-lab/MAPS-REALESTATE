// A TENANT NEVER INHERITS ITS VENUE'S IDENTITY.
//
// Phase B2 merges an OSM row with the Google anchor of the same physical place.
// The containment tier ("Рептил" ≡ "Reptil Market br.3 Kisela Voda") decides on
// DISTANCE + a subset name — and inside a mall the tenant stands at the venue's
// own coordinates, so 0 m proves nothing there. The 2026-11-16 November sweep
// did it three times and DELETED the venues:
//
//   Anhoch Бисер   (computer)      ← Biser Shopping Center      (mall)
//   Тинекс Лиса центар (supermarket) ← Shopping Center Lisa      (mall)
//   Пошта Бутел    (post_office)   ← Shopping center „Butel“     (mall)
//
// Every «кај Бисер» question then answered about a travel AGENCY, because the
// mall was no longer in the map (the tenant row was, and a shop never answers
// for its venue). These tests pin the guard, and the cases it must NOT break:
//
// [ ] a shop inside a mall does not absorb the mall's identity
// [ ] the mall's own OSM row still merges — class-compatible containment
// [ ] the documented containment case (two shops, one name) still merges
// [ ] an IDENTICAL name still merges whatever the two rows are typed
// [ ] the pass is idempotent (a second run changes nothing)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { identityHeal } from '../scripts/identity-heal';

/** The pois columns identityHeal reads and mergePair writes. */
function mapDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE pois (
    rowid INTEGER PRIMARY KEY,
    name TEXT, type TEXT, lat REAL, lon REAL, source TEXT, place_id TEXT,
    review_count INTEGER, rating REAL, plus_code TEXT, phone TEXT,
    website TEXT, price_level TEXT, types TEXT, place_url TEXT)`);
  return db;
}

interface Row {
  name: string; type: string; lat: number; lon: number; source: 'osm' | 'google';
  place_id: string | null;
}

function add(db: Database.Database, r: Row): number {
  const info = db.prepare(
    `INSERT INTO pois (name, type, lat, lon, source, place_id, review_count, rating, place_url)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(r.name, r.type, r.lat, r.lon, r.source, r.place_id,
    r.source === 'google' ? 120 : null, r.source === 'google' ? 4.4 : null,
    r.source === 'google' ? 'https://maps.google.com/?cid=1' : null);
  return Number(info.lastInsertRowid);
}

const BISER = { lat: 41.98498, lon: 21.46566 };

test('a shop inside a mall does NOT absorb the mall identity (Biser, November 2026)', () => {
  const db = mapDb();
  const mall = add(db, { name: 'Biser Shopping Center', type: 'Shopping mall', ...BISER, source: 'google', place_id: 'pid-biser' });
  const shop = add(db, { name: 'Anhoch Бисер', type: 'computer', ...BISER, source: 'osm', place_id: null });

  identityHeal(db);

  const anchor = db.prepare('SELECT rowid, name FROM pois WHERE rowid = ?').get(mall) as { rowid: number; name: string } | undefined;
  const tenant = db.prepare('SELECT rowid, name, place_id FROM pois WHERE rowid = ?').get(shop) as { rowid: number; name: string; place_id: string | null };

  assert.ok(anchor, 'the mall row must SURVIVE — merging it away is how the city mall vanished');
  assert.equal(anchor!.name, 'Biser Shopping Center');
  assert.equal(tenant.place_id, null, 'the tenant must not carry the mall identity');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM pois').get()!.c as number, 2, 'both rows stand');
  db.close();
});

test('the mall\'s OWN row still merges — containment is only vetoed for a lesser class', () => {
  const db = mapDb();
  // The real November geometry: the mall's OSM row («ТЦ Бисер», mall) stands
  // ~40 m from Google's pin, inside the containment bound.
  const mallPid = add(db, { name: 'Biser Shopping Center', type: 'Shopping mall', ...BISER, source: 'google', place_id: 'pid-biser' });
  const osmMall = add(db, { name: 'ТЦ Бисер', type: 'mall', lat: 41.98522, lon: 21.46585, source: 'osm', place_id: null });

  identityHeal(db);

  const survivor = db.prepare('SELECT name, type, place_id FROM pois WHERE rowid = ?').get(osmMall) as { name: string; type: string; place_id: string | null };
  assert.equal(survivor.place_id, 'pid-biser', 'a mall adopts its mall anchor');
  assert.equal(survivor.name, 'ТЦ Бисер', 'the bilingual (OSM) name survives');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM pois WHERE rowid = ?').get(mallPid)!.c as number, 0, 'the anchor row is folded in');
  db.close();
});

test('the documented containment case (two shops, one name) still merges', () => {
  const db = mapDb();
  const anchor = add(db, { name: 'Reptil Market br.3 Kisela Voda', type: 'Market', lat: 41.97621, lon: 21.44476, source: 'google', place_id: 'pid-reptil' });
  const osm = add(db, { name: 'Рептил', type: 'market', lat: 41.97622, lon: 21.44478, source: 'osm', place_id: null });

  identityHeal(db);

  const row = db.prepare('SELECT place_id FROM pois WHERE rowid = ?').get(osm) as { place_id: string | null };
  assert.equal(row.place_id, 'pid-reptil', 'a shop still adopts its own Google anchor');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM pois WHERE rowid = ?').get(anchor)!.c as number, 0);
  db.close();
});

test('an IDENTICAL name still merges whatever the two rows are typed', () => {
  const db = mapDb();
  // Same token set, different class: the mall's identity still lands on its OSM
  // twin. Only the CONTAINMENT tier is vetoed, never the token tier.
  const anchor = add(db, { name: 'Трговски центар Капитол', type: 'Shopping mall', ...BISER, source: 'google', place_id: 'pid-kapitol' });
  const osm = add(db, { name: 'Трговски Центар Капитол', type: 'building', lat: BISER.lat, lon: BISER.lon, source: 'osm', place_id: null });

  identityHeal(db);

  const row = db.prepare('SELECT place_id FROM pois WHERE rowid = ?').get(osm) as { place_id: string | null };
  assert.equal(row.place_id, 'pid-kapitol');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM pois WHERE rowid = ?').get(anchor)!.c as number, 0);
  db.close();
});

test('the heal is idempotent — a second pass changes nothing', () => {
  const db = mapDb();
  add(db, { name: 'Biser Shopping Center', type: 'Shopping mall', ...BISER, source: 'google', place_id: 'pid-biser' });
  add(db, { name: 'Anhoch Бисер', type: 'computer', ...BISER, source: 'osm', place_id: null });

  identityHeal(db);
  const before = db.prepare('SELECT rowid, name, place_id FROM pois ORDER BY rowid').all();
  identityHeal(db);
  const after = db.prepare('SELECT rowid, name, place_id FROM pois ORDER BY rowid').all();

  assert.deepEqual(after, before, 're-running B2 must not fuse anything new');
  db.close();
});
