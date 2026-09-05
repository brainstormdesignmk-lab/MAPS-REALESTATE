import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractDetailsLandmark } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap, type Center } from '../src/geo/offlineMap';
import path from 'path';
import fs from 'fs';
import os from 'os';

function tmpDb(): string {
  return path.join(os.tmpdir(), `details-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function buildTestMap(): OfflineMapStore {
  const dbPath = tmpDb();
  const pois = [
    { name: 'Рамстор Мол', type: 'mall', lat: 42.000, lon: 21.428, source: 'google' },
    { name: 'Градежен факултет', type: 'university', lat: 42.003, lon: 21.433, source: 'osm' },
  ];
  writeMap(dbPath, pois, []);
  return new OfflineMapStore(dbPath);
}

describe('extractDetailsLandmark', () => {
  let offlineMap: OfflineMapStore;
  const center: Center = { lat: 42.0, lon: 21.43, trusted: true };

  beforeEach(() => {
    offlineMap = buildTestMap();
  });

  it('description "спроти Рамстор" + Ramstore in pois → landmark with coords', () => {
    const result = extractDetailsLandmark(
      'Станот е спроти Рамстор Мол, на одлична локација.',
      center,
      offlineMap,
    );
    assert.ok(result, 'should match "спроти Рамстор"');
    assert.ok(result!.name.includes('Рамстор'), `name should contain Рамстор, got: ${result!.name}`);
    assert.ok(result!.lat !== null, 'lat should be set when POI found');
    assert.ok(result!.lon !== null, 'lon should be set when POI found');
  });

  it('same description, POI absent → landmark name set, lat/lon null', () => {
    const result = extractDetailsLandmark(
      'Станот е спроти Непостојно Место 123, мирна улица.',
      center,
      offlineMap,
    );
    assert.ok(result, 'should still match the regex');
    assert.ok(result!.name.length > 0, 'name should be set');
    assert.equal(result!.lat, null, 'lat must be null when POI not in table');
    assert.equal(result!.lon, null, 'lon must be null when POI not in table');
  });

  it('handler must never emit a coordinate link for a null-coords landmark', () => {
    // Simulate what the handler does: check lat/lon before building link
    const result = extractDetailsLandmark(
      'Кај Непостојното Место, тивка улица.',
      center,
      offlineMap,
    );
    assert.ok(result, 'should extract a name');
    // The handler guard: only build link when coords exist
    const wouldEmitLink = result!.lat !== null && result!.lon !== null;
    assert.equal(wouldEmitLink, false, 'must NOT emit coordinate link for null-coords landmark');
  });
});
