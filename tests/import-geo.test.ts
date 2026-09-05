import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/store/db';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { centerTrusted, canServeLandmark, type PropertyRow } from '../src/geo/landmarks';
import { importPropertyGeo } from '../src/geo/importGeo';
import path from 'path';
import fs from 'fs';
import os from 'os';

function tmpDb(): string {
  return path.join(os.tmpdir(), `import-geo-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** A map whose addresses mirror the real bug-report rows (АСНОМ 16/134,
 *  Lokov 5) with POIs near the resolved building so a landmark is found. */
function buildRealMap(): OfflineMapStore {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    // Real skopje-pois.db rows near Булевар Асном 16/134 (41.9878895, 21.4764927)
    { name: 'Парк Авионче', type: 'park', lat: 41.9885, lon: 21.4780, source: 'osm' },
    { name: 'Кафе бар Ван Гог', type: 'cafe', lat: 41.9880, lon: 21.4750, source: 'osm' },
    { name: 'Градежен факултет', type: 'university', lat: 41.9870, lon: 21.4785, source: 'osm' },
  ], [
    { street: 'Булевар Асном', housenumber: '16/134', lat: 41.9878895, lon: 21.4764927 },
    { street: 'Булевар Асном', housenumber: '24', lat: 41.9915295, lon: 21.4656274 },
    { street: 'Локов', housenumber: '5', lat: 41.974462, lon: 21.4402879 },
  ]);
  return new OfflineMapStore(dbPath);
}

describe('importPropertyGeo — Phase 1.2 import hook (pure local)', () => {
  let db: Db;
  let offlineMap: OfflineMapStore;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = new Db(':memory:');
    offlineMap = buildRealMap();
    // ZERO NETWORK: any fetch during an import is a bug. Spy and fail loudly.
    origFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('importPropertyGeo must NEVER call fetch (blocking test 1.2)');
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    offlineMap.close();
    db.close();
  });

  it('real street+number → lat/lon + trusted geo_source + a cached landmark', () => {
    const r = importPropertyGeo({ id: 89, eb: 89, address: 'Бул. АСНОМ Бр.134', location: 'Аеродром' }, { db, offlineMap });

    // Trusted offline building resolution (16/134 compound → exact row)
    assert.equal(typeof r.lat, 'number');
    assert.equal(typeof r.lon, 'number');
    assert.ok(Math.abs((r.lat as number) - 41.9878895) < 1e-6, `lat ${r.lat} = 16/134 building`);
    assert.ok(Math.abs((r.lon as number) - 21.4764927) < 1e-6);
    assert.ok(['osm_building', 'osm_interpolated'].includes(r.geo_source), `geo_source=${r.geo_source}`);
    assert.equal(r.landmarkCached, true, 'nearby POIs must be found offline and cached');
    assert.equal(r.queueReason, null, 'no queue when fully resolved');

    // A landmark IS cached, keyed by property.id, tier osm_poi, servable.
    const cached = db.db.prepare(
      `SELECT landmark, tier FROM landmarks WHERE property_id = ?`
    ).get(89) as { landmark: string; tier: string } | undefined;
    assert.ok(cached, 'landmark row must exist in the local cache');
    assert.ok(cached!.landmark.length >= 3);
    assert.equal(cached!.tier, 'osm_poi');

    // The cached osm_poi landmark is SERVEABLE: its center (osm_building) is trusted.
    assert.equal(centerTrusted('osm_building'), true);
    assert.equal(centerTrusted('osm_interpolated'), true);
  });

  it('"БИСЕР" (landmark-complex name) → null coords, osm_low_confidence, queued no_trusted_center', () => {
    const r = importPropertyGeo({ id: 50, eb: 50, address: 'БИСЕР', location: 'Аеродром' }, { db, offlineMap });

    assert.equal(r.lat, null);
    assert.equal(r.lon, null);
    assert.equal(r.geo_source, 'osm_low_confidence');
    assert.equal(r.geocoded_at, null, 'untrusted rows are never stamped geocoded_at');
    assert.equal(r.landmarkCached, false, 'never cache a landmark on an untrusted center');
    assert.equal(r.queueReason, 'no_trusted_center');

    const queue = db.db.prepare(
      `SELECT reason FROM geo_reresolve_queue WHERE property_id = ?`
    ).get(50) as { reason: string } | undefined;
    assert.ok(queue, 'geo_reresolve_queue row must exist');
    assert.equal(queue!.reason, 'no_trusted_center');
  });

  it('makes ZERO network calls (fetch spy never fires)', () => {
    // fetch already throws on ANY call — both the happy path and the fail path
    // must complete without touching it.
    const ok = importPropertyGeo({ id: 89, eb: 89, address: 'Бул. АСНОМ Бр.134', location: 'Аеродром' }, { db, offlineMap });
    assert.equal(ok.landmarkCached, true);
    const bad = importPropertyGeo({ id: 50, eb: 50, address: 'БИСЕР', location: 'Аеродром' }, { db, offlineMap });
    assert.equal(bad.landmarkCached, false);
    assert.equal(bad.queueReason, 'no_trusted_center');
  });

  it('street centroid (no house number, bare row) → coords but NOT trusted, queued', () => {
    const dbPath = tmpDb();
    writeMap(dbPath, [
      { name: 'Дом за слепи', type: 'school', lat: 41.9740, lon: 21.4400, source: 'osm' },
    ], [
      { street: 'Борис Трајковски', housenumber: 'ББ', lat: 42.0000, lon: 21.4300 },
    ]);
    const map = new OfflineMapStore(dbPath);
    const r = importPropertyGeo({ id: 77, eb: 77, address: 'ул. Борис Трајковски' }, { db, offlineMap: map });
    assert.equal(r.geo_source, 'osm_low_confidence');
    assert.equal(r.landmarkCached, false);
    assert.equal(typeof r.lat, 'number'); // centroid coords kept for the honest fallback
    assert.equal(r.queueReason, 'no_trusted_center');
    const queue = db.db.prepare(
      `SELECT reason FROM geo_reresolve_queue WHERE property_id = ?`
    ).get(77) as { reason: string } | undefined;
    assert.equal(queue!.reason, 'no_trusted_center');
    map.close();
  });

  it('PropertyRow with an osm_building center serves a cached osm_poi landmark', () => {
    // Regression for the Phase-1 chain: an osm_poi cache entry written at
    // import must be servable once the row carries the trusted offline source.
    assert.ok(centerTrusted('osm_building'));
    assert.ok(centerTrusted('osm_interpolated'));
    assert.ok(!centerTrusted('osm_low_confidence'));
    // osm_poi requires a trusted center — osm_building now qualifies.
    const row: PropertyRow = { id: 89, landmark_tier: 'osm_poi', geo_source: 'osm_building' };
    assert.equal(canServeLandmark(row), true);
  });
});
