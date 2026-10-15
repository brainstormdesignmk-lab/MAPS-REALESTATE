// THE PRE-FLIGHT GATE — the one decision that stands between a November run
// and a billed, half-finished pass. These tests pin the rule that the October
// run broke: the plan is measured against the account's LIVE balance, and a
// balance that could not be read never silently reads as "you are fine".
//
// 2026-10-15, real numbers: 8 keys on disk (nominal ceiling 2,000), **13**
// searches actually left, plan 510 pairs. The old gate said GO and the run
// exited 0 with 510 pairs open. `decideSpendGate` must say NO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideSpendGate, SEARCHES_PER_KEY } from '../src/geo/spendGate';

const base = {
  estimatedSearches: 510,
  liveRemaining: 2000,
  probeOk: true,
  keysOnDisk: 8,
  budgetFloor: 20,
};

test('GO when the live balance covers the pass', () => {
  const v = decideSpendGate(base);
  assert.equal(v.go, true);
  assert.equal(v.basis, 'live');
  assert.equal(v.budget, 2000);
  assert.ok(v.lines.some(l => l.includes('2000 search(es) left')));
  assert.ok(v.lines.some(l => l.includes('✓')), v.lines.join('\n'));
});

test('REFUSE when the live balance cannot buy the pass — the 2026-10-15 case', () => {
  const v = decideSpendGate({ ...base, liveRemaining: 13 });
  assert.equal(v.go, false, 'a pass that cannot fit the account must not start');
  assert.equal(v.basis, 'live');
  assert.equal(v.budget, 13);
  const text = v.lines.join('\n');
  assert.ok(text.includes('needs 510'), text);
  assert.ok(text.includes('13'), text);
  assert.ok(/Re-key first/.test(text), text);
});

test('boundary: exactly enough is enough', () => {
  assert.equal(decideSpendGate({ ...base, estimatedSearches: 2000 }).go, true);
  assert.equal(decideSpendGate({ ...base, estimatedSearches: 2001 }).go, false);
});

test('a failed probe falls back to nominal — and says the budget is UNVERIFIED', () => {
  const v = decideSpendGate({ ...base, probeOk: false, liveRemaining: 0 });
  // The probe failure itself must not block a pass the keys can nominally buy…
  assert.equal(v.go, true);
  assert.equal(v.basis, 'nominal');
  assert.equal(v.budget, 8 * SEARCHES_PER_KEY);
  // …but it must never look like a verified balance.
  assert.ok(v.lines.some(l => /UNVERIFIED/.test(l)), v.lines.join('\n'));
});

test('a failed probe still refuses a pass the keys cannot nominally buy', () => {
  const v = decideSpendGate({ ...base, probeOk: false, estimatedSearches: 99_999 });
  assert.equal(v.go, false);
  assert.equal(v.basis, 'nominal');
});

test('--limit sizes a deliberate partial pass: never blocked', () => {
  const v = decideSpendGate({ ...base, liveRemaining: 13, limit: 13 });
  assert.equal(v.go, true);
  assert.ok(v.lines.some(l => l.includes('--limit caps this run at 13')));
});

test('the verdict always reports the floor the run will hard-stop at', () => {
  for (const liveRemaining of [0, 13, 2000]) {
    const v = decideSpendGate({ ...base, liveRemaining });
    assert.ok(v.lines.some(l => l.includes('floor per run: 20')), v.lines.join('\n'));
  }
});

test('an empty account (0 left, probe OK) refuses instead of spending nothing silently', () => {
  const v = decideSpendGate({ ...base, liveRemaining: 0 });
  assert.equal(v.go, false);
  assert.equal(v.basis, 'live');
});
