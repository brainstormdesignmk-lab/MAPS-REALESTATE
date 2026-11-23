// THE SOUND TIER — one place written in two scripts/spellings.
//
// «Сити Мол» / «Skopje City Mall» / «Маркет Рамстор» / «Market Ramstore» are one
// place each, and the map held them as two: `samePlaceName` folded script but
// compared SPELLING as characters, so «Рамстор» and «Ramstore» were different
// words. The EB 48 feed roster stored the mall twice and a client could be shown
// the same building as two different landmarks.
//
// The tier is a LANGUAGE rule, never a distance rule: it compares the map's own
// sound skeleton (`canonicalWordKey`, the fold the name lookup binds with) and
// demands an exact one-to-one token agreement within IDENTITY_SOUND_RADIUS. A
// pharmacy and the shop next door, two branches of a chain, a mall and the
// supermarket inside it, or two rows Google identified differently must stay
// apart however close they stand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  samePlaceName, samePlacePoi, identityTokens,
  IDENTITY_SOUND_RADIUS, IDENTITY_SUBSET_RADIUS,
} from '../src/geo/offlineMap';
import type { MergedPoi } from '../src/geo/offlineMap';

const poi = (name: string, lat: number, lon: number, place_id?: string): MergedPoi =>
  ({ name, type: 'mall', lat, lon, dist: 0, ...(place_id ? { place_id } : {}) });

test('sound tier: one name in two spellings is ONE place', () => {
  // The two NAMES are the map's own rows (map build 2026-11-23); the 12 m
  // separation is a fixture — the map's own pair of these rows stands 50 m
  // apart, which the radius deliberately refuses (see the last test): a
  // spelling bridges one building, never a street.
  const a = poi('Маркет Рамстор', 41.991852, 21.427277);
  const b = poi('Market Ramstore', 41.991872, 21.42728, '0x135414354df1b011:0x4c9fca7878c35ab6');
  const g = samePlacePoi(a, b);
  assert.equal(g.same, true, 'a transposed spelling is the same word');
  assert.equal(g.tier, 'sound');
});

test('sound tier: the city name carries no identity, so the mall binds', () => {
  // «Сити Мол» / «Skopje City Mall» — 44 m apart, one Google identity. The city
  // word is dropped (IDENTITY_NOISE), so both sides reduce to ONE token and the
  // sound tier can compare them at all.
  const a = poi('Сити Мол', 42.0045992, 21.3918525);
  const b = poi('Skopje City Mall', 42.0042193, 21.3917118, '0x1354146e17dd809b:0x7741a9cfe3c98a55');
  // The cached token array is frozen, so it is copied before sorting.
  assert.deepEqual([...identityTokens('Skopje City Mall')].sort(), ['city']);
  const g = samePlacePoi(a, b);
  assert.equal(g.same, true, 'Сити = City, and Skopje is the city, not the place');
  assert.equal(g.tier, 'sound');
});

test('sound tier: the city name never makes two places one', () => {
  // The bus terminals keep their own token — «Скопје» alone is not an identity.
  const north = samePlaceName('Скопје Север', 'Скопје Југ', 30);
  assert.equal(north.same, false);
  assert.equal(samePlaceName('Аеродром Скопје', 'Скопје Север', 30).same, false);
});

test('sound tier: proximity is NOT evidence — a neighbour keeps its own slot', () => {
  // Two pharmacies 13 m apart in one building (real rows): different names.
  assert.equal(samePlaceName('Аптека Артемизија', 'Аптека Betty', 13).same, false);
  // A supermarket beside the mall (real rows, 47 m): «Ramstore» is a shop, not
  // the mall's other spelling — no shared sound beyond the city word.
  assert.equal(samePlaceName('Сити Мол', 'Ramstore', 20).same, false);
});

test('sound tier: a branch number or a neighbourhood is never folded away', () => {
  // The branch protection the token tier already had: «Веро 9» ≠ «Веро 7».
  assert.equal(samePlaceName('Веро 9', 'Vero 7', 10).same, false);
  // «Kipper Market - Butel» is a different shop from «Kipper» — the sound tier
  // must not be a way around the branch rule.
  assert.equal(samePlaceName('Kipper', 'Kipper Market - Butel', 20).same, false);
});

test('sound tier: a house number is never folded into its neighbour', () => {
  // The skeleton drops vowels, so «15а» folded to «15» and two different
  // buildings 5 m apart became one (real rows: Варшавска 15 / 15а). Digits
  // compare verbatim in the sound tier.
  assert.equal(samePlaceName('Варшавска 15', 'Варшавска 15а', 5).same, false);
  assert.equal(samePlaceName('Варшавска 15', 'Варшавска 15', 5).same, true);
});

test('large-footprint types are one place across their own ground', () => {
  // The EB 48 mall, real nodes: 36 m and 50 m apart, all identified.
  const a = poi('Ramstore - City Mall / Рамстор - Сити Мол', 42.0043611, 21.3913233, '0x1:0x1');
  const b = poi('Тц Сити Мол', 42.0039188, 21.3914485, '0x2:0x2');
  assert.equal(samePlacePoi(a, b).same, true, 'one mall, two of ITS OWN nodes');
  // A TENANT IS NOT SCALED IN: a pharmacy 50 m away inside the same mall keeps
  // its own identity — only a pair of large-footprint rows is scaled.
  const pharmacy = { name: 'Зегин Аптека СитиМол', type: 'pharmacy', lat: 42.0045464, lon: 21.3911849, dist: 0 };
  assert.equal(samePlacePoi(a, pharmacy).same, false);
  // …and neither is a small shop matched against a mall of the same name.
  const kiosk = { name: 'Тц Сити Мол', type: 'convenience', lat: 42.0039188, lon: 21.3914485, dist: 0 };
  assert.equal(samePlacePoi(a, kiosk).same, false, 'a 50 m shop is not the mall');
});

test('sound tier: two Google cards for one building are still one building', () => {
  // The real EB 48 pair: BOTH rows carry a Google identity (Google keeps a
  // duplicate card for the mall) and the names are the same word in two
  // scripts, 44 m apart. Nothing tells these two buildings apart, so they are
  // one — the roster may not list the mall twice.
  const a = poi('Сити Мол', 42.0045992, 21.3918525, '0xaaaa:0x1');
  const b = poi('Skopje City Mall', 42.0042193, 21.3917118, '0xbbbb:0x2');
  assert.equal(samePlacePoi(a, b).same, true);
  // A DIFFERENT name with two identities is still two places: the fold only
  // ever merges what sounds like the same name.
  assert.equal(samePlacePoi(a, poi('Ramstore', 42.0048803, 21.3922837, '0xcccc:0x3')).same, false);
});

test('sound tier: the radius is short and the qualifier still gates it', () => {
  const far = IDENTITY_SOUND_RADIUS + 20;
  assert.equal(samePlaceName('Сити Мол', 'City Mall', far).same, false);
  assert.equal(samePlaceName('Сити Мол', 'City Mall', IDENTITY_SOUND_RADIUS - 5).same, true);
  // A residence/consular section is a DIFFERENT building, whatever the script.
  assert.equal(
    samePlaceName('Амбасада на Франција', 'French Embassy Residence', 20).same,
    false,
    'the qualifier gate applies to the sound tier too',
  );
});

test('sound tier: containment still needs the identity evidence', () => {
  // The subset-by-sound case («Сити Мол» ⊂ «Ramstore - City Mall») keeps the
  // guard: AT LEAST ONE side must carry Google's identity (the EB 48 pair has
  // two, because Google duplicated the mall card), the smaller name needs a
  // distinctive word, and no digit may appear only on the larger side.
  const d = IDENTITY_SUBSET_RADIUS - 5;
  assert.equal(samePlaceName('Сити Мол', 'Ramstore - City Mall', d, false, true).same, true);
  assert.equal(samePlaceName('Рамстор - Сити Мол', 'Тц Сити Мол', d, true, true).same, true,
    'two Google cards for one mall are one mall');
  assert.equal(samePlaceName('Сити Мол', 'Ramstore - City Mall', d, false, false).same, false,
    'no identity side = no evidence that these are one place');
  assert.equal(samePlaceName('Сити Мол 2', 'Ramstore - City Mall', d, false, true).same, false,
    'a branch number is identity, not spelling');
});
