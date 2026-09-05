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