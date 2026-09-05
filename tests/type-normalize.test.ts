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
    { name: 'Зграда А', type: 'residential', lat: 41.9970, lon: 21.4300 },
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
  for (const junk of ['Зграда А', 'Нешто', 'Фирма ДОО', 'Месна Заедница', 'Куќа']) {
    assert.ok(!names.includes(junk), `junk type leaked: ${junk} in ${names}`);
  }
  store.close();
});

test('a mall at 200m outranks a cafe at 50m in nearestPois (preference before distance)', () => {
  const dbPath = tmpDb();
  // cafe is 50m away, mall is 200m away — with pure-distance sorting the cafe
  // would win; typeRank must put the mall first.
  writeMap(dbPath, [
    { name: 'Кафе Миро', type: 'cafe', lat: 41.9970, lon: 21.4300 },   // ~50m
    { name: 'Рамстор Мол', type: 'mall', lat: 41.9987, lon: 21.4308 }, // ~200m
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.9966, 21.4302, 500, 10);
  assert.ok(pois.length >= 2, `expected both POIs, got ${pois.length}`);
  assert.equal(pois[0].name, 'Рамстор Мол', 'mall must outrank a closer cafe');
  assert.equal(pois[1].name, 'Кафе Миро');
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