import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  translitToLatin, normName, semanticNameKey, nameMergeKeys,
} from '../src/geo/offlineMap';

// THE BILINGUAL MERGE CONTRACT:
//   Script differences (Cyrillic/Latin) → normName/translit bridges.
//   Translation differences (Амбасада на Црна Гора ↔ Embassy of Montenegro)
//   → semanticNameKey bridges. Name VARIANTS (Kipper vs Kipper Market - Butel)
//   are different branches and must NEVER share a semantic key.

test('semantic lexicon: the embassy pair merges across languages', () => {
  const mk = nameMergeKeys('Амбасада на Црна Гора');
  const en = nameMergeKeys('Embassy of Montenegro');
  // At least one key must collide — that's the merge signal.
  const shared = mk.filter(k => en.includes(k));
  assert.ok(shared.length > 0, `no shared key between ${JSON.stringify(mk)} and ${JSON.stringify(en)}`);
});

test('semantic keys are case/punctuation tolerant', () => {
  assert.equal(
    semanticNameKey('Embassy of Montenegro'),
    semanticNameKey('  embassy   of montenegro '),
  );
});

test('semantic key for the Cyrillic embassy is substantial (not a bare "embassy")', () => {
  // The ≥8-char guard must hold so bare institution words can't merge everything.
  const sem = semanticNameKey('Амбасада на Црна Гора');
  assert.ok(sem.includes('embassy'), `missing institution word: ${sem}`);
  assert.ok(sem.length >= 8, `semantic key too short: '${sem}'`);
});

test('name variants do NOT share semantic keys (no over-merge)', () => {
  const a = nameMergeKeys('Kipper');
  const b = nameMergeKeys('Kipper Market - Butel');
  assert.equal(a[0], 'kipper');
  assert.equal(b[0], 'kippermarketbutel');
  for (const k of a) assert.ok(!b.includes(k), `variant key '${k}' must not match across branches`);
});

test('brands not in the lexicon pass through untouched', () => {
  // Ordinary brand names must never be mangled by the lexicon.
  assert.equal(semanticNameKey('Тинекс Центар'), semanticNameKey('Tineks Centar'));
});

test('transliteration regression: Еурофарм == Eurofarm', () => {
  assert.equal(normName('Еурофарм'), 'eurofarm');
  assert.equal(translitToLatin('Ќ'), 'kj');
  assert.equal(translitToLatin('Џ'), 'dzh');
  assert.equal(translitToLatin('Љ'), 'lj');
});
