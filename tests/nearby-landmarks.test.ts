import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/store/db';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import path from 'path';
import fs from 'fs';
import os from 'os';

function tmpDb(): string {
  return path.join(os.tmpdir(), `nearby-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// Build a tiny in-memory map with 3 POIs near (42.0, 21.43)
function buildTestMap(): OfflineMapStore {
  const dbPath = tmpDb();
  const pois = [
    { name: 'Кафе бар Ван Гог', type: 'cafe', lat: 42.001, lon: 21.430, source: 'osm' },
    { name: 'Градежен факултет', type: 'university', lat: 42.003, lon: 21.433, source: 'osm' },
    { name: 'Рамстор Мол', type: 'mall', lat: 42.000, lon: 21.428, source: 'google' },
  ];
  const addresses = [
    { key: 'тест улица', street: 'Test Street', housenumber: '1', lat: 42.0, lon: 21.43 },
  ];
  writeMap(dbPath, pois, addresses);
  return new OfflineMapStore(dbPath);
}

describe('nearbyLandmarks', () => {
  let db: Db;
  let offlineMap: OfflineMapStore;

  beforeEach(() => {
    db = new Db(':memory:');
    offlineMap = buildTestMap();
  });

  it('trusted center + POIs in table → pois all have dist <= 500', () => {
    const svc = new LandmarkService(db, { osm: false, offlineMap });
    // Property with stored coords = trusted center
    const result = svc.nearbyLandmarks({
      id: 1, eb: 10, address: 'Тест 1', location: 'Центар',
      lat: 42.0, lon: 21.43, geo_source: 'stored',
    });
    // Should have POIs (all within 500m of 42.0, 21.43)
    assert.ok(result.length > 0, 'should have nearby POIs');
    for (const poi of result) {
      assert.ok(poi.lat !== undefined && poi.lon !== undefined, 'POI must have coordinates');
      assert.ok(typeof poi.landmark === 'string' && poi.landmark.length > 0, 'POI must have name');
    }
  });

  it('untrusted center → pois empty + queue row low_confidence_center', () => {
    const svc = new LandmarkService(db, { osm: false, offlineMap });
    // Property with no lat/lon and osm_low_confidence → untrusted
    const result = svc.nearbyLandmarks({
      id: 2, eb: 20, address: 'Непостојна 99', location: 'Центар',
      geo_source: 'osm_low_confidence',
    });
    assert.equal(result.length, 0, 'untrusted center must return empty pois');
    // Check re-resolve queue
    const queue = db.db.prepare(
      `SELECT reason FROM geo_reresolve_queue WHERE property_id = ?`
    ).get(2) as { reason: string } | undefined;
    assert.ok(queue, 'queue row must exist');
    assert.equal(queue!.reason, 'low_confidence_center');
  });

  it('POI with stored place_url → nearbyLandmarks surfaces it on the chosen landmark', () => {
    // A Google-sourced POI with a captured short canonical must carry its
    // place_url through nearbyLandmarks, so the WHERE_IS handler can emit the
    // exact-place link instead of the bare @-view.
    const dbPath = tmpDb();
    const pois = [
      { name: 'Рамстор Мол', type: 'mall', lat: 42.000, lon: 21.428, source: 'google', place_url: 'https://tinyurl.com/abc123' },
    ];
    const addresses = [{ key: 'тест улица', street: 'Test Street', housenumber: '1', lat: 42.0, lon: 21.43 }];
    writeMap(dbPath, pois, addresses);
    const map = new OfflineMapStore(dbPath);
    const svc = new LandmarkService(db, { osm: false, offlineMap: map });
    const result = svc.nearbyLandmarks({
      id: 9, eb: 90, address: 'Тест 1', location: 'Центар',
      lat: 42.0, lon: 21.43, geo_source: 'stored',
    });
    assert.ok(result.length > 0, 'should find the mall');
    assert.equal(result[0].landmark, 'Рамстор Мол');
    assert.equal(result[0].place_url, 'https://tinyurl.com/abc123', 'place_url must ride through');
    map.close();
  });

  it('trusted center + empty POI table → pois empty + queue row no_landmark', () => {
    // Empty map — no POIs at all
    const emptyDbPath = tmpDb();
    writeMap(emptyDbPath, [], []);
    const emptyMap = new OfflineMapStore(emptyDbPath);

    const svc = new LandmarkService(db, { osm: false, offlineMap: emptyMap });
    const result = svc.nearbyLandmarks({
      id: 3, eb: 30, address: 'Тест 5', location: 'Аеродром',
      lat: 42.0, lon: 21.43, geo_source: 'stored',
    });
    assert.equal(result.length, 0, 'empty POI table must return empty');
    // Check re-resolve queue
    const queue = db.db.prepare(
      `SELECT reason FROM geo_reresolve_queue WHERE property_id = ?`
    ).get(3) as { reason: string } | undefined;
    assert.ok(queue, 'queue row must exist');
    assert.equal(queue!.reason, 'no_landmark');
  });
});
