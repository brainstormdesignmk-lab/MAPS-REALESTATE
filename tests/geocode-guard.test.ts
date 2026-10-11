// THE WRITE-SIDE TRUST GUARD — spec against the REAL keyed-probe payloads.
//
// Every case below is a SerpApi answer captured on 2026-10-11 with a keyed
// probe (5 searches, engine=google_maps&type=search — the exact request the
// write side sends). They are the ground truth for "what does Google answer
// when we ask it to geocode a feed address": it answers with PLACES matching
// the query TEXT, not with a geocode of the address. The guard's job is to
// separate the answers that mean "this is your address" from the ones that
// mean "I don't know this, here is the city" or "here is a different place
// that shares words with what you typed".
//
//   "АСНОМ 156, Skopje"      → "Skopje" / "North Macedonia" (the CITY — 4.58 km
//                              from the building, and that earned google_cached)
//   "ХФГХФГХ, Skopje"        → place_results "Greater Skopje" / "North Macedonia"
//   "ТЦ ОЛИМПИКО, Skopje"    → "Tire Shop Olimpiko" / "Boulevard 8-mi Septemvri
//                              no. 38" — a tire shop 2.2 km from the mall
//   "БИСЕР, Skopje"          → "Pharmacy Biser" / "Jane Sandanski 82" — 44 m
//                              from the Biser POI. THE GOOD CASE.
//   "Владимир Назор бр.26-2" → "Central Loft Skopje" / "Vladimir Nazor 8" —
//                              right street, wrong number
//
// Pure: no DB and no network. The two map cross-checks are injected, so the
// spec pins each rule in isolation (the real-map validation runs separately
// against data/skopje-pois.db).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessGeocode,
  extractGeocodeEvidence,
  queryTokens,
  isAreaLine,
  sanitizeQuery,
  GUARD_MAX_DIST_M,
  type GuardMapChecks,
} from '../src/geo/geocodeGuard';

/** Map with no opinion — most rules only need the response itself. */
const NO_MAP: GuardMapChecks = {};

test('guard 0: outside the Skopje bbox is never trusted', () => {
  const v = assessGeocode('БИСЕР', { lat: 42.10, lon: 21.60, title: 'TC Biser', address: 'Jane Sandanski 82, Skopje' });
  assert.equal(v.trusted, false);
  assert.equal(v.reason, 'outside_bbox');
});

test('guard 0: a null answer and a wordless answer are both no_evidence', () => {
  assert.equal(assessGeocode('БИСЕР', null).reason, 'no_evidence');
  const bare = assessGeocode('БИСЕР', { lat: 41.99, lon: 21.43 });
  assert.equal(bare.trusted, false, 'coordinates alone were the old bbox-only hole');
  assert.equal(bare.reason, 'no_evidence');
});

test('guard 1: EB 73 shape — the city centre is rejected, not stamped google_cached', () => {
  // Captured: title "Skopje", address "North Macedonia", gps 41.9981, 21.4254.
  const v = assessGeocode('АСНОМ 156, Skopje', {
    lat: 41.998129399999996, lon: 21.4254355,
    title: 'Skopje', address: 'North Macedonia',
  }, {
    // The map knows АСНОМ: its rows sit 3001 m from the city-centre point.
    streetDistanceM: () => 3001,
    poiDistanceM: () => null,
  });
  assert.equal(v.trusted, false);
  assert.equal(v.reason, 'area_level_result');
  assert.equal(v.exactBuilding, false, 'never a building claim');
});

test('guard 1: the garbage-query shape (place_results → Greater Skopje) is rejected', () => {
  // Captured payload shape for "ХФГХФГХ, Skopje": no local_results, a single
  // place_results knowledge panel for the REGION.
  const payload = {
    search_metadata: { status: 'Success' },
    place_results: {
      title: 'Greater Skopje',
      address: 'North Macedonia',
      gps_coordinates: { latitude: 42.0, longitude: 21.4333 },
    },
  };
  const ev = extractGeocodeEvidence(payload);
  assert.ok(ev, 'the panel does carry coordinates');
  const v = assessGeocode('ХФГХФГХ, Скопје', ev!, NO_MAP);
  assert.equal(v.trusted, false);
  assert.equal(v.reason, 'area_level_result');
});

test('guard 2: a real place that is NOT what we asked about is rejected', () => {
  const v = assessGeocode('Рептил маркет Кисела Вода', {
    lat: 41.9814, lon: 21.4384,
    title: 'Park', address: 'Jane Sandanski 5, Skopje 1000, North Macedonia',
  }, NO_MAP);
  assert.equal(v.trusted, false);
  assert.equal(v.reason, 'query_mismatch');
});

test('guard 2: map cross-checks are never consulted once the words already fail', () => {
  let consulted = 0;
  const map: GuardMapChecks = {
    streetDistanceM: () => { consulted++; return 3000; },
    poiDistanceM: () => { consulted++; return 3000; },
  };
  const v = assessGeocode('Рептил маркет', { lat: 41.99, lon: 21.43, title: 'Park', address: 'Skopje 1000, North Macedonia' }, map);
  assert.equal(v.trusted, false);
  assert.equal(consulted, 0, 'cheap checks run first');
});

test('guard 3: АСНОМ 156 answered with a real Asnom place but 3 km off is still rejected', () => {
  // Same rule as EB 73 but reached with agreeing words: the map's own street
  // rows are the arbiter — the pin must sit ON the street we know.
  const v = assessGeocode('АСНОМ 156, Skopje', {
    lat: 41.998129399999996, lon: 21.4254355,
    title: 'Boulevard Asnom', address: 'Boulevard Asnom, Skopje 1000, North Macedonia',
  }, {
    streetDistanceM: () => 3001,
    poiDistanceM: () => null,
  });
  assert.equal(v.trusted, false);
  assert.equal(v.reason, 'street_disagreement');
});

test('guard 4: TC Olimpiko answered with the tire shop 2.2 km away is rejected', () => {
  // Captured: title "Tire Shop Olimpiko", address "Boulevard 8-mi Septemvri
  // no. 38, Skopje". The words agree ("Olimpiko"), the map's POI table knows
  // where "T.C Olimpiko" really is — 2.2 km away.
  const v = assessGeocode('ТЦ ОЛИМПИКО, Скопје', {
    lat: 42.0137502, lon: 21.4081237,
    title: 'Tire Shop Olimpiko', address: 'Boulevard 8-mi Septemvri no. 38, Skopje 1000, North Macedonia',
  }, {
    streetDistanceM: () => null,      // street unknown / poison anchor removed
    poiDistanceM: () => 2200,
  });
  assert.equal(v.trusted, false);
  assert.equal(v.reason, 'poi_disagreement');
  assert.ok(GUARD_MAX_DIST_M < 2200);
});

test('guard OK: the БИСЕР answer (44 m from the map POI) is trusted, street level', () => {
  const v = assessGeocode('БИСЕР, Skopje', {
    lat: 41.9848406, lon: 21.4660392,
    title: 'Pharmacy Biser', address: 'Jane Sandanski 82, Skopje 1000, North Macedonia',
  }, {
    streetDistanceM: () => null,      // "БИСЕР" is not a street the map knows
    poiDistanceM: () => 44,          // Biser Shopping Center
  });
  assert.equal(v.trusted, true);
  assert.equal(v.reason, 'ok');
  assert.equal(v.exactBuilding, false, 'no house number in the query → street-level lesson');
});

test('guard OK: Mirce Orovchanec 86 — English spelling bridged, exact building', () => {
  // The write side queries the CYRILLIC feed address; Google answers with the
  // English transliteration ("ч" → "ch"). Only the second fold connects them —
  // and because the answer repeats the house number, this is building evidence.
  const v = assessGeocode('Мирче Оровчанец 86, Скопје', {
    lat: 41.999, lon: 21.4138,
    title: 'Mirce Orovchanec 86', address: 'Mirce Orovchanec 86, Skopje 1000, North Macedonia',
  }, NO_MAP);
  assert.equal(v.trusted, true);
  assert.equal(v.exactBuilding, true, 'Google repeated the number we asked for');
});

test('guard OK but street level: Vladimir Nazor asked for 26-2, answered with 8', () => {
  const v = assessGeocode('Владимир Назор бр.26-2, Скопје', {
    lat: 41.9903294, lon: 21.4194784,
    title: 'Central Loft Skopje', address: 'Vladimir Nazor 8, Skopje 1000, North Macedonia',
  }, {
    streetDistanceM: () => 118,       // the map's Vladimir Nazor rows
    poiDistanceM: () => null,
  });
  assert.equal(v.trusted, true, 'the street IS verified');
  assert.equal(v.exactBuilding, false, 'but number 8 is not the door that was asked for');
});

test('guard 1 exception: a street-typed answer with a city-only address still counts', () => {
  // Street-teach sends "<street>, Скопје, Северна Македонија" and Google often
  // answers with the street as a place whose address is just the city. The
  // TITLE carries the agreement, so the area line alone must not kill it —
  // otherwise the whole learn-the-street loop dies.
  const v = assessGeocode('Нова Непозната 12, Скопје, Северна Македонија', {
    lat: 41.9959, lon: 21.4311,
    title: 'Нова Непозната', address: 'Skopje, North Macedonia',
  }, NO_MAP);
  assert.equal(v.trusted, true);
  assert.equal(v.reason, 'ok');
  assert.equal(v.exactBuilding, false, 'no number in the answer → learn a street anchor, not a door');
});

test('sanitizeQuery: the appended city/country suffix is dropped, the street kept', () => {
  assert.equal(sanitizeQuery('АСНОМ 156, Skopje'), 'АСНОМ 156');
  assert.equal(sanitizeQuery('Нова Непозната, Скопје, Северна Македонија'), 'Нова Непозната');
  assert.equal(sanitizeQuery('БИСЕР'), 'БИСЕР');
  // A street that happens to be named like the city is only dropped as a
  // TRAILING segment — never when it is the thing being asked about.
  assert.equal(sanitizeQuery('Скопје'), 'Скопје');
});

test('queryTokens: the city/country suffix cannot make rule 2 agree', () => {
  // street-teach appends these to EVERY query — they must not be verifiable
  // tokens, or a garbage street name would "agree" with any Skopje answer.
  const toks = queryTokens('ХФГХФГХ, Скопје, Северна Македонија');
  assert.deepEqual(toks, ['hfghfgh']);
  assert.equal(queryTokens('Скопје').includes('skopje'), false);
});

test('isAreaLine: city and country lines, but never a street', () => {
  assert.equal(isAreaLine('North Macedonia'), true);
  assert.equal(isAreaLine('Skopje'), true);
  assert.equal(isAreaLine('Greater Skopje'), true);
  assert.equal(isAreaLine('Skopje 1000'), true);
  assert.equal(isAreaLine(''), true, 'no street evidence at all');
  assert.equal(isAreaLine('Vladimir Nazor 8'), false);
  assert.equal(isAreaLine('Boulevard 8-mi Septemvri no. 38'), false);
  assert.equal(isAreaLine('Мирче Оровчанец 86'), false);
});

test('extractGeocodeEvidence: local_results wins, place_results is the fallback, a miss is null', () => {
  const local = extractGeocodeEvidence({
    local_results: [{
      title: 'Pharmacy Biser', address: 'Jane Sandanski 82, Skopje',
      gps_coordinates: { latitude: 41.9848406, longitude: 21.4660392 },
    }],
  });
  assert.equal(local?.lat, 41.9848406);
  assert.equal(local?.title, 'Pharmacy Biser');

  assert.equal(extractGeocodeEvidence({ search_metadata: { status: 'Success' } }), null);
  assert.equal(extractGeocodeEvidence({ local_results: [{ title: 'no coords' }] }), null);
});
