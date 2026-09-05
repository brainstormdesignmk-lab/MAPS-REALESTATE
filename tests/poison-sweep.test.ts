// TASK 2.2 — poison sweep blocking tests (hermetic: no Supabase, no SerpApi,
// no sockets — the sweep core is dependency-injected by design).
//
// [ ] osm_poi landmark measured > 500m from trusted center → tier downgraded
//     to osm_low_confidence, landmark_name UNTOUCHED, queued 'poison_sweep'
// [ ] osm_poi landmark measured ≤ 500m → kept, canServeLandmark serves it
// [ ] osm_poi landmark with untrusted center → downgraded (claim stale)
// [ ] feed/google/extract tiers → never touched by the sweep
// [ ] orphan cache row (property gone upstream) → deleted
// [ ] landmark not findable in refreshed POI table → kept (cannot measure)
// [ ] after downgrade, canServeLandmark() blocks serving (acceptance: the
//     cache can no longer serve poison)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from '../src/store/db';
import { canServeLandmark } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { sweepPoison, SweepProperty } from '../src/geo/poisonSweep';

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poison-sweep-')), 'map.db');
}

/** The real Skopje geometry this bug class was reported on: EB 89 on
 *  Бул. АСНОМ (41.9879, 21.4765) with 'Златна вилушка' ~1.2km off. */
const CENTER = { lat: 41.9879, lon: 21.4765 };
const POISON_POI = { name: 'Златна вилушка', type: 'restaurant', lat: 41.999, lon: 21.476, source: 'osm' as const };      // ~1.24km away
const GOOD_POI = { name: 'Парк Авионче', type: 'park', lat: 41.9879, lon: 21.4783, source: 'osm' as const };               // ~149m away

function makeMap(pois: Array<{ name: string; type: string; lat: number; lon: number; source: 'osm' | 'google' }>): { map: OfflineMapStore; path: string } {
  const p = tmpMapDb();
  writeMap(p, pois, []);
  return { map: new OfflineMapStore(p), path: p };
}

/** In-memory "Supabase": property rows the sweep measures against. */
function makeProps(rows: Array<[number, SweepProperty]>): {
  props: Map<number, SweepProperty>;
  getProperty: (id: number) => Promise<SweepProperty | undefined>;
} {
  const props = new Map(rows);
  return { props, getProperty: async (id: number) => props.get(id) };
}

function seedLandmark(db: Db, propertyId: number, landmark: string, tier: string): void {
  db.db.prepare(
    `INSERT OR REPLACE INTO landmarks (property_id, landmark, type, source, tier, resolved_at)
     VALUES (?, ?, 'poi', 'offline', ?, ?)`
  ).run(propertyId, landmark, tier, new Date().toISOString());
}

function landmarkRow(db: Db, propertyId: number): { landmark: string; tier: string | null } | undefined {
  return db.db.prepare(
    `SELECT landmark, tier FROM landmarks WHERE property_id = ?`
  ).get(propertyId) as any;
}

function queueRows(db: Db, propertyId: number): Array<{ reason: string }> {
  return db.db.prepare(
    `SELECT reason FROM geo_reresolve_queue WHERE property_id = ?`
  ).all(propertyId) as Array<{ reason: string }>;
}

test('2.2: osm_poi landmark 1.2km from trusted center → downgraded, name untouched, queued, serving blocked', async () => {
  const db = new Db(':memory:');
  const { map, path: mapPath } = makeMap([POISON_POI, GOOD_POI]);
  const st = makeProps([[89, { propertyId: 89, lat: CENTER.lat, lon: CENTER.lon, geo_source: 'osm_building' }]]);
  seedLandmark(db, 89, 'Златна вилушка', 'osm_poi');

  const res = await sweepPoison({ db, offlineMap: map, getProperty: st.getProperty });

  // The tier flipped — the landmark name is UNTOUCHED (privacy invariant)
  const row = landmarkRow(db, 89)!;
  assert.equal(row.tier, 'osm_low_confidence');
  assert.equal(row.landmark, 'Златна вилушка', 'landmark_name must never change in the sweep');
  // Enqueued for next month's drain to re-resolve properly
  const q = queueRows(db, 89);
  assert.equal(q.length, 1);
  assert.equal(q[0].reason, 'poison_sweep');
  // Acceptance: the cache can no longer serve poison
  assert.equal(canServeLandmark({ landmark_tier: row.tier, geo_source: 'osm_building' }), false);
  assert.equal(res.checked, 1);
  assert.equal(res.downgraded, 1);
  assert.equal(res.queued, 1);
  assert.equal(res.orphaned, 0);
  assert.equal(res.leftQueued, 1);
  map.close();
  fs.rmSync(mapPath, { force: true });
});

test('2.2: osm_poi landmark within 500m of trusted center → kept, still served', async () => {
  const db = new Db(':memory:');
  const { map, path: mapPath } = makeMap([POISON_POI, GOOD_POI]);
  const st = makeProps([[89, { propertyId: 89, lat: CENTER.lat, lon: CENTER.lon, geo_source: 'osm_building' }]]);
  seedLandmark(db, 89, 'Парк Авионче', 'osm_poi');

  const res = await sweepPoison({ db, offlineMap: map, getProperty: st.getProperty });

  const row = landmarkRow(db, 89)!;
  assert.equal(row.tier, 'osm_poi', 'verified landmark keeps its tier');
  assert.equal(canServeLandmark({ landmark_tier: row.tier, geo_source: 'osm_building' }), true);
  assert.equal(queueRows(db, 89).length, 0, 'verified landmark is never queued');
  assert.equal(res.checked, 1);
  assert.equal(res.downgraded, 0);
  assert.equal(res.queued, 0);
  map.close();
  fs.rmSync(mapPath, { force: true });
});

test('2.2: osm_poi landmark with UNTRUSTED center → downgraded + queued (stale center claim)', async () => {
  const db = new Db(':memory:');
  const { map, path: mapPath } = makeMap([GOOD_POI]);
  // Property exists but its center is a street-centroid guess — the cached
  // claim "verified against a real center" is stale.
  const st = makeProps([[70, { propertyId: 70, lat: null, lon: null, geo_source: 'osm_low_confidence' }]]);
  seedLandmark(db, 70, 'Парк Авионче', 'osm_poi');

  const res = await sweepPoison({ db, offlineMap: map, getProperty: st.getProperty });

  assert.equal(landmarkRow(db, 70)!.tier, 'osm_low_confidence');
  assert.equal(landmarkRow(db, 70)!.landmark, 'Парк Авионче', 'name untouched');
  assert.equal(queueRows(db, 70).length, 1);
  assert.equal(res.downgraded, 1);
  map.close();
  fs.rmSync(mapPath, { force: true });
});

test('2.2: trusted tiers (feed/google/extract) are never examined or touched', async () => {
  const db = new Db(':memory:');
  const { map, path: mapPath } = makeMap([POISON_POI, GOOD_POI]);
  const st = makeProps([
    [1, { propertyId: 1, lat: CENTER.lat, lon: CENTER.lon, geo_source: 'google_cached' }],
    [2, { propertyId: 2, lat: CENTER.lat, lon: CENTER.lon, geo_source: 'osm_building' }],
    [3, { propertyId: 3, lat: CENTER.lat, lon: CENTER.lon, geo_source: 'stored' }],
  ]);
  seedLandmark(db, 1, 'Златна вилушка', 'feed');
  seedLandmark(db, 2, 'Златна вилушка', 'google');
  seedLandmark(db, 3, 'Златна вилушка', 'extract');

  const res = await sweepPoison({ db, offlineMap: map, getProperty: st.getProperty });

  // The sweep's scope is ONLY the two low tiers — nothing else even counts.
  assert.equal(res.checked, 0);
  assert.equal(res.downgraded, 0);
  for (const id of [1, 2, 3]) {
    assert.equal(landmarkRow(db, id)!.tier, id === 1 ? 'feed' : id === 2 ? 'google' : 'extract', `tier ${id} untouched`);
  }
  assert.equal(queueRows(db, 1).length, 0);
  map.close();
  fs.rmSync(mapPath, { force: true });
});

test('2.2: orphan cache row (property gone upstream) → deleted, no loop', async () => {
  const db = new Db(':memory:');
  const { map, path: mapPath } = makeMap([POISON_POI, GOOD_POI]);
  const st = makeProps([]); // property 89 no longer exists upstream
  seedLandmark(db, 89, 'Златна вилушка', 'osm_poi');

  const res = await sweepPoison({ db, offlineMap: map, getProperty: st.getProperty });

  assert.equal(landmarkRow(db, 89), undefined, 'orphan cache row deleted');
  assert.equal(res.checked, 1);
  assert.equal(res.orphaned, 1);
  assert.equal(res.downgraded, 0);
  assert.equal(res.queued, 0);
  assert.equal(queueRows(db, 89).length, 0, 'no queue row for a deleted property');
  map.close();
  fs.rmSync(mapPath, { force: true });
});

test('2.2: landmark not findable in refreshed POI table → kept (cannot measure, benefit of the doubt)', async () => {
  const db = new Db(':memory:');
  // The POI table no longer has 'Златна вилушка' (refreshed) — absence of a
  // match is not proof of poison; only a MEASURED over-distance downgrades.
  const { map, path: mapPath } = makeMap([GOOD_POI]);
  const st = makeProps([[89, { propertyId: 89, lat: CENTER.lat, lon: CENTER.lon, geo_source: 'osm_building' }]]);
  seedLandmark(db, 89, 'Златна вилушка', 'osm_poi');

  const res = await sweepPoison({ db, offlineMap: map, getProperty: st.getProperty });

  assert.equal(landmarkRow(db, 89)!.tier, 'osm_poi', 'unmeasurable landmark is kept');
  assert.equal(queueRows(db, 89).length, 0);
  assert.equal(res.verified, 1);
  assert.equal(res.downgraded, 0);
  map.close();
  fs.rmSync(mapPath, { force: true });
});

test('2.2: already osm_low_confidence + still failing → stays blocked, enqueued for drain; verified one untouched', async () => {
  const db = new Db(':memory:');
  const { map, path: mapPath } = makeMap([GOOD_POI]);
  const st = makeProps([
    [70, { propertyId: 70, lat: null, lon: null, geo_source: 'osm_low_confidence' }], // failing: no trusted center
    [71, { propertyId: 71, lat: CENTER.lat, lon: CENTER.lon, geo_source: 'google_cached' }], // verified
  ]);
  seedLandmark(db, 70, 'Парк Авионче', 'osm_low_confidence');
  seedLandmark(db, 71, 'Парк Авионче', 'osm_low_confidence');

  const res = await sweepPoison({ db, offlineMap: map, getProperty: st.getProperty });

  // Failing low-confidence row: stays blocked (already osm_low_confidence),
  // but is queued so next month's drain geocodes + re-resolves it.
  assert.equal(landmarkRow(db, 70)!.tier, 'osm_low_confidence');
  assert.equal(queueRows(db, 70).length, 1);
  // Verified low-confidence row: still blocked (osm_low_confidence never
  // serves by design — the sweep only ever downgrades, per spec).
  assert.equal(landmarkRow(db, 71)!.tier, 'osm_low_confidence');
  assert.equal(queueRows(db, 71).length, 0);
  assert.equal(res.checked, 2);
  assert.equal(res.verified, 1);
  assert.equal(res.downgraded, 0, 'no tier flip needed — already the lowest tier');
  assert.equal(res.queued, 1);
  map.close();
  fs.rmSync(mapPath, { force: true });
});