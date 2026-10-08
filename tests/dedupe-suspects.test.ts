// THE CONSERVATIVE MERGE, PINNED. The suspect-pairs report flags 97 pairs that
// MIGHT be one place under two identities. Blindly deleting all of them would
// destroy real landmarks (a mall vs a store inside it, a bank vs its ATM, two
// branches of a chain). These tests lock the rule: merge only genuine
// duplicates, backfill fields so nothing is lost, and leave the ambiguous
// pairs untouched with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSuspects, decideMerge, pickSurvivor, mergeRowFields, mergeComponents,
  coreName, type PoiRow, type SuspectPair,
} from '../src/geo/dedupeSuspects';

function row(p: Partial<PoiRow> & { rowid: number; name: string; lat: number; lon: number }): PoiRow {
  return { type: 'place', source: 'osm', place_id: null, phone: null, review_count: null, ...p };
}

test('coreName strips descriptor words but keeps brand tokens', () => {
  assert.equal(coreName('NLB Banka ATM'), 'nlb');
  assert.equal(coreName('NLB Bank'), 'nlb');
  assert.equal(coreName('Stopanska Banka AD Skopje'), 'stopanska');
  assert.equal(coreName('FABUspot Skopje City Mall'), 'fabuspot');
  assert.equal(coreName('Skopje City Mall'), '');
});

test('same-name-drifted merges within 100m, leaves farther pairs for review', () => {
  const near = decideMerge({
    kind: 'same-name-drifted', distanceM: 60,
    a: row({ rowid: 1, name: 'Скупи', lat: 42.0, lon: 21.4 }),
    b: row({ rowid: 2, name: 'Скупи', lat: 42.0005, lon: 21.4 }),
    evidence: '60m',
  });
  assert.equal(near.merge, true);

  const far = decideMerge({
    kind: 'same-name-drifted', distanceM: 195,
    a: row({ rowid: 3, name: 'Паркинг Зона Ц', lat: 42.0, lon: 21.4 }),
    b: row({ rowid: 4, name: 'Паркинг Зона Ц', lat: 42.0018, lon: 21.4 }),
    evidence: '195m',
  });
  assert.equal(far.merge, false, 'two same-named branches are not merged');
  assert.match(far.reason, /branches/);
});

test('dual-identified-near merges only when cores agree (bank vs its ATM), not a mall vs a store', () => {
  const bank = decideMerge({
    kind: 'dual-identified-near', distanceM: 6,
    a: row({ rowid: 1, name: 'NLB Bank', lat: 42.0, lon: 21.4, place_id: '0x1:0x1', review_count: 40 }),
    b: row({ rowid: 2, name: 'NLB Banka ATM', lat: 42.0001, lon: 21.4, place_id: '0x1:0x2' }),
    evidence: '6m',
  });
  assert.equal(bank.merge, true, 'bank + its ATM are one place');
  assert.equal(bank.survivor.name, 'NLB Bank', 'the branch, not the ATM, survives');

  // THE MALL/COMPLEX RULE: the container is the anchor; the shop inside it is
  // not relevant for serving, so it collapses onto the mall even with fewer
  // reviews than the survivor-pick would otherwise choose.
  const mall = decideMerge({
    kind: 'dual-identified-near', distanceM: 22,
    a: row({ rowid: 3, name: 'Skopje City Mall', lat: 42.0, lon: 21.4, place_id: '0x2:0x1', review_count: 10327 }),
    b: row({ rowid: 4, name: 'FABUspot Skopje City Mall', lat: 42.0002, lon: 21.4, place_id: '0x2:0x2', review_count: 329 }),
    evidence: '22m',
  });
  assert.equal(mall.merge, true, 'a shop inside a mall is not a separate anchor');
  assert.equal(mall.survivor.name, 'Skopje City Mall', 'the mall wins, not the interior shop');
  assert.match(mall.reason, /inside/);
});

test('the mall anchor wins even when the interior shop has more reviews', () => {
  const d = decideMerge({
    kind: 'dual-identified-near', distanceM: 20,
    a: row({ rowid: 1, name: 'Трговски Центар Буњаковец', lat: 42.0, lon: 21.4 }),
    b: row({ rowid: 2, name: 'Cafe Inside Трговски Центар Буњаковец', lat: 42.0002, lon: 21.4, review_count: 9999 }),
    evidence: '20m',
  });
  assert.equal(d.merge, true);
  assert.equal(d.survivor.name, 'Трговски Центар Буњаковец');
});

test('same-phone is always a merge (identity evidence)', () => {
  const d = decideMerge({
    kind: 'same-phone', distanceM: 108,
    a: row({ rowid: 1, name: 'Resort & Spa „Bushi“', lat: 42.0, lon: 21.4, phone: '+389 2 312 5130', review_count: 1713 }),
    b: row({ rowid: 2, name: 'Bushi hotel', lat: 42.001, lon: 21.4, phone: '+389 2 312 5130' }),
    evidence: 'phone',
  });
  assert.equal(d.merge, true);
  assert.equal(d.survivor.name, 'Resort & Spa „Bushi“', 'richer reviews win');
});

test('mergeRowFields donates capture data so nothing is lost', () => {
  const survivor = row({ rowid: 1, name: 'NLB Banka', lat: 42.0, lon: 21.4, review_count: 0 });
  const dropped = row({
    rowid: 2, name: 'NLB Banka ATM', lat: 42.0, lon: 21.4,
    phone: '+389 2 123', place_id: '0x9:0x9', review_count: 7,
    // rating/website only exist as extra fields at runtime
  });
  (dropped as Record<string, unknown>).rating = 4.5;
  const fields = mergeRowFields(survivor, dropped);
  assert.equal(fields.phone, '+389 2 123');
  assert.equal(fields.place_id, '0x9:0x9');
  assert.equal(fields.review_count, 7);
  assert.equal(fields.rating, 4.5);
  // A survivor that already has data is not overwritten.
  const rich = row({ rowid: 3, name: 'X', lat: 42.0, lon: 21.4, phone: '+389 2 999' });
  assert.equal(mergeRowFields(rich, dropped).phone, undefined);
});

test('mergeComponents unions chains and returns one survivor per component', () => {
  const a = row({ rowid: 1, name: 'NLB Banka', lat: 42.0, lon: 21.4, review_count: 32 });
  const b = row({ rowid: 2, name: 'NLB Banka ATM', lat: 42.0001, lon: 21.4 });
  const c = row({ rowid: 3, name: 'NLB Banka ATM', lat: 42.0002, lon: 21.4 });
  const pairs: SuspectPair[] = [
    { kind: 'dual-identified-near', a, b, distanceM: 14, evidence: '' },
    { kind: 'dual-identified-near', a, b: c, distanceM: 18, evidence: '' },
  ];
  const comps = mergeComponents(pairs);
  assert.equal(comps.length, 1);
  assert.equal(comps[0].survivor.rowid, 1);
  assert.deepEqual(comps[0].dropped.map(d => d.rowid).sort(), [2, 3]);
});

test('detectSuspects finds a same-name-drifted pair in real coordinates', () => {
  const rows = [
    row({ rowid: 1, name: 'Скупи', lat: 41.9995, lon: 21.4315 }),
    row({ rowid: 2, name: 'Скупи', lat: 42.0003, lon: 21.4315 }), // ~89m north
    row({ rowid: 3, name: 'Веро', lat: 41.995, lon: 21.425 }),
  ];
  const s = detectSuspects(rows);
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, 'same-name-drifted');
  assert.ok(s[0].distanceM > 50);
});
