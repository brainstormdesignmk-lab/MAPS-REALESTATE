// THE PLACE-IDENTITY GATE — one place must occupy ONE rotation slot.
//
// The bug this locks down (2026-10-08, the maps fixes): the map held the same
// building twice and the rotation served it twice —
//   [21:33] „…во близина на Embassy of Montenegro." + maps.google.com/?cid=…
//   [21:34] „…во близина на Амбасада на Црна Гора." + maps.google.com/?q=…
// One building, two names (English + Macedonian), two link forms. The identity
// passes compared name keys by EXACT string equality, so bureaucratic padding
// ("of the Republic of") and word order defeated them, and the embassy tier
// self-disabled whenever a country had a consular section or a residence.
//
// The pure-rule cases below are the ones that actually shipped wrong. The
// last test is the standing AUDIT: it walks the live map and fails if any two
// rotation entries are, by the runtime's own rule, the same place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  identityKey, samePlaceName, samePlacePoi, countriesIn, countryContradiction,
  mergeSamePlace, OfflineMapStore, writeMap, type MergedPoi,
} from '../src/geo/offlineMap';
import { LandmarkService, resolveSearchCenter, type PropertyRow } from '../src/geo/landmarks';
import { Db } from '../src/store/db';

test('identityKey: word order and bureaucratic padding are not identity', () => {
  assert.equal(identityKey('Амбасада на Турција'), identityKey('Embassy of Republic of Turkey'));
  assert.equal(identityKey('Амбасада на Република Чешка'), identityKey('Embassy of the Czech Republic'));
  assert.equal(identityKey('Амбасада на Црна Гора'), identityKey('Embassy of Montenegro'));
  assert.equal(identityKey('Три Бисери'), identityKey('Tri Biseri'));
});

test('identityKey: DIGITS survive — numbered branches stay apart', () => {
  assert.notEqual(identityKey('Бит Пазар 1'), identityKey('Бит Пазар 2'));
  assert.notEqual(identityKey('ФИНКИ - Барака 1'), identityKey('ФИНКИ - Барака 2'));
  assert.notEqual(identityKey('Клинички Центар Т3'), identityKey('Клинички Центар Т50'));
  // …and the same place with a number still matches itself
  assert.equal(identityKey('Рептил 3'), identityKey('Рептил 3'));
});

test('the reported pairs agree; contradictory countries never do', () => {
  const g = { lat: 41.98138, lon: 21.43845 };
  const near = (n: number) => ({ lat: g.lat + n / 111320, lon: g.lon });
  assert.equal(samePlaceName('Амбасада на Турција', 'Embassy of Republic of Turkey', 0).same, true);
  assert.equal(samePlaceName('Амбасада на Република Чешка', 'Embassy of the Czech Republic', 4).same, true);
  assert.equal(samePlaceName('Амбасада на Црна Гора', 'Embassy of Montenegro', 83).same, true);
  // A country contradiction is still absolute, at any distance.
  assert.equal(samePlaceName('Британска амбасада', 'Embassy of France', 0).same, false);
  assert.equal(countryContradiction('Британска амбасада', 'Embassy of France'), true);
  // Beyond every bound, no claim.
  assert.equal(samePlaceName('Амбасада на Црна Гора', 'Embassy of Montenegro', 500).same, false);
  void near;
});

test('containment (subset) needs an identified site + a local-script twin', () => {
  // The Reptil duplication: Google's fuller branch name and OSM's short name at
  // the same coordinates. Exactly ONE side carries a place_id — that asymmetry
  // is the licence.
  assert.equal(
    samePlaceName('Рептил', 'Reptil Market br.3 Kisela Voda', 0, false, true).same, true,
    'an identified site absorbs its local-script twin');
  // Two un-identified rows sharing only a brand are DIFFERENT branches — the
  // long-standing Kipper protection must survive.
  assert.equal(
    samePlaceName('Kipper', 'Kipper Market - Butel', 13, false, false).same, false,
    'brand + neighbourhood without an identity must NOT merge');
  // An institution never absorbs its own residence/consular section.
  assert.equal(
    samePlaceName('Амбасада на Турција', 'Turkish Embassy (Residence)', 30, false, true).same, false,
    'the residence is a different building');
  assert.equal(
    samePlaceName('Амбасада на Турција', 'Consular Section of the Embassy of the Czech Republic', 30, false, true).same, false);
});

test('embassy uniqueness accepts one plausible same-country candidate', () => {
  // Both embassy rows, same country, SAME qualifier state, 120m apart: the tier
  // that used to be skipped whenever a consulate/residence also claimed the
  // country (Czech: 2 candidates, Turkey: 2 → "ambiguous" → no merge at all).
  assert.equal(
    samePlaceName('Амбасада на Франција', 'Embassy of France, Skopje', 120).same, true);
  assert.equal(countriesIn('Амбасада на Франција').has('france'), true);
});

test('samePlacePoi: identical place_id equals one place at ANY distance', () => {
  const a: MergedPoi = { name: 'Embassy of Montenegro', type: 'Embassy', lat: 41.9959, lon: 21.4181, dist: 0, place_id: '0x1:0x2' };
  const b: MergedPoi = { name: 'Нешто сосема друго', type: 'place', lat: 41.99, lon: 21.40, dist: 900, place_id: '0x1:0x2' };
  assert.equal(samePlacePoi(a, b).same, true);
});

test('identity transfer: a rank-0 Google row still donates its place card', () => {
  // Turkey in the live map: the Google anchor is typed "Corporate office"
  // (typeRank 0), so the OSM "diplomatic" row wins the rotation slot — and the
  // slot used to be served without an identity, i.e. a raw ?q= pin although the
  // map KNEW the place_id. The merge adopts it, so the answer is a place card.
  const a: MergedPoi = { name: 'Амбасада на Турција', type: 'diplomatic', lat: 42.0035575, lon: 21.434606, dist: 0 };
  const b: MergedPoi = { name: 'Embassy of Republic of Turkey', type: 'Corporate office', lat: 42.0035575, lon: 21.434606, dist: 0, place_id: '0x135415ae91924109:0x1605863f0c240a04', rating: 4.4, review_count: 70, source: 'google' };
  assert.equal(samePlacePoi(a, b).same, true);
  const merged = mergeSamePlace(a, b, 42.0035575, 21.434606);
  assert.equal(merged.name, 'Амбасада на Турција', 'Macedonian name survives');
  assert.equal(merged.type, 'diplomatic', 'the better-ranked type survives');
  assert.equal(merged.place_id, '0x135415ae91924109:0x1605863f0c240a04', 'the place card is adopted');
  assert.equal(merged.rating, 4.4);
});

test('centre cross-check: a feed point 76m off loses to the map, and the row is queued', () => {
  // EB 94 for real: the feed carries a google_cached point 76m from the
  // building while the map resolves "Тоне Томшиќ 25" within 21m of it. The
  // rotation must run from the MAP's point (that is what turns L1 from the
  // bus stop 145m away into "Reptil Market br.3 Kisela Voda"), and the
  // property must be queued so the monthly drain repairs the feed itself.
  const mapPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'center-')), 'map.db');
  writeMap(mapPath, [], [
    { street: 'Тоне Томшиќ', housenumber: '25', lat: 41.9812985, lon: 21.4382176 },
  ]);
  const db = new Db(':memory:');
  const svc = new LandmarkService(db, { offlineMap: new OfflineMapStore(mapPath) });
  const row = {
    id: 94, eb: 94, address: 'ТОНЕ ТОМШИЌ БР.25',
    lat: 41.9811, lon: 21.4376, geo_source: 'google_cached',
  } as PropertyRow & { id: number };

  const center = resolveSearchCenter(row);
  assert.equal(center.source, 'map', 'the map wins when the feed is >50m off');
  assert.equal(center.lat, 41.9812985);
  assert.ok((center.mismatchM ?? 0) > 50, `mismatch must be measured: ${center.mismatchM}`);

  svc.nearbyLandmarks(row);
  const q = db.db.prepare(
    `SELECT reason FROM geo_reresolve_queue WHERE property_id = 94`
  ).get() as { reason: string } | undefined;
  assert.equal(q?.reason, 'center_mismatch', 'the feed repair is queued');
  svc.offlineMap!.close();
  db.close();
});

test('centre cross-check: agreement (<50m) keeps the feed point and queues NOTHING', () => {
  const mapPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'center-ok-')), 'map.db');
  writeMap(mapPath, [], [
    { street: 'Тоне Томшиќ', housenumber: '25', lat: 41.9812985, lon: 21.4382176 },
  ]);
  const db = new Db(':memory:');
  const svc = new LandmarkService(db, { offlineMap: new OfflineMapStore(mapPath) });
  const row = {
    id: 95, eb: 95, address: 'ТОНЕ ТОМШИЌ БР.25',
    lat: 41.98131, lon: 21.43825, geo_source: 'google_cached',
  } as PropertyRow & { id: number };
  const center = resolveSearchCenter(row);
  assert.equal(center.source, 'stored');
  svc.nearbyLandmarks(row);
  // The empty mini-map legitimately queues 'no_landmark' (there is nothing to
  // serve) — what must NOT happen is a CENTRE repair.
  const n = (db.db.prepare(
    `SELECT COUNT(*) c FROM geo_reresolve_queue WHERE reason = 'center_mismatch'`
  ).get() as { c: number }).c;
  assert.equal(center.source, 'stored');
  assert.equal(n, 0, 'no centre repair queued when the points agree');
  svc.offlineMap!.close();
  db.close();
});

test('AUDIT: no two rotation entries in the live map are the same place', () => {
  const db = path.join(process.cwd(), 'data', 'skopje-pois.db');
  if (!fs.existsSync(db)) {
    // The map DB is a build artifact (not tracked) — nothing to audit.
    return;
  }
  const store = new OfflineMapStore(db);
  assert.equal(store.available, true, `map must open: ${db}`);
  // Sample centres across the Skopje bbox: 0.01° ≈ 1.1km grid.
  const rows = [
    [41.9959869, 21.418169], // Embassy of Montenegro (the reported bug)
    [42.0035575, 21.434606], // Embassy of Republic of Turkey
    [41.9848371, 21.417664], // Embassy of the Czech Republic
    [41.9813795, 21.4384452], // EB 94 — Reptil Market / KANTAR BRIMA
    [41.9930, 21.4320], [41.9880, 21.4760], [42.0000, 21.4300],
    [41.9780, 21.4400], [42.0060, 21.4200], [41.9900, 21.4400],
  ];
  const offenders: string[] = [];
  for (const [lat, lon] of rows) {
    const pois = store.nearestPois(lat, lon, 500, 50) as MergedPoi[];
    for (let i = 0; i < pois.length; i++) {
      for (let j = i + 1; j < pois.length; j++) {
        if (samePlacePoi(pois[i], pois[j]).same) {
          offenders.push(`${lat},${lon}: "${pois[i].name}" ≡ "${pois[j].name}"`);
        }
      }
    }
  }
  store.close();
  assert.deepEqual(offenders, [], `same place took two rotation slots:\n  ${offenders.join('\n  ')}`);
});
