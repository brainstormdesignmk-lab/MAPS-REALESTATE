import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OfflineMapStore, writeMap, streetKey, toLatin, toCyrillic, normalizeStreet } from '../src/geo/offlineMap';

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skopje-map-')), 'map.db');
}

// A tiny map around a fake point (lat 42.0, lon 21.43 — Skopje center-ish).
const POIS = [
  { name: 'Кафе бар Ван Гог', type: 'cafe', lat: 42.0001, lon: 21.4301 },   // ~14m
  { name: 'Градежен факултет', type: 'university', lat: 42.0025, lon: 21.4310 }, // ~280m
  { name: 'City Mall', type: 'mall', lat: 42.0100, lon: 21.4400 },            // >1.4km
];
const ADDRESSES = [
  { street: 'Boris Trajkovski', housenumber: '12', lat: 42.0000, lon: 21.4300 },
  { street: 'Партизански Одреди', housenumber: '', lat: 42.0050, lon: 21.4350 },
];

test('streetKey: Cyrillic and Latin spellings of the same street match', () => {
  assert.equal(streetKey('ул. Борис Трајковски 12'), streetKey('Boris Trajkovski'));
  assert.equal(streetKey('бул. Партизански Одреди'), streetKey('Partizanski Odredi'));
  assert.equal(streetKey('Партизански Одреди 22'), streetKey('Partizanski Odredi'));
  assert.ok(streetKey('Борис Трајковски') !== streetKey('Партизански Одреди'));
  // prefixes and house numbers are stripped
  assert.equal(normalizeStreet('ул. Борис Трајковски 12'), 'борис трајковски');
  assert.equal(normalizeStreet('Boulevard Partizanski Odredi 22'), 'partizanski odredi');
});

test('toLatin / toCyrillic round-trip', () => {
  assert.equal(toLatin('Борис Трајковски'), 'boris trajkovski');
  assert.equal(toCyrillic('boris trajkovski'), 'борис трајковски');
  assert.equal(toLatin(toCyrillic('boris trajkovski')), 'boris trajkovski');
});

test('nearestPois: nearest first, radius respected, limit honored', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, POIS, ADDRESSES);
  const store = new OfflineMapStore(dbPath);
  assert.equal(store.available, true);

  const near = store.nearestPois(42.0, 21.43, 1000, 10);
  assert.equal(near.length, 2); // City Mall (>1.4km) is outside the 1000m ring
  // TypeRank ranking: institutional landmarks first, then distance — the
  // university (rank 3) outranks the cafe (rank 1) despite being farther.
  assert.equal(near[0].name, 'Градежен факултет');
  assert.equal(near[1].name, 'Кафе бар Ван Гог');

  // 100m ring = only the cafe (the "rings" are just distances, one query)
  const tight = store.nearestPois(42.0, 21.43, 100, 10);
  assert.deepEqual(tight.map(p => p.name), ['Кафе бар Ван Гог']); // only one within 100m

  // limit
  assert.equal(store.nearestPois(42.0, 21.43, 1000, 1).length, 1);
  store.close();
});

test('geocodeAddress: matches the feed street locally, both scripts', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, POIS, ADDRESSES);
  const store = new OfflineMapStore(dbPath);

  const cyr = store.geocodeAddress('ул. Борис Трајковски 12');
  assert.ok(cyr, 'Cyrillic feed address must geocode');
  assert.equal(cyr!.street, 'Boris Trajkovski');
  assert.ok(Math.abs(cyr!.lat - 42.0) < 1e-6);

  const lat = store.geocodeAddress('Boris Trajkovski 12');
  assert.ok(lat, 'Latin address must geocode too');
  assert.equal(lat!.lat, cyr!.lat);

  assert.equal(store.geocodeAddress('Непостоечка Улица 5'), undefined); // miss → live Nominatim fallback
  assert.equal(store.geocodeAddress(''), undefined);
  store.close();
});

test('geocodeAddress: compound house numbers ("134" → "16/134")', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, POIS, [
    // "Бул. Асном 16/134" — compound number, the 134 is the door
    { street: 'Бул. Асном', housenumber: '24', lat: 42.010, lon: 21.440 },
    { street: 'Бул. Асном', housenumber: '16/134', lat: 42.001, lon: 21.431 },
  ]);
  const store = new OfflineMapStore(dbPath);
  // "Бр.134" should match "16/134", not "24"
  const hit = store.geocodeAddress('Бул. Асном бр.134');
  assert.ok(hit, 'compound number must match');
  assert.ok(Math.abs(hit!.lat - 42.001) < 1e-3, 'should resolve to 16/134 location, not 24');
  store.close();
});

test('no map file → unavailable, everything falls back to live APIs', () => {
  const store = new OfflineMapStore(path.join(os.tmpdir(), 'does-not-exist-surely.db'));
  assert.equal(store.available, false);
  assert.deepEqual(store.nearestPois(42.0, 21.43), []);
  assert.equal(store.geocodeAddress('ул. Пример'), undefined);
  assert.equal(store.stats(), null);
  store.close();
});

test('geocodeAddress: linear interpolation for missing house numbers', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, POIS, [
    // Народен Фронт: buildings #19A and #25, target #23 should interpolate
    { street: 'Народен Фронт', housenumber: '19A', lat: 41.9937, lon: 21.4163 },
    { street: 'Народен Фронт', housenumber: '25', lat: 41.9940, lon: 21.4146 },
  ]);
  const store = new OfflineMapStore(dbPath);
  const hit = store.geocodeAddress('Народен Фронт 23');
  assert.ok(hit, 'interpolation must produce a result');
  // #23 is between #19A (num=19.5) and #25 → fraction ≈ 0.636
  assert.ok(hit!.lat > 41.9937 && hit!.lat < 41.9940, 'lat must be between neighbors');
  assert.ok(hit!.lon < 21.4163 && hit!.lon > 21.4146, 'lon must be between neighbors');
  store.close();
});
