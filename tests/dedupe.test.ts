import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normName, translitToLatin, OfflineMapStore, writeMap } from '../src/geo/offlineMap';

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-')), 'map.db');
}

test('normName: Cyrillic/Latin transliteration merges, meaningful words stay', () => {
  assert.equal(normName('Еурофарм'), 'eurofarm');
  assert.equal(normName('Eurofarm'), 'eurofarm');
  assert.equal(normName('Еурофарм'), normName('Eurofarm'));
  // punctuation/case noise merges
  assert.equal(normName(' Ramstore '), normName('ramstore'));
  // meaningful words are NOT stripped — different branches stay distinct
  assert.equal(normName('Kipper'), 'kipper');
  assert.equal(normName('Kipper Market - Butel'), 'kippermarketbutel');
  assert.notEqual(normName('Kipper'), normName('Kipper Market - Butel'));
});

test('translitToLatin covers the full Cyrillic alphabet', () => {
  assert.equal(translitToLatin('ЌИП'), 'kjip');   // ќ→kj
  assert.equal(translitToLatin('Џам'), 'dzham');   // џ→dzh, а→a
  assert.equal(translitToLatin('Шиш'), 'shish');   // ш→sh
  assert.equal(translitToLatin('Рамстор'), 'ramstor');
  assert.equal(translitToLatin('Љубов'), 'ljubov'); // љ→lj
  assert.equal(translitToLatin('Њутн'), 'njutn');   // њ→nj
  assert.equal(translitToLatin('Жена'), 'zhena');   // ж→zh
});

test('Google row within 30m of OSM row with equal normName → Google wins the output', () => {
  const dbPath = tmpDb();
  // Same physical place: OSM Cyrillic + Google Latin, ~10m apart.
  writeMap(dbPath, [
    { name: 'Еурофарм', type: 'pharmacy', lat: 41.99700, lon: 21.43000, source: 'osm' },
    { name: 'Eurofarm', type: 'pharmacy', lat: 41.99710, lon: 21.43010, source: 'google' },
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.99705, 21.43005, 500, 10);
  assert.equal(pois.length, 1, `expected exactly 1 deduped POI, got ${JSON.stringify(pois)}`);
  assert.equal(pois[0].name, 'Eurofarm', 'Google row must win the dedupe anchor');
  store.close();
});

test('name variants are NOT deduped (Kipper vs Kipper Market - Butel = different branches)', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Kipper', type: 'supermarket', lat: 41.99700, lon: 21.43000, source: 'osm' },
    { name: 'Kipper Market - Butel', type: 'supermarket', lat: 41.99710, lon: 21.43010, source: 'google' },
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.99705, 21.43005, 500, 10);
  assert.equal(pois.length, 2, `expected 2 distinct POIs (different branches), got ${JSON.stringify(pois)}`);
  store.close();
});

test('nearest POIs capped at limit, preference-ranked', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Кафе Миро', type: 'cafe', lat: 41.9970, lon: 21.4300 },           // ~50m, rank 1
    { name: 'Рамстор Мол', type: 'mall', lat: 41.9987, lon: 21.4308 },         // ~200m, rank 5
    { name: 'Парк Градски', type: 'park', lat: 41.9982, lon: 21.4310 },        // ~150m, rank 2
    { name: 'Аптека 24', type: 'pharmacy', lat: 41.9980, lon: 21.4305 },       // ~130m, rank 3
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.9966, 21.4302, 500, 3);
  assert.equal(pois.length, 3, 'capped at limit=3');
  // preference order: mall (5) > pharmacy (3) > park (2) > cafe (1)
  assert.equal(pois[0].name, 'Рамстор Мол');
  assert.equal(pois[1].name, 'Аптека 24');
  assert.equal(pois[2].name, 'Парк Градски');
  store.close();
});
test('same place_id merges ACROSS names and distances (embassy alias regression)', () => {
  // Production regression: the embassy override inserted TWO rows — official
  // Cyrillic name and feed alias — both with Google's verified place_id, ~84m
  // apart. The old name-equality dedupe let both into the top-3, so a re-ask
  // "rotated" to the identical place with the identical link.
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Амбасада на Црна Гора', type: 'embassy', lat: 41.9959869, lon: 21.418169, source: 'osm', place_id: '0x1354144841501047:0x71a2f884c5dc3050' },
    { name: 'Црногорска Амбасада', type: 'embassy', lat: 41.99572, lon: 21.41723, source: 'osm', place_id: '0x1354144841501047:0x71a2f884c5dc3050' },
    { name: 'Беверли Хилс', type: 'hotel', lat: 41.99369, lon: 21.41632, source: 'osm' },
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.99562, 21.41531, 600, 10);
  const names = pois.map(p => p.name);
  assert.equal(names.filter(n => /мбасад|рногорск/.test(n)).length, 1,
    `embassy must occupy exactly ONE slot, got: ${JSON.stringify(names)}`);
  assert.ok(names.includes('Беверли Хилс'), 'other landmarks must still appear');
  store.close();
});

test('same place_id: google anchor wins even when OSM row is closer', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Стара Османска Банка', type: 'bank', lat: 41.99560, lon: 21.41510, source: 'osm', place_id: '0xabc:0x123' },
    { name: 'Македонска Банка', type: 'bank', lat: 41.99600, lon: 21.41600, source: 'google', place_id: '0xabc:0x123' },
  ], []);
  const store = new OfflineMapStore(dbPath);
  const pois = store.nearestPois(41.99565, 21.41520, 500, 10);
  assert.equal(pois.length, 1, 'place_id pair must collapse to one row');
  assert.equal(pois[0].name, 'Македонска Банка', 'Google row wins the anchor regardless of name');
  assert.equal(pois[0].place_id, '0xabc:0x123');
  store.close();
});
