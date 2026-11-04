import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalType, normType, LANDMARK_PREFERENCE, typeRank } from '../src/geo/types';
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

test('the public-place ladder: schools, markets, cinemas, hospitals lead — and every place still serves', () => {
  // OWNER RULE (2026-10-29): schools, universities, markets, student
  // dormitories, theatres, cinemas, hospitals and the rest of the big PUBLIC
  // buildings are the landmarks a client means. All places stay candidates for
  // a search anchor — the ladder only decides their PRIORITY.
  assert.equal(typeRank('Elementary school'), typeRank('school'));
  assert.equal(typeRank('High school'), typeRank('school'));
  assert.equal(typeRank('college'), typeRank('university'));
  assert.equal(typeRank('General hospital'), typeRank('hospital'));
  assert.equal(typeRank('Movie theater'), typeRank('cinema'));
  assert.equal(typeRank('Market'), typeRank('market'));
  assert.equal(typeRank('marketplace'), typeRank('market'));
  assert.ok(typeRank('market') > typeRank('bank'), 'a market leads a bank');
  assert.ok(typeRank('cinema') >= typeRank('school'), 'a cinema is a public anchor');
  assert.ok(typeRank('theatre') > typeRank('cafe'), 'a theatre leads a cafe');
  assert.ok(typeRank('dormitory') > typeRank('pharmacy'), 'a dormitory leads a pharmacy');
  // …and the rest of the big PUBLIC buildings, under either Google or OSM name.
  assert.equal(typeRank('Tourist attraction'), typeRank('attraction'));
  assert.equal(typeRank('Historical landmark'), typeRank('attraction'));
  assert.equal(typeRank('Cultural center'), typeRank('cultural_center'));
  assert.equal(typeRank('community centre'), typeRank('community_centre'));
  assert.equal(typeRank('Post office'), typeRank('post_office'));
  assert.equal(typeRank('Outlet mall'), typeRank('mall'));
  assert.equal(typeRank('Nursery school'), typeRank('kindergarten'));
  assert.equal(typeRank('International school'), typeRank('school'));
  assert.ok(typeRank('courthouse') > typeRank('bank'), 'a courthouse leads a bank');
  assert.ok(typeRank('attraction') > typeRank('bank'), 'a visited landmark leads a bank');
  assert.ok(typeRank('post_office') > typeRank('cafe'), 'the post office still leads a cafe');
  assert.equal(typeRank('Discount supermarket'), typeRank('supermarket'));
  // OSM compound types take the best of their listed classes.
  assert.equal(typeRank('marketplace;fire_station'), typeRank('market'));
  // The audit's class lookup goes through the same alias table.
  assert.equal(canonicalType('Movie theater'), 'cinema');
  assert.equal(canonicalType(' Cultural centre '), 'cultural_center');
  // …and the small business is still a place, just last in line.
  assert.ok(typeRank('travel_agency') < typeRank('mall'));

  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Бисер Травел', type: 'travel_agency', lat: 41.99700, lon: 21.43000 }, // ~40m
    { name: 'ТЦ Бисер', type: 'Shopping mall', lat: 41.99600, lon: 21.43160 },     // ~170m
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.99670, 21.43000, 250, 10);
  assert.equal(pois[0].name, 'ТЦ Бисер', 'the mall leads the travel agency');
  assert.equal(pois[1].name, 'Бисер Травел', 'the agency is still served — priority, not exclusion');
  store.close();
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

test('significance first: a mall inside the ring outranks a closer cafe', () => {
  const dbPath = tmpDb();
  // THE POLICY (2026-10-17, the [13:20] capture): a client navigates by the
  // recognizable place — "кај Рамстор" / "кај Католичка" — not by the cafe that
  // merely happens to be nearer. Inside the honesty ring significance decides.
  writeMap(dbPath, [
    { name: 'Кафе Миро', type: 'cafe', lat: 41.9970, lon: 21.4300 },   // ~47m
    { name: 'ТЦ Мавровка', type: 'mall', lat: 41.9966, lon: 21.4311 }, // ~66m
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.9966, 21.4302, 200, 10);
  assert.ok(pois.length >= 2, `expected both POIs, got ${pois.length}`);
  assert.equal(pois[0].name, 'ТЦ Мавровка', 'a 66m mall must outrank a 47m cafe');
  assert.equal(pois[1].name, 'Кафе Миро');
  store.close();
});

test('a church outranks a closer pharmacy — the [13:20] Catholic-church case', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Аптека Линцура', type: 'pharmacy', lat: 41.99700, lon: 21.43050 }, // ~50m
    { name: 'Католичка црква Свети Јосиф', type: 'church', lat: 41.99800, lon: 21.43090 }, // ~170m
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.99660, 21.43020, 200, 10);
  assert.equal(pois[0].name, 'Католичка црква Свети Јосиф',
    `the church must be the anchor, got ${pois.map(p => p.name).join(', ')}`);
  assert.equal(pois[1].name, 'Аптека Линцура');
  store.close();
});

test('significance never reaches outside the ring', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Амбасада на Црна Гора', type: 'embassy', lat: 41.99930, lon: 21.43020 }, // ~300m
    { name: 'Кафе Миро', type: 'cafe', lat: 41.99680, lon: 21.43020 },                 // ~22m
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.99660, 21.43020, 200, 10);
  assert.deepEqual(pois.map(p => p.name), ['Кафе Миро'],
    'a 300m embassy is a distance answer, never a "во близина" candidate');
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

test('popularity breaks equal-significance, equal-distance ties', () => {
  const dbPath = tmpDb();
  // Two malls at the same distance: the better-known one leads. Distance is
  // still the tie-breaker before renown — the 100m mall precedes both.
  writeMap(dbPath, [
    { name: 'Популарен мол', type: 'mall', lat: 41.99600, lon: 21.43191, review_count: 1500 },     // ~140m
    { name: 'Помалку познат мол', type: 'mall', lat: 41.99600, lon: 21.43051, review_count: 7 },   // ~23m
    { name: 'Најпопуларно подалеку', type: 'mall', lat: 41.99600, lon: 21.43312, review_count: 50000 }, // ~240m
    { name: 'Рамстор Мол', type: 'mall', lat: 41.99600, lon: 21.43051, review_count: 1500 },      // same spot as the small mall
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.99600, 21.43020, 500, 10);
  assert.equal(pois[0].name, 'Рамстор Мол', 'same distance → the better-known mall leads');
  assert.equal(pois[1].name, 'Помалку познат мол');
  assert.equal(pois[2].name, 'Популарен мол', 'distance still decides before renown');
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