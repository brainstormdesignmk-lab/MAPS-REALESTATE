import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normType, LANDMARK_PREFERENCE, typeRank } from '../src/geo/types';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'type-norm-')), 'map.db');
}

test('normType: case + whitespace normalization', () => {
  assert.equal(normType('Pharmacy'), 'pharmacy');
  assert.equal(normType(' Discount supermarket '), 'discount supermarket');
  assert.equal(normType('  MALL  '), 'mall');
  assert.equal(normType('Pharmacy'), normType(' pharmacy '));
  assert.equal(normType(''), '');
  assert.equal(normType(null), '');
  assert.equal(normType(undefined), '');
});

test('LANDMARK_PREFERENCE has the canonical keys', () => {
  assert.ok('mall' in LANDMARK_PREFERENCE, 'mall key missing');
  assert.ok('school' in LANDMARK_PREFERENCE, 'school key missing');
  assert.ok('hospital' in LANDMARK_PREFERENCE, 'hospital key missing');
  // rank sanity: malls/institutions beat cafes/restaurants
  assert.ok(typeRank('mall') > typeRank('cafe'));
  assert.ok(typeRank('hospital') > typeRank('restaurant'));
  // normalized lookup works for dirty input
  assert.equal(typeRank(' MALL '), typeRank('mall'));
  assert.equal(typeRank('Pharmacy'), typeRank('pharmacy'));
  assert.equal(typeRank('garbage_type'), 0);
});

test('junk types never appear in nearestPois output', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Нешто', type: 'yes', lat: 41.9971, lon: 21.4301 },
    { name: 'Фирма ДОО', type: 'company', lat: 41.9972, lon: 21.4302 },
    { name: 'Парк', type: 'park', lat: 41.9973, lon: 21.4303 },
    { name: 'Месна Заедница', type: 'place', lat: 41.9974, lon: 21.4304 },
    { name: 'Куќа', type: 'house', lat: 41.9975, lon: 21.4305 },
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.9970, 21.4300, 500, 10);
  const names = pois.map(p => p.name);
  assert.ok(names.includes('Парк'), `expected Парк in ${names}`);
  for (const junk of ['Нешто', 'Фирма ДОО', 'Месна Заедница', 'Куќа']) {
    assert.ok(!names.includes(junk), `junk type leaked: ${junk} in ${names}`);
  }
  store.close();
});

test('a NAMED residential complex survives the junk filter (Beverly Hills class)', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Беверли Хилс', type: 'residential', lat: 41.9970, lon: 21.4300 },
    { name: 'Кафе', type: 'cafe', lat: 41.9971, lon: 21.4301 },
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.9970, 21.4300, 500, 10);
  const names = pois.map(p => p.name);
  assert.ok(names.includes('Беверли Хилс'), `named residential must survive: ${names}`);
  store.close();
});

test('nearest eligible place wins: a place at 50m outranks a mall at 200m', () => {
  const dbPath = tmpDb();
  // Distance leads throughout the eligible pool, not only inside a special band.
  writeMap(dbPath, [
    { name: 'Кафе Миро', type: 'cafe', lat: 41.9970, lon: 21.4300 },   // ~50m
    { name: 'Рамстор Мол', type: 'mall', lat: 41.9987, lon: 21.4308 }, // ~200m
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.9966, 21.4302, 500, 10);
  assert.ok(pois.length >= 2, `expected both POIs, got ${pois.length}`);
  assert.equal(pois[0].name, 'Кафе Миро', 'a 47m place must outrank a 238m mall');
  assert.equal(pois[1].name, 'Рамстор Мол');
  store.close();
});

test('nearest eligible place wins outside the former near band', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Кафе Далеку', type: 'cafe', lat: 41.99800, lon: 21.4302 }, // ~111m
    { name: 'Рамстор Мол', type: 'mall', lat: 41.99870, lon: 21.4308 }, // ~196m
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.99700, 21.4302, 500, 10);
  assert.equal(pois[0].name, 'Кафе Далеку', 'the nearer eligible public place leads');
  assert.equal(pois[1].name, 'Рамстор Мол');
  store.close();
});

test('EB 76 regression: a 76m embassy beats a popular 274m mall', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Амбасада на Црна Гора', type: 'embassy', lat: 41.99600, lon: 21.43113, review_count: 7 }, // ~76m
    { name: 'Беверли Хилс', type: 'mall', lat: 41.99600, lon: 21.43355, review_count: 1551 }, // ~274m
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.99600, 21.43020, 500, 10);
  assert.equal(pois[0].name, 'Амбасада на Црна Гора');
  assert.equal(pois[1].name, 'Беверли Хилс');
  store.close();
});

test('popularity breaks only close-distance ties', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Помалку познато место', type: 'embassy', lat: 41.99600, lon: 21.43142, review_count: 7 }, // ~100m
    { name: 'Популарен мол', type: 'mall', lat: 41.99600, lon: 21.43191, review_count: 1500 }, // ~140m
    { name: 'Најпопуларно подалеку', type: 'mall', lat: 41.99600, lon: 21.43312, review_count: 50000 }, // ~240m
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.99600, 21.43020, 500, 10);
  assert.equal(pois[0].name, 'Популарен мол', '40m close tie may favor the better-known place');
  assert.equal(pois[1].name, 'Помалку познато место');
  assert.equal(pois[2].name, 'Најпопуларно подалеку', 'a place outside the 50m tie group cannot jump ahead');
  store.close();
});

test('candidate cap is chosen by distance before popularity ranking', () => {
  const dbPath = tmpDb();
  const pois = Array.from({ length: 30 }, (_, i) => ({
    name: `Независимо Место ${String(i).padStart(2, '0')}`,
    type: 'mall',
    lat: 41.99600,
    lon: 21.43020 + (i + 1) * 0.00010,
    review_count: i === 5 ? 50000 : 5,
  }));
  writeMap(dbPath, pois, []);
  const store = new OfflineMapStore(dbPath);
  const selected = store.nearestPois(41.99600, 21.43020, 500, 5).map(p => p.name);
  const nearestFive = pois.slice(0, 5).map(p => p.name);
  assert.deepEqual(new Set(selected), new Set(nearestFive), 'a highly reviewed sixth POI cannot displace any of the five closest candidates');
  store.close();
});

test('capitalized Google types rank identically to lowercase OSM types', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Аптека Бета', type: 'Pharmacy', lat: 41.9970, lon: 21.4300 },
    { name: 'Аптека Алфа', type: 'pharmacy', lat: 41.9980, lon: 21.4300 },
    { name: 'Ресторан', type: 'restaurant', lat: 41.9960, lon: 21.4300 },
  ], []);
  const store = new OfflineMapStore(dbPath);
  // both pharmacies (same rank) sort by distance; restaurant ranks below
  const pois = store.nearestPois(41.9975, 21.4300, 500, 10);
  const names = pois.map(p => p.name);
  assert.equal(names[names.length - 1], 'Ресторан', 'restaurant (rank 1) must sort after pharmacies (rank 3)');
  assert.ok(names.indexOf('Аптека Алфа') < names.indexOf('Аптека Бета'), 'same-rank pharmacies sort by distance');
  store.close();
});

test('a named bus stop is a secondary fallback to the actual nearby place', () => {
  // The live 2026-10-11 case. Бул. АСНОМ 134 (Аеродром) has five bus stops
  // inside 250m — one of them literally called "Парк Аеродром" and only 95m
  // away — plus the park the neighbourhood is actually known by, „Парк
  // A stop sharing the park's name is not the park itself, so valid places
  // precede transit references; the stop remains available as a fallback.
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Парк Аеродром', type: 'bus_station', lat: 41.98840, lon: 21.47652 },          // ~95m, rank 3
    { name: 'Парк Авионче', type: 'park', lat: 41.98944, lon: 21.47676 },                 // ~180m, rank 4
    { name: 'Полициска Станица - Аеродром', type: 'police', lat: 41.98569, lon: 21.47345 }, // ~350m, rank 4
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.98794, 21.47659, 500, 10);
  assert.equal(pois[0].name, 'Парк Авионче', `the park must be the anchor, got ${pois.map(p => p.name).join(', ')}`);
  assert.ok(pois.some(p => p.name === 'Парк Аеродром'), 'the stop is still served, just not first');
  store.close();
});