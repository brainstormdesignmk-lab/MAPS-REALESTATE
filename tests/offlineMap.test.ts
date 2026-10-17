import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { OfflineMapStore, writeMap, streetKey, toLatin, toCyrillic, normalizeStreet, normName,
  repairMixedScript, cleanPoiName } from '../src/geo/offlineMap';

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

test('Latin diacritics fold before transliteration — never half-Cyrillic output', () => {
  // "Kapištec" printed as "Капиšтец" while the š survived the letter pass.
  assert.equal(toCyrillic('Kapištec'), 'капиштец');
  assert.equal(toCyrillic('Čair'), 'чаир');
  assert.equal(toCyrillic('Železara'), 'железара');
  assert.equal(toCyrillic('Goce Delčev'), 'гоце делчев');
  // Matching folds to the base letter (ш/с are already one class in CYR2LAT).
  assert.equal(toLatin('Kapištec'), 'kapistec');
  // A Cyrillic and a diacritic-Latin spelling of one place share the name key.
  assert.equal(normName('Капиштец'), normName('Kapištec'));
});

test('repairMixedScript: homoglyphs heal toward the word\'s own script', () => {
  // A Cyrillic word wearing Latin lookalikes → Cyrillic.
  assert.equal(repairMixedScript('Aмбасада на Руска Федерациjа'), 'Амбасада на Руска Федерација');
  assert.equal(repairMixedScript('Eуpoфapм'), 'Еурофарм');
  assert.equal(repairMixedScript('Туpиcт'), 'Турист');
  assert.equal(repairMixedScript('Блок Градски Sид'), 'Блок Градски Ѕид');
  assert.equal(repairMixedScript('Кaфе бар „Форца“'), 'Кафе бар „Форца“');
  // A LATIN name with a stray Cyrillic letter must stay Latin — a phonetic
  // pass would have invented "Оффице" / "Мара".
  assert.equal(repairMixedScript('Post Officе'), 'Post Office');
  assert.equal(repairMixedScript('Kindergarten "Buba Мara"'), 'Kindergarten "Buba Mara"');
  assert.equal(repairMixedScript('Rent a Car Skopje - AutoRentals.MК'), 'Rent a Car Skopje - AutoRentals.MK');
  assert.equal(repairMixedScript('АМSМ Bus Stop'), 'AMSM Bus Stop');
  // An accented Latin letter stuck inside a Cyrillic word (the reported
  // "Капиšтец") is transliterated, not left mixed.
  assert.equal(repairMixedScript('Капиšтец'), 'Капиштец');
  // Content stays content: bilingual rows and content words are untouched.
  assert.equal(repairMixedScript('Глуво куче;Gluvo Kuče'), 'Глуво куче;Gluvo Kuče');
  assert.equal(repairMixedScript('Теорема Скопје/Teorema Skopje'), 'Теорема Скопје/Teorema Skopje');
  // Roman numerals are Latin by convention in a Cyrillic address.
  assert.equal(repairMixedScript('Карпош III'), 'Карпош III');
  // Idempotent.
  const once = repairMixedScript('Aмбасада на Република Хрватска');
  assert.equal(repairMixedScript(once), once);
});

test('cleanPoiName: collapses padded whitespace and heals the artifact', () => {
  assert.equal(cleanPoiName('  Trgovski           centar „Kapištec“ '), 'Trgovski centar „Kapištec“');
  assert.equal(cleanPoiName('Пошта  Градски   Sид'), 'Пошта Градски Ѕид');
  assert.equal(cleanPoiName('Кафе бар Ван Гог'), 'Кафе бар Ван Гог');
});

test('the map build stores healed names, so a rebuild cannot reintroduce them', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Aмбасада на Руска Федерациjа', type: 'embassy', lat: 42.0002, lon: 21.4302 },
    { name: 'Post Officе', type: 'post_office', lat: 42.0003, lon: 21.4303 },
  ], []);
  const db = new Database(dbPath, { readonly: true });
  const stored = (db.prepare('SELECT name FROM pois ORDER BY name').all() as Array<{ name: string }>).map(r => r.name);
  db.close();
  assert.deepEqual(stored, ['Post Office', 'Амбасада на Руска Федерација']);
});

test('a row written by an older build is still found by an honest Cyrillic query', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [{ name: 'Кафе бар Ван Гог', type: 'cafe', lat: 42.0001, lon: 21.4301 }], []);
  // Simulate the legacy artifact row (the build now cleans, so insert raw).
  const raw = new Database(dbPath);
  raw.prepare('INSERT INTO pois (name, type, lat, lon) VALUES (?, ?, ?, ?)')
    .run('Aмбасада на Руска Федерациjа', 'embassy', 42.0002, 21.4302);
  raw.close();

  const store = new OfflineMapStore(dbPath);
  const hit = store.findPoiByName('Амбасада на Руска Федерација');
  assert.ok(hit, 'honest Cyrillic query must match the legacy row');
  assert.equal(hit!.name, 'Aмбасада на Руска Федерациjа'); // display layer heals it
  store.close();
});

test('nearestPois: significance first, radius respected, limit honored', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, POIS, ADDRESSES);
  const store = new OfflineMapStore(dbPath);
  assert.equal(store.available, true);

  const near = store.nearestPois(42.0, 21.43, 1000, 10);
  assert.equal(near.length, 2); // City Mall (>1.4km) is outside the 1000m ring
  // Significance decides first (a faculty is what people navigate by), then
  // distance within the same class — the cafe is nearer but less useful.
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

test('a client-typed place + venue word resolves across word order and language', () => {
  // The live [22:25] failure: „KOLKU IMA OD STANOT DO BUNJAKOVEC TRGOVSKI?“
  // — place name + venue word, the opposite order and the other language from
  // the map's own „Shopping Center Bunjakovec“. No contiguous character run is
  // shared, so every substring pass MISSed and the distance question fell
  // through to the service question.
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Shopping Center Bunjakovec', type: 'Shopping mall', lat: 42.0000, lon: 21.4300 },
    // Two decoys that share the SAME name tokens and sit CLOSER to the
    // property: a transit stop up the boulevard and the supermarket inside.
    // A distance-first ranking would answer for the bus stop.
    { name: 'Трговски Центар Буњаковец', type: 'bus_station', lat: 41.9995, lon: 21.4300 },
    { name: 'KAM Market - Bunjakovec Shopping Center', type: 'Discount supermarket', lat: 41.9994, lon: 21.4300 },
  ], []);
  const store = new OfflineMapStore(dbPath);
  const center = { lat: 41.9995, lon: 21.4300 };

  for (const q of ['BUNJAKOVEC TRGOVSKI', 'Bunjakovec trgovski', 'bunjakovec trgovskiot',
    'Буњаковец трговски']) {
    const hit = store.findPoiByName(q, center);
    assert.ok(hit, `${q} must resolve — the client's own phrasing`);
    assert.equal(hit!.name, 'Shopping Center Bunjakovec', `${q} must reach the mall, not the transit stop`);
  }

  // The venue word still narrows: „bunjakovec market“ is the supermarket.
  assert.equal(store.findPoiByName('bunjakovec market', center)!.name,
    'KAM Market - Bunjakovec Shopping Center');

  // …and a token the map does NOT have stays a MISS. The fallback requires
  // EVERY typed token to be present, so it can never guess a different place.
  assert.equal(store.findPoiByName('Bunjakovec pekara', center), undefined);
  // A bare venue word is not a place: no WHICH-word, no fallback — the honest
  // miss survives instead of resolving to whichever "centar" is closest.
  assert.equal(store.findPoiByName('centarot', center), undefined);
  assert.equal(store.findPoiByName('trgovskiot', center), undefined);
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
