// TASK 2.1 — queue drain blocking tests (hermetic: no Supabase, no SerpApi,
// no sockets — the drain core is dependency-injected by design).
//
// [ ] Queue with a 'БИСЕР'-type property → after drain: lat/lon set,
//     geo_source='google_cached'
// [ ] Queue with a property outside bbox → geo_source stays
//     'osm_low_confidence', row deleted (geocode failed validation;
//     NOT kept looping)
// [ ] Budget exhaustion → remaining rows stay queued, script exits cleanly

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from '../src/store/db';
import { LandmarkStore } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { drainQueue, insideBbox, QueuedProperty } from '../src/geo/queueDrain';

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-drain-')), 'map.db');
}

/** In-memory "Supabase": the property rows the drain geocodes + patches. */
function makeStore(): { props: Map<number, QueuedProperty>; patches: Array<{ id: number; geo: any }> } {
  const props = new Map<number, QueuedProperty>();
  const patches: Array<{ id: number; geo: any }> = [];
  return {
    props,
    patches,
    getProperty: async (id: number) => props.get(id),
    updatePropertyGeo: async (id: number, geo: any) => { patches.push({ id, geo }); Object.assign(props.get(id)!, { lat: geo.lat, lon: geo.lon, geo_source: geo.geo_source }); },
  };
}

function queueRow(db: Db, propertyId: number, reason = 'no_trusted_center'): void {
  db.db.prepare(
    `INSERT OR IGNORE INTO geo_reresolve_queue (property_id, reason, created_at) VALUES (?, ?, ?)`
  ).run(propertyId, reason, Date.now());
}

function queueCount(db: Db): number {
  return (db.db.prepare(`SELECT COUNT(*) as c FROM geo_reresolve_queue`).get() as { c: number }).c;
}

test('2.1: БИСЕР-type property → drain geocodes (in bbox) → google_cached + landmark cached, queue empty', async () => {
  const db = new Db(':memory:');
  // POIs around TC BISER (~41.9976, 21.4351) so the re-resolve finds a landmark.
  const mapPath = tmpMapDb();
  writeMap(mapPath, [
    { name: 'Рамстор', type: 'mall', lat: 41.9976, lon: 21.4351, source: 'google' },
    { name: 'Парк', type: 'park', lat: 41.9980, lon: 21.4355, source: 'osm' },
  ], []);
  const offlineMap = new OfflineMapStore(mapPath);

  const st = makeStore();
  // The import-time state of a 'БИСЕР' property: nothing resolvable offline →
  // lat/lon null, osm_low_confidence, queued with no_trusted_center.
  st.props.set(60, { propertyId: 60, address: 'БИСЕР', location: 'Аеродром', lat: null, lon: null, geo_source: 'osm_low_confidence' });
  queueRow(db, 60);

  let geocodeCalls = 0;
  const res = await drainQueue({
    db, offlineMap,
    getProperty: st.getProperty,
    updatePropertyGeo: st.updatePropertyGeo,
    geocode: async () => { geocodeCalls++; return { lat: 41.9976, lon: 21.4351 }; }, // in bbox
    searchesLeft: () => 200,
  });

  // lat/lon set + geo_source upgraded to google_cached
  const prop = st.props.get(60)!;
  assert.equal(prop.lat, 41.9976);
  assert.equal(prop.lon, 21.4351);
  assert.equal(prop.geo_source, 'google_cached');
  assert.equal(st.patches.length, 1);
  assert.equal(st.patches[0].geo.geo_source, 'google_cached');
  assert.equal(geocodeCalls, 1, 'exactly ONE geocode call per property');
  // Landmark cached with the google tier (osm_poi → google upgrade)
  const cached = new LandmarkStore(db).get(60);
  assert.ok(cached, 'landmark cached at drain');
  assert.equal(cached!.tier, 'google');
  // Queue drained
  assert.equal(queueCount(db), 0);
  assert.equal(res.processed, 1);
  assert.equal(res.googleUpgraded, 1);
  assert.equal(res.landmarkCached, 1);
  offlineMap.close();
});

test('2.1: geocode lands OUTSIDE the bbox → stays osm_low_confidence, row deleted (no loop)', async () => {
  const db = new Db(':memory:');
  const mapPath = tmpMapDb();
  writeMap(mapPath, [{ name: 'Рамстор', type: 'mall', lat: 41.99, lon: 21.43, source: 'osm' }], []);
  const offlineMap = new OfflineMapStore(mapPath);

  const st = makeStore();
  st.props.set(61, { propertyId: 61, address: 'Невалидна адреса 999', location: 'Аеродром', lat: 41.99, lon: 21.43, geo_source: 'osm_low_confidence' });
  queueRow(db, 61, 'no_trusted_center');

  const res = await drainQueue({
    db, offlineMap,
    getProperty: st.getProperty,
    updatePropertyGeo: st.updatePropertyGeo,
    // Geocodes fine but NOT in Skopje (e.g. a wrong match across the border)
    geocode: async () => ({ lat: 42.10, lon: 21.60 }),
    searchesLeft: () => 200,
  });

  // NOT upgraded — never written an unvalidated google_cached claim
  assert.equal(st.patches.length, 0, 'outside-bbox result must NOT patch the property');
  const prop = st.props.get(61)!;
  assert.equal(prop.geo_source, 'osm_low_confidence');
  assert.equal(prop.lat, 41.99, 'coordinates untouched');
  // Row deleted — the property is NOT kept looping in the queue
  assert.equal(queueCount(db), 0);
  assert.equal(res.processed, 1);
  assert.equal(res.googleUpgraded, 0);
  assert.equal(res.landmarkCached, 0, 'untrusted center never caches a landmark');
  offlineMap.close();
});

test('2.1: budget exhausted → remaining rows stay queued, exits cleanly', async () => {
  const db = new Db(':memory:');
  const mapPath = tmpMapDb();
  writeMap(mapPath, [{ name: 'Рамстор', type: 'mall', lat: 41.9976, lon: 21.4351, source: 'osm' }], []);
  const offlineMap = new OfflineMapStore(mapPath);

  const st = makeStore();
  st.props.set(70, { propertyId: 70, address: 'Бул. АСНОМ Бр.134', location: 'Аеродром', lat: null, lon: null, geo_source: 'osm_low_confidence' });
  st.props.set(71, { propertyId: 71, address: 'Народен Фронт 23', location: 'Капиштец', lat: null, lon: null, geo_source: 'osm_low_confidence' });
  queueRow(db, 70);
  queueRow(db, 71);

  let geocodeCalls = 0;
  let res: Awaited<ReturnType<typeof drainQueue>>;
  try {
    res = await drainQueue({
      db, offlineMap,
      getProperty: st.getProperty,
      updatePropertyGeo: st.updatePropertyGeo,
      geocode: async () => { geocodeCalls++; return { lat: 41.9976, lon: 21.4351 }; },
      searchesLeft: () => 15, // below BUDGET_STOP (20) from the start
    });
  } catch (e) {
    assert.fail(`drain must exit cleanly on budget exhaustion, got: ${(e as Error).message}`);
    return;
  }

  assert.equal(geocodeCalls, 0, 'no geocode when the budget is already gone');
  assert.equal(st.patches.length, 0, 'no upgrade when the budget is already gone');
  assert.equal(queueCount(db), 2, 'rows stay queued for next month');
  assert.equal(res!.budgetStopped, 2);
  assert.equal(res!.processed, 0);
  assert.equal(res!.leftInQueue, 2);
  offlineMap.close();
});

test('2.1: insideBbox guard sanity', () => {
  assert.equal(insideBbox(41.9976, 21.4351), true);   // TC BISER — Skopje
  assert.equal(insideBbox(42.10, 21.60), false);      // outside Skopje bbox
  assert.equal(insideBbox(41.95, 21.35), true);       // bbox edge inclusive
  assert.equal(insideBbox(42.05, 21.50), true);
});
