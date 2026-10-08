// THE STREET CENSUS CORE — pure classifier + cost projection + teach plan.
// Pins the runbook's DECISION GATE math: class (c) unknown streets are the
// whole point and are NEVER trimmed; class (b) teaches only feed-carried
// numbers and is first to be dropped; the cap slices searches in exactly
// that order. Also pins the street-anchor learning chain end-to-end on a
// temp map: one Google geocode → learnStreet → ANY number on that street
// resolves offline TRUSTED (the class-(c) contract).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  collectCandidates, classifyAll, classifyStreet, projectCoverage,
  pickThinNumbers, buildTeachPlan, streetPart, type StreetClassification,
} from '../src/geo/streetCensus';
import { OfflineMapStore, writeMap, streetKey } from '../src/geo/offlineMap';

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'street-census-')), 'map.db');
}

function freshMap(): OfflineMapStore {
  const p = tmpMapDb();
  writeMap(p, [
    { name: 'Рамстор', type: 'mall', lat: 41.9976, lon: 21.4351, source: 'google' },
  ], [
    // A KNOWN street: two numbered rows → interpolation possible.
    { street: 'Народен Фронт', housenumber: '19A', lat: 41.9937, lon: 21.4163 },
    { street: 'Народен Фронт', housenumber: '25', lat: 41.9940, lon: 21.4146 },
    // A THIN street: known but a single numbered row.
    { street: 'Тоне Томшиќ', housenumber: '25', lat: 41.9951, lon: 21.4249 },
    // An OSM street the feed never carried and with NO numbers.
    { street: 'Стара Кола', housenumber: 'ББ', lat: 41.9920, lon: 21.4200 },
  ]);
  return new OfflineMapStore(p);
}

// ---------------------------------------------------------------------------
// Candidate union
// ---------------------------------------------------------------------------

test('collectCandidates: union of map ∪ feed ∪ osm, feed numbers counted per street', () => {
  const map = freshMap();
  const cands = collectCandidates({
    mapStreets: ['Народен Фронт', 'Тоне Томшиќ', 'Стара Кола'],
    feedAddresses: ['Народен Фронт 23', 'Народен Фронт 23', 'Народен Фронт 30', 'Мирче Оровчанец 86 - 1'],
    osmStreets: ['Стара Кола'],
    probes: {
      knows: () => false,
      numberedRows: () => 0,
    },
  });
  map.close();
  const byKey = new Map(cands.map(c => [c.key, c]));
  assert.equal(cands.length, 4, 'union dedupes to 4 streets');
  const nf = byKey.get('naroden front')!;
  assert.ok(nf, 'Народен Фронт present');
  assert.deepEqual(nf.origins, ['map', 'feed'], 'origins merged in priority order');
  assert.equal(nf.feedNumbers.get('23'), 2, 'feed occurrences counted');
  assert.equal(nf.feedNumbers.get('30'), 1);
  assert.equal(nf.display, 'Народен Фронт', 'map spelling wins for display');
  // The trailing number was stripped from the street part.
  const mo = byKey.get('mirce orovcanec')!;
  assert.ok(mo, 'feed-only street present');
  assert.equal(mo.display, 'Мирче Оровчанец');
});

test('streetPart: strips trailing numbers, keeps numbered street names intact', () => {
  assert.equal(streetPart('Мирче Оровчанец 86 - 1'), 'Мирче Оровчанец');
  assert.equal(streetPart('Бул. АСНОМ Бр.134'), 'Бул. АСНОМ');
  assert.equal(streetPart('11 Октомври 25'), '11 Октомври', 'leading street number kept');
  assert.equal(streetPart('Јане Сандански'), 'Јане Сандански');
});

// ---------------------------------------------------------------------------
// Classification — the runbook's table
// ---------------------------------------------------------------------------

test('classifyStreet: known = ≥2 numbered rows; thin = 0–1 rows with feed numbers; unknown = not in map', () => {
  const mk = (key: string, display: string, numbers: Map<string, number>): StreetClassification['candidate'] =>
    ({ key, display, origins: ['feed'], feedNumbers: numbers, mapNumbers: 0 });  // mapNumbers is set by collectCandidates with the real probes — emulate
  // it BEFORE classifying (the classifier reads it at call time).
  const knownCand = mk('naroden front', 'Народен Фронт', new Map([['23', 1]]));
  knownCand.mapNumbers = 2;
  const known = classifyStreet(knownCand, true);
  assert.equal(known.cls, 'known');
  assert.deepEqual(known.teachNumbers, []);

  const thinCand = mk('tone tomsik', 'Тоне Томшиќ', new Map([['7', 1], ['31', 3]]));
  thinCand.mapNumbers = 1;
  const thin = classifyStreet(thinCand, true);
  assert.equal(thin.cls, 'thin');
  assert.deepEqual(thin.teachNumbers, ['31', '7'], 'feed-ranked by occurrence');

  const unknown = classifyStreet(
    mk('mirce orovcanec', 'Мирче Оровчанец', new Map([['86', 1]])), false);
  assert.equal(unknown.cls, 'unknown');
  assert.deepEqual(unknown.teachNumbers, [], 'unknowns take ONE street geocode, not per-number');
});

test('classifyStreet: thin street with NO feed numbers degrades to known (nothing to teach)', () => {
  const c = classifyStreet(
    { key: 'stara kola', display: 'Стара Кола', origins: ['map'], feedNumbers: new Map(), mapNumbers: 0 },
    true);
  assert.equal(c.cls, 'known', 'the standing B3 loop owns it, not the October spend');
});

test('pickThinNumbers: minCount trims the runbook trim-order (drop rare numbers first)', () => {
  const feed = new Map([['7', 1], ['31', 3], ['12', 2]]);
  assert.deepEqual(pickThinNumbers(feed), ['31', '12', '7']);
  assert.deepEqual(pickThinNumbers(feed, 2), ['31', '12']);
  assert.deepEqual(pickThinNumbers(feed, 4), []);
});

// ---------------------------------------------------------------------------
// Projection — the DECISION GATE math
// ---------------------------------------------------------------------------

test('projectCoverage: searches = unknown streets + thin feed numbers', () => {
  const map = freshMap();
  // Probes keyed on streetKey — the same normalization the runtime uses.
  const numbered: Record<string, number> = {
    'naroden front': 2,
    'tone tomsikj': 1, // streetKey: ќ → kj
    'stara kola': 0,
  };
  const probe = {
    knows: (s: string) => streetKey(s) in numbered,
    numberedRows: (s: string) => numbered[streetKey(s)] ?? -1,
  };
  const cands = collectCandidates({
    mapStreets: ['Народен Фронт', 'Тоне Томшиќ', 'Стара Кола'],
    feedAddresses: ['Народен Фронт 23', 'Тоне Томшиќ 31', 'Тоне Томшиќ 7', 'Мирче Оровчанец 86'],
    osmStreets: [],
    probes: probe,
  });
  const classified = classifyAll(cands, probe.knows);
  const p = projectCoverage(classified);
  map.close();

  assert.equal(p.unknown, 1, 'Мирче Оровчанец not in map');
  assert.equal(p.thin, 1, 'Тоне Томшиќ has 1 numbered row');
  assert.equal(p.thinNumbers, 2, 'its two feed-carried numbers');
  assert.equal(p.searches, 3, 'one per unknown + one per thin number');
});

// ---------------------------------------------------------------------------
// Teach plan — cap slicing honors the trip order
// ---------------------------------------------------------------------------

test('buildTeachPlan: class (c) first and NEVER trimmed by the cap; class (b) fills the remainder', () => {
  const classified: StreetClassification[] = [
    { candidate: { key: 'a', display: 'Аа', origins: ['feed'], feedNumbers: new Map(), mapNumbers: 0 }, cls: 'unknown', teachNumbers: [] },
    { candidate: { key: 'b', display: 'Бб', origins: ['feed'], feedNumbers: new Map(), mapNumbers: 0 }, cls: 'unknown', teachNumbers: [] },
    { candidate: { key: 'c', display: 'Вв', origins: ['feed'], feedNumbers: new Map([['5', 2], ['9', 1]]), mapNumbers: 1 }, cls: 'thin', teachNumbers: ['5', '9'] },
  ];
  // Budget 3: two unknowns (1 each) + ONE thin number.
  const plan = buildTeachPlan(classified, { mode: 'all', cap: 3 });
  assert.deepEqual(plan.map(t => t.cls), ['unknown', 'unknown', 'thin']);
  assert.deepEqual(plan[2].numbers, ['5'], 'highest-occurring number first');
  // Budget 2: the unknowns survive ENTIRELY, thin is dropped.
  const plan2 = buildTeachPlan(classified, { mode: 'all', cap: 2 });
  assert.deepEqual(plan2.map(t => t.cls), ['unknown', 'unknown']);
  // Mode filters.
  assert.equal(buildTeachPlan(classified, { mode: 'unknown' }).length, 2);
  assert.equal(buildTeachPlan(classified, { mode: 'thin' }).length, 1);
});

// ---------------------------------------------------------------------------
// Street-anchor learning — the class-(c) end-to-end chain on a real map
// ---------------------------------------------------------------------------

test('learnStreet: one geocode makes ANY number on the street resolve trusted offline', () => {
  const map = freshMap();
  const ADDR = 'Мирче Оровчанец 86 - 1';
  assert.equal(map.resolvePropertyOffline(ADDR).trusted, false, 'unknown before');
  assert.equal(map.knowsStreet('Мирче Оровчанец'), false);

  assert.equal(map.learnStreet('Мирче Оровчанец', 41.9991, 21.4130), true);

  // The street now exists and serves trusted for numbers it never learned.
  assert.equal(map.knowsStreet(ADDR), true);
  const r = map.resolvePropertyOffline(ADDR);
  assert.equal(r.trusted, true, 'google_street anchor is trusted (osm_street_anchor)');
  assert.equal(r.source, 'osm_street_anchor');
  assert.equal(r.lat, 41.9991);

  // A DIFFERENT number on the same street: trusted too — the whole point.
  const r2 = map.resolvePropertyOffline('Мирче Оровчанец 40');
  assert.equal(r2.trusted, true);
  assert.equal(r2.source, 'osm_street_anchor');

  // Number-level learning still outranks the anchor (Stage A before Stage C).
  assert.equal(map.learnAddress(ADDR, 41.99915, 21.41305), true);
  const r3 = map.resolvePropertyOffline(ADDR);
  assert.equal(r3.trusted, true);
  assert.equal(r3.source, 'osm_building', 'exact row beats the street anchor');
  assert.equal(r3.lat, 41.99915);
  map.close();
});

test('learnStreet: OSM ББ centroid stays UNTRUSTED; re-teach refreshes anchor coordinates', () => {
  const map = freshMap();
  // Стара Кола carries only an OSM ББ row — never trusted.
  const before = map.resolvePropertyOffline('Стара Кола 5');
  assert.equal(before.trusted, false, 'OSM centroid is a label, not ground truth');

  // Teach the street → the anchor upgrades the OSM row in place.
  assert.equal(map.learnStreet('Стара Кола', 41.9922, 21.4204), true);
  const after = map.resolvePropertyOffline('Стара Кола 5');
  assert.equal(after.trusted, true);
  assert.equal(after.lat, 41.9922);

  // Re-teach refreshes coordinates (idempotent, no duplicate rows).
  assert.equal(map.learnStreet('Стара Кола', 41.9923, 21.4205), true);
  const refreshed = map.resolvePropertyOffline('Стара Кола 5');
  assert.equal(refreshed.lat, 41.9923);
  map.close();
});

test('learnStreet: refuses junk (no street name, garbage) — nothing written', () => {
  const map = freshMap();
  assert.equal(map.learnStreet('', 41.99, 21.41), false);
  assert.equal(map.learnStreet('86', 41.99, 21.41), false);
  assert.equal(map.learnStreet('Некое Име', Number.NaN, 21.41), false);
  map.close();
});
