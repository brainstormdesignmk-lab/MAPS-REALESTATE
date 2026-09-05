import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-offline-')), 'map.db');
}

test('resolvePropertyOffline: exact building (Бул. АСНОМ Бр.134 → 16/134)', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [], [
    // Real rows from skopje-pois.db: "134" is the door of compound 16/134
    { street: 'Булевар Асном', housenumber: '16/134', lat: 41.9878895, lon: 21.4764927 },
    { street: 'Булевар Асном', housenumber: '24', lat: 41.9915295, lon: 21.4656274 },
  ]);
  const store = new OfflineMapStore(dbPath);
  const r = store.resolvePropertyOffline('Бул. АСНОМ Бр.134');
  assert.equal(r.trusted, true);
  assert.equal(r.source, 'osm_building');
  assert.ok(Math.abs((r as { lat: number }).lat - 41.9878895) < 1e-6, '16/134 building coords');
  assert.ok(Math.abs((r as { lon: number }).lon - 21.4764927) < 1e-6);
  store.close();
});

test('resolvePropertyOffline: interpolation (Народен Фронт 23 → between 19A and 25)', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [], [
    { street: 'Народен Фронт', housenumber: '19A', lat: 41.9937, lon: 21.4163 },
    { street: 'Народен Фронт', housenumber: '25', lat: 41.9940, lon: 21.4146 },
  ]);
  const store = new OfflineMapStore(dbPath);
  const r = store.resolvePropertyOffline('Народен Фронт 23');
  assert.equal(r.trusted, true);
  assert.equal(r.source, 'osm_interpolated');
  const lat = (r as { lat: number }).lat;
  const lon = (r as { lon: number }).lon;
  // ~41.9938, ~21.4154 — between the two neighbours (matches spec estimate)
  assert.ok(lat > 41.9937 && lat < 41.9940, `lat ${lat} between neighbours`);
  assert.ok(lon < 21.4163 && lon > 21.4146, `lon ${lon} between neighbours`);
  assert.ok(Math.abs(lat - 41.9939) < 0.0005, `lat ${lat} ≈ 41.9938`);
  assert.ok(Math.abs(lon - 21.4152) < 0.001, `lon ${lon} ≈ 21.4154`);
  store.close();
});

test('resolvePropertyOffline: exact building (Локов 5)', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [], [
    { street: 'Локов', housenumber: '5', lat: 41.974462, lon: 21.4402879 },
  ]);
  const store = new OfflineMapStore(dbPath);
  const r = store.resolvePropertyOffline('Локов 5');
  assert.equal(r.trusted, true);
  assert.equal(r.source, 'osm_building');
  assert.ok(Math.abs((r as { lat: number }).lat - 41.974462) < 1e-6);
  store.close();
});

test('resolvePropertyOffline: landmark/complex name (БИСЕР) → honest fail, null coords', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [], [
    { street: 'Народен Фронт', housenumber: '19A', lat: 41.9937, lon: 21.4163 },
  ]);
  const store = new OfflineMapStore(dbPath);
  const r = store.resolvePropertyOffline('БИСЕР');
  assert.equal(r.trusted, false);
  assert.equal(r.source, 'osm_low_confidence');
  assert.equal((r as { lat: number | null }).lat, null);
  assert.equal((r as { lon: number | null }).lon, null);
  store.close();
});

test('resolvePropertyOffline: street outside the map → not trusted', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [], [
    { street: 'Локов', housenumber: '5', lat: 41.974462, lon: 21.4402879 },
  ]);
  const store = new OfflineMapStore(dbPath);
  const r = store.resolvePropertyOffline('Непостоечка Улица 12');
  assert.equal(r.trusted, false);
  assert.equal(r.source, 'osm_low_confidence');
  store.close();
});

test('resolvePropertyOffline: centroid-only row → coords present but NOT trusted', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [], [
    { street: 'Борис Трајковски', housenumber: 'ББ', lat: 42.0000, lon: 21.4300 },
  ]);
  const store = new OfflineMapStore(dbPath);
  const r = store.resolvePropertyOffline('ул. Борис Трајковски');
  assert.equal(r.trusted, false);
  assert.equal(r.source, 'osm_low_confidence');
  // Street-level guess: coords exist (for the honest "населба" fallback) but
  // must NEVER anchor a landmark claim.
  assert.equal(typeof (r as { lat: number | null }).lat, 'number');
  store.close();
});

test('geocodeAddress: behavior unchanged by the shared-chain refactor', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [], [
    { street: 'Бул. Асном', housenumber: '16/134', lat: 41.9878895, lon: 21.4764927 },
    { street: 'Народен Фронт', housenumber: '19A', lat: 41.9937, lon: 21.4163 },
    { street: 'Народен Фронт', housenumber: '25', lat: 41.9940, lon: 21.4146 },
    { street: 'Локов', housenumber: '5', lat: 41.974462, lon: 21.4402879 },
  ]);
  const store = new OfflineMapStore(dbPath);
  // Same coords the old inline chain produced — trust collapsed away.
  assert.deepEqual(store.geocodeAddress('Бул. АСНОМ бр.134'), { lat: 41.9878895, lon: 21.4764927, street: 'Бул. Асном' });
  const interp = store.geocodeAddress('Народен Фронт 23')!;
  assert.ok(interp.lat > 41.9937 && interp.lat < 41.9940);
  assert.deepEqual(store.geocodeAddress('Локов 5'), { lat: 41.974462, lon: 21.4402879, street: 'Локов' });
  assert.equal(store.geocodeAddress('Непостоечка Улица 12'), undefined);
  store.close();
});

test('geocodeAddress: fuzzy typo fallback survives the refactor', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [], [
    { street: 'Евтим Спространов', housenumber: '5', lat: 41.9900, lon: 21.4200 },
  ]);
  const store = new OfflineMapStore(dbPath);
  // One-edit typo: Ефтим vs Евтим
  const hit = store.geocodeAddress('Ефтим Спространов 5');
  assert.ok(hit, 'typo must resolve via the unambiguous 1-edit fuzzy match');
  assert.equal(hit!.street, 'Евтим Спространов');
  store.close();
});
