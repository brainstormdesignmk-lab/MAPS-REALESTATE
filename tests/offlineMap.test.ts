import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { OfflineMapStore, writeMap, streetKey, toLatin, toCyrillic, normalizeStreet, normName,
  repairMixedScript, cleanPoiName, phoneticWordKeys, nearestAreaLabel,
  placeCategory, isShopLevelPlace, canonicalWordKey } from '../src/geo/offlineMap';

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

test('a client\'s Latin spelling of a Macedonian name reaches the place (ч → c)', () => {
  // The live [16:11] failure: „VO BLIZINA NA KATOLICKA“ named the city's
  // Католичка, but the engine's transliterator spells ч as "ch" — so every
  // character pass compared «katolicka» against «katolichka» and MISSed. The
  // client's OWN spelling (ч → c, ш → s, ѕ/џ → dz) is what toLatin() emits,
  // so the phonetic pass compares both sides through that fold.
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Католичка црква кон Центар', type: 'church', lat: 41.99467, lon: 21.41638 },
    // A second Католичка further out: the spelling must not decide WHICH one.
    { name: 'Католичка црква Свети Јосиф', type: 'church', lat: 42.00087, lon: 21.44047 },
  ], []);
  const store = new OfflineMapStore(dbPath);

  // One place for all four spellings the clients/programs produce.
  const expectName = 'Католичка црква кон Центар';
  for (const q of ['KATOLICKA', 'katolicka', 'katolichka', 'католицка']) {
    const hit = store.findPoiByName(q);
    assert.ok(hit, `${q} must resolve — the client's own spelling`);
    assert.equal(hit!.name, expectName, `${q} must reach the same church as the Cyrillic spelling`);
  }
  // …and the map's own spelling answers identically (no two-church split).
  assert.equal(store.findPoiByName('Католичка')!.name, expectName);

  // The yardstick: one key for one word, whichever spelling arrived.
  for (const w of ['Католичка', 'katolicka', 'katolichka', 'католицка']) {
    assert.deepEqual(phoneticWordKeys(w), ['katolicka'], `${w} shares the word key`);
  }
  assert.deepEqual(phoneticWordKeys('Буњаковец'), phoneticWordKeys('bunjakovets'));

  // The pass is LAST-RESORT and every word must be a word of the row: a name
  // the map does not hold stays a MISS, and venue vocabulary alone („katedrala“)
  // never resolves to whichever church happens to be nearest.
  assert.equal(store.findPoiByName('KATOLICKA PEKARA'), undefined);
  assert.equal(store.findPoiByName('katedrala'), undefined);
  assert.equal(store.findPoiByName('xylophone'), undefined);
  store.close();
});

test('the NEIGHBOURHOOD of a place is the map\'s nearest OSM quarter', () => {
  // The [17:26] ЛЕПТОКАРИЈА case: the funnel derived a district from a vote
  // over feed tags (Центар won) while OSM tags the mall's quarter Карпош 3
  // 219 m away. areaAt() is that geography; beyond maxM there is no label.
  const dbPath = tmpDb();
  const mall = { lat: 42.0035565, lon: 21.3990906 };
  writeMap(dbPath, [
    { name: 'ТЦ Лептокарија', type: 'place', ...mall },
    { name: 'Карпош 3', type: 'suburb', lat: 42.0032, lon: 21.3967 },
    { name: 'Тафталиџе', type: 'suburb', lat: 42.0015, lon: 21.4043 },
    { name: 'Водно', type: 'suburb', lat: 41.9700, lon: 21.4000 },
  ], []);
  const store = new OfflineMapStore(dbPath);
  const area = store.areaAt(mall.lat, mall.lon);
  assert.equal(area?.name, 'Карпош 3');
  assert.ok((area?.distance_m ?? 9999) < 400, `nearest quarter, got ${area?.distance_m} m`);
  // The radius is the honesty cap: a labelled quarter 600 m away is not the
  // place's neighbourhood.
  assert.equal(store.areaAt(mall.lat, mall.lon, 100), undefined);
  // Pure rule: same answer without a DB, and nothing outside the cap.
  const rows = [
    { name: 'Карпош 3', lat: 42.0032, lon: 21.3967 },
    { name: 'Тафталиџе', lat: 42.0015, lon: 21.4043 },
  ];
  assert.equal(nearestAreaLabel(rows, mall.lat, mall.lon)?.name, 'Карпош 3');
  assert.equal(nearestAreaLabel(rows, mall.lat, mall.lon, 50), undefined);
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

// ── A HOSPITAL CAN NEVER BECOME AN ACADEMY (the [15:36] capture) ───────────
// The client asked for a flat near «VOENA BOLNICA» (the old military hospital).
// Every name pass compares WORDS, and the two city places share «воена» — so a
// map that lacks the hospital row answered with «Воена академија Генерал
// Михаило Апостолски», a military ACADEMY five kilometres across town, and the
// card claimed the flat stood 390 m from it. placeCategory() is the structural
// guard: a phrase naming an institution only ever answers a row of the SAME
// kind (missing category → allowed; a CONTRADICTION → never).
test('a place can never be answered by a DIFFERENT KIND of place', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Воена академија Генерал Михаило Апостолски', type: 'university', lat: 41.9831366, lon: 21.4618829 },
    { name: 'Скопје Сити Мол', type: 'mall', lat: 42.0042193, lon: 21.3917118 },
  ], []);
  const store = new OfflineMapStore(dbPath);
  // The hospital is not on this map: the honest answer is a MISS, never the
  // academy the client never mentioned.
  assert.equal(store.findPoiByName('воена болница'), undefined);
  assert.equal(store.findPoiByName('VOENA BOLNICA'), undefined);
  assert.equal(store.findPoiByName('Воена болница Скопје'), undefined);
  // The academy itself still resolves, by its own words.
  assert.equal(store.findPoiByName('Воена академија')?.name, 'Воена академија Генерал Михаило Апостолски');
  // …and the mall is untouched by the guard (same category, same words).
  assert.equal(store.findPoiByName('Сити Мол')?.name, 'Скопје Сити Мол');
  store.close();

  // The colloquial name IS the hospital when the map holds it (EB 54's ad:
  // «спроти 8-ми Септември (старата воена болница)»).
  const withHospital = tmpDb();
  writeMap(withHospital, [
    { name: 'Воена академија Генерал Михаило Апостолски', type: 'university', lat: 41.9831366, lon: 21.4618829 },
    { name: 'Болница 8ми Септември', type: 'hospital', lat: 42.0039986, lon: 21.4016971 },
  ], []);
  const withHit = new OfflineMapStore(withHospital);
  assert.equal(withHit.findPoiByName('воена болница')?.name, 'Болница 8ми Септември');
  assert.equal(withHit.findPoiByName('VOENA BOLNICA')?.name, 'Болница 8ми Септември');
  withHit.close();
});

test('placeCategory: bounded institution words only', () => {
  assert.equal(placeCategory('Воена болница'), 'medical');
  assert.equal(placeCategory('Воена академија Генерал Михаило Апостолски'), 'academic');
  assert.equal(placeCategory('Skopje City Mall'), 'retail');
  assert.equal(placeCategory('Католичка црква кон Центар'), 'worship');
  assert.equal(placeCategory('Општина Бутел'), 'government');
  assert.equal(placeCategory('ТЦ Бисер'), 'retail');
  // An ordinary street/brand name names no institution — no category, no veto.
  assert.equal(placeCategory('Буњаковец'), undefined);
  assert.equal(placeCategory('Kipper Market'), 'retail');
});

test('isShopLevelPlace + enclosingComplex: a tenant is never the landmark, its mall is', () => {
  assert.equal(isShopLevelPlace('Butik Galion'), true);
  assert.equal(isShopLevelPlace('Boutique Bella'), true);
  assert.equal(isShopLevelPlace('Киоск Центар'), true);
  assert.equal(isShopLevelPlace('Shopping Center Capitol Mall'), false);
  assert.equal(isShopLevelPlace('ТЦ Бисер'), false);
  assert.equal(isShopLevelPlace('Тинекс'), false);
  assert.equal(isShopLevelPlace('Deni Market', 'Supermarket'), false);
  // A Google-typed tenant is caught by TYPE even without a shop word in its name.
  assert.equal(isShopLevelPlace('Galion', 'Clothing store'), true);

  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Butik Galion', type: 'Shopping mall', lat: 42.0010, lon: 21.4305 },
    { name: 'Кисми - Бисер', type: 'Shopping mall', lat: 42.0011, lon: 21.4304 },
    { name: 'ТЦ Бисер', type: 'mall', lat: 42.0012, lon: 21.4306 },
    { name: 'ТЦ Капитол', type: 'mall', lat: 42.0025, lon: 21.4320 },
    { name: 'Бутик Самотин', type: 'Clothing store', lat: 42.0200, lon: 21.4500 },
  ], []);
  const store = new OfflineMapStore(dbPath);
  // The complex the boutique stands in — a NAMED centre wins over a tenant
  // Google also typed «Shopping mall» («Кисми - Бисер» is a shop inside it).
  assert.equal(store.enclosingComplex(42.0010, 21.4305)?.name, 'ТЦ Бисер');
  // A shop with no complex around it has no substitute.
  assert.equal(store.enclosingComplex(42.0200, 21.4500), undefined);
  store.close();
});

// ── «ДАЈМОНД МОЛ» IS «Diamond Mall» (the [21:45] capture) ──────────────────
//   [21:45] A NESTO OKOLU DAJMOND MOL   → answered about EB 47's landmark
//   [21:45] STANCINJA OKOLU DIAMOND MALL? → «немам детали околу Дајмонд Мол»
// while the mall sat 300 m from that very flat. The j is the whole bug: a
// Skopje client writes «дајмонд»/«dajmond», the map holds Google's «Diamond»,
// and «dajmond» (djmnd) and «diamond» (dmnd) were two different words — so the
// only row that matched was the bookstore whose Cyrillic name carries
// «Дајмонд мол» verbatim, and the tenant answers (nobody navigates by it) were
// refused by the venue-first rule. The glide fold makes the two spellings one
// word and the mall row wins.
test('a j-type glide is a spelling, so «ДАЈМОНД МОЛ» reaches «Diamond Mall»', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Diamond Mall', type: 'Shopping mall', lat: 41.9903797, lon: 21.4299742 },
    { name: 'Literatura.mk Superstore - Diamond mall (Литература.мк -Дајмонд мол)', type: 'Book store', lat: 41.9910272, lon: 21.4285785 },
    { name: 'Католичка црква кон Центар', type: 'church', lat: 41.99467, lon: 21.41638 },
  ], []);
  const store = new OfflineMapStore(dbPath);

  // Every spelling the client and the programs produce lands on ONE place.
  for (const q of ['ДАЈМОНД МОЛ', 'дајмонд мол', 'DAJMOND MOL', 'DIMOND MALL', 'Diamond Mall']) {
    assert.equal(store.findPoiByName(q)?.name, 'Diamond Mall', `${q} must reach the mall`);
  }
  // …and the miss-recovery path (the handler's typo lane) too.
  assert.equal(store.findPoiByNameLoose('ДАЈМОНД МОЛ')?.name, 'Diamond Mall');
  store.close();

  // THE FOLD ITSELF: one key for the glide spellings, and a LEADING j is still
  // a letter («Јоле» is not «Оле») — only a glide INSIDE a word may vanish.
  assert.equal(canonicalWordKey('дајмонд'), canonicalWordKey('Diamond'));
  assert.equal(canonicalWordKey('Skopje'), canonicalWordKey('Скопје'));
  assert.notEqual(canonicalWordKey('Јоле'), canonicalWordKey('Оле'));
  // Short words carry no typo budget („KAM“/„KAN“ stay different places).
  assert.notEqual(canonicalWordKey('KAM'), canonicalWordKey('KAN'));
});

// ── A WORD THAT HEADS TWO PLACES: THE LANDMARK ANSWERS (the [00:46] capture) ─
//   [00:46] ZDRAVO , SAKAM DA KUPAM STANCE KAJ BISER , KAPITOL
//   [00:47] ЛИНА: Имам две недвижности близу Бисер Травел:
//                 • ЕБ 78 · Капиштец   • ЕБ 51 · Водно
// The map holds a travel AGENCY «Бисер Травел» (41.9909, 21.4211 — Капиштец)
// and the mall «Biser Shopping Center» (41.9850, 21.4657 — next to ТЦ Капитол,
// which the client NAMED). Both names START with the client's word, and the old
// shortest-name tie-break answered the 13-character office. Nobody navigates by
// an office: among rows the needle merely heads, the landmark (typeRank) wins,
// in either script.
test('a name that HEADS two places answers with the landmark, never the office', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Бисер Травел', type: 'travel_agency', lat: 41.9909374, lon: 21.4211242 },
    { name: 'Biser Shopping Center', type: 'Shopping mall', lat: 41.9849838, lon: 21.4656569 },
    { name: 'ТЦ Бисер', type: 'Bus stop', lat: 41.9851506, lon: 21.4664644 },
  ], []);
  const store = new OfflineMapStore(dbPath);

  for (const q of ['BISER', 'Biser', 'бисер']) {
    assert.equal(store.findPoiByName(q)?.name, 'Biser Shopping Center',
      `${q} must reach the mall — the bridge works in both scripts`);
  }
  // The agency is still reachable under its OWN name: the rule reorders head
  // hits, it never hides a place.
  assert.equal(store.findPoiByName('Бисер Травел')?.name, 'Бисер Травел');
  assert.equal(store.findPoiByName('biser travel')?.name, 'Бисер Травел');
  store.close();
});

// ── THE SLIP IS PER WORD ───────────────────────────────────────────────────
// The owner's «more tolerant» call after the [21:41]–[21:46] captures: a
// two-word name written with one slipped letter in EACH word is still the name
// the client said. The shape of the name is what may not change (a typo can
// never add, drop or re-order a word), so tolerance cannot reach another place.
test('miss-recovery allows one slip per word, never a different shape', () => {
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'Буњаковец Миладинов', type: 'place', lat: 41.99835, lon: 21.42350 },
    { name: 'Буњаковец кула 5', type: 'residential', lat: 41.9985, lon: 21.4236 },
    { name: 'Воена академија Генерал Михаило Апостолски', type: 'university', lat: 41.9831366, lon: 21.4618829 },
  ], []);
  const store = new OfflineMapStore(dbPath);
  // A QUALIFIER THE CLIENT OMITS is not a different place: «Бунјаковац 5» is
  // the map's «Буњаковец кула 5» (the handler's guard allows the one inserted
  // map word; the lookup must find the row in the first place).
  assert.equal(store.findPoiByName('Бунјаковац 5')?.name, 'Буњаковец кула 5');
  // One slip in the long word (the [21:42] «BUNJAKOVEC»/«Буњаковац» class).
  assert.equal(store.findPoiByNameLoose('Бунјаковац Миладинов')?.name, 'Буњаковец Миладинов');
  // Two slips, one per word — the «more tolerant» budget.
  assert.equal(store.findPoiByNameLoose('Бунјаковац Миладинова')?.name, 'Буњаковец Миладинов');
  // …but the name's SHAPE is the contract: an extra WORD is a different place
  // (every typed word must be a word of the row).
  assert.equal(store.findPoiByNameLoose('Буњаковец Миладинов Нови'), undefined);
  // A hospital stays a hospital: one slipped letter cannot reach an academy.
  assert.equal(store.findPoiByNameLoose('Воена болница'), undefined);
  assert.equal(store.findPoiByNameLoose('Воена болнице'), undefined);
  store.close();
});

test('a class word the client says picks the venue, not a building named after it', () => {
  // THE [16:41] CAPTURE: «TC DZEVAHIR». The complex's four residential towers
  // are each ONE WORD closer to the phrase than the shopping centre itself, so
  // the fewest-extra-words order answered «Џевахир кула Д» — a tower — while
  // the mall stood 100 m away. The phrase carries the class word «TC», so a row
  // whose type declares the mall answers first (same contract as «the mall is
  // the landmark, not the shop inside it»). A BUILDING row (`residential`, the
  // bare OSM `yes`/`place` fragments) is the only kind that yields, so the
  // two-rows-of-one-mall tie («Diamond Mall» / «ТЦ Дајмонд») is untouched.
  const dbPath = tmpDb();
  writeMap(dbPath, [
    { name: 'ТЦ Џевахир - Скопје', type: 'mall', lat: 41.9797, lon: 21.4662 },
    { name: 'Џевахир кула А', type: 'residential', lat: 41.9801, lon: 21.4648 },
    { name: 'Џевахир кула Б', type: 'residential', lat: 41.9800, lon: 21.4657 },
    { name: 'Џевахир кула Д', type: 'residential', lat: 41.9801, lon: 21.4667 },
    { name: 'Џевахир кула Ц', type: 'residential', lat: 41.9806, lon: 21.4663 },
  ], []);
  const store = new OfflineMapStore(dbPath);
  // Both the phrase that carries the class word («TC») and the map's own name
  // must reach the mall. («Dzevahir mol» deliberately is NOT here: the map has
  // no row holding the word «мол» for this complex, and the every-word rule
  // makes that an honest MISS in a fixture — on the shipped map the Google row
  // «Cevahir Mall» carries it.)
  for (const q of ['TC DZEVAHIR', 'ТЦ Џевахир']) {
    assert.equal(store.findPoiByName(q)?.name, 'ТЦ Џевахир - Скопје',
      `${q} names the mall, never one of its residential towers`);
  }
  // …and with NO class word the tower rows are still reachable (the class rule
  // only orders the answer, it never hides a place).
  assert.match(store.findPoiByName('Џевахир кула Д')?.name ?? '', /Џевахир кула Д/u);
  store.close();
});
