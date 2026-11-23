// THE LEARNED-STREET WRITE GUARD.
//
// `learnStreet`/`learnAddress` plant rows the resolver later TRUSTS as a street
// that Google verified. Old runs fed them landmark-form feed addresses, so the
// map's "street" list carried «ШАМПИОНЧЕ КАК КИПЕР МАРКЕТ», «ЦРНОГОРСКА
// АМБАСАДА», «КАЈ СИТИ МОЛ ' РУСКИТЕ ЗГРАДИ», «оу Лазо Ангеловски» and a bare
// «Boulevard». `assessStreetKey` is the one predicate: the writer refuses such a
// name, and scripts/prune-street-keys.ts removes the rows that predate the gate.
//
// The rule is about WHAT KIND OF NAME it is — never about whether the point is
// real. A quarter («Буњаковец», «Козле», «Чаир») IS a legitimate Skopje address
// form («Буњаковец 5»), so those anchors stay and are tested as accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { assessStreetKey, OfflineMapStore, streetKey } from '../src/geo/offlineMap';

const verdict = (s: string) => assessStreetKey(s);

test('the guard refuses every landmark-form address found in the live map', () => {
  // Each of these was a real learned anchor before the gate (2026-11-23).
  assert.equal(verdict('ШАМПИОНЧЕ КАК КИПЕР МАРКЕТ').reason, 'landmark-opener');
  assert.equal(verdict('КАЈ БРАНКА').reason, 'landmark-opener');
  assert.equal(verdict("КАЈ СИТИ МОЛ ' РУСКИТЕ ЗГРАДИ").reason, 'landmark-opener');
  assert.equal(verdict('ЃОРЧЕ КАЈ ПАЗАРЧЕТО').reason, 'landmark-opener');
  assert.equal(verdict('ЦРНОГОРСКА АМБАСАДА').reason, 'institution-word');
  assert.equal(verdict('оу Лазо Ангеловски').reason, 'institution-word');
  // A generic street word with no name of its own is not a street either.
  assert.equal(verdict('Boulevard').reason, 'generic-word');
  for (const bad of ['ШАМПИОНЧЕ КАК КИПЕР МАРКЕТ', 'КАЈ БРАНКА', 'ЦРНОГОРСКА АМБАСАДА', 'Boulevard']) {
    assert.equal(verdict(bad).streetLike, false, bad);
  }
});

test('the guard accepts real streets — including the quarter-form address', () => {
  for (const good of [
    'Ѓуро Стругар', 'Ефтим Спространов', 'Роза Луксембург', 'Гјуро Гјоновиќ Маџар Маало',
    'Bulevar Kočo Racin', 'Vasil Ǵorgov', 'ПАЛОМА БЈАНКА',
    // Quarters are how half of Skopje gives an address; the anchor is what
    // resolves «Буњаковец 5» offline.
    'Буњаковец', 'БУЊАКОВЕЦ', 'Козле', 'ЧАИР', 'ВИЗБЕГОВО', 'РАМПА', 'БИСЕР',
  ]) {
    assert.equal(verdict(good).streetLike, true, `${good} must stay learnable`);
  }
  // The trailing house number is not part of the judgement.
  assert.equal(verdict('Владимир Полежиновски 23').streetLike, true);
});

test('the guard matches WHOLE words — a spelling that merely contains one passes', () => {
  // «црква» inside a street name, «пазар» inside «Пазарна», «до» inside
  // «Дојранска»: a substring rule would refuse real streets.
  assert.equal(verdict('Црногорска').streetLike, true);
  assert.equal(verdict('Пазарна').streetLike, true);
  assert.equal(verdict('Дојранска').streetLike, true);
  assert.equal(verdict('Маркова').streetLike, true);
  // …and the whole-word forms really are refused.
  assert.equal(verdict('Улица Црква').reason, 'institution-word');
  assert.equal(verdict('Бит Пазар').reason, 'institution-word');
});

test('the writer refuses what the guard refuses (learnStreet / learnAddress)', () => {
  // A COPY of the live map, so the test never mutates the artifact.
  const src = path.resolve(__dirname, '..', 'data', 'skopje-pois.db');
  const tmp = path.join(os.tmpdir(), `street-guard-${process.pid}.db`);
  fs.copyFileSync(src, tmp);
  const map = new OfflineMapStore(tmp);
  try {
    assert.equal(map.learnStreet('КАЈ БРАНКА', 41.999, 21.44), false,
      'a landmark phrase must never become a trusted anchor');
    assert.equal(map.learnAddress('ШАМПИОНЧЕ КАК КИПЕР МАРКЕТ 5', 42.023, 21.437), false);
    // A real street still learns, and lands where the resolver looks for it.
    assert.equal(map.learnStreet('Тестова Улица', 42.0, 21.44), true);
  } finally {
    map.close();
  }
  const ro = new Database(tmp, { readonly: true });
  const rows = ro.prepare("SELECT street FROM addresses WHERE key = ? AND source = 'google_street'").all(streetKey('Тестова Улица')) as Array<{ street: string }>;
  assert.equal(rows.length, 1, 'the accepted street was written');
  const refused = ro.prepare("SELECT COUNT(*) AS n FROM addresses WHERE key IN (?, ?) AND source = 'google_street'")
    .get(streetKey('КАЈ БРАНКА'), streetKey('ШАМПИОНЧЕ КАК КИПЕР МАРКЕТ')) as { n: number };
  assert.equal(refused.n, 0, 'no refused row reached the address layer');
  ro.close();
  fs.unlinkSync(tmp);
});

test('the live map carries no non-street learned anchor', () => {
  // The prune's contract, read from the artifact the engine ships: any row that
  // fails the guard is a lie the resolver would trust.
  const db = new Database(path.resolve(__dirname, '..', 'data', 'skopje-pois.db'), { readonly: true });
  const learned = db.prepare(
    "SELECT street FROM addresses WHERE source = 'google_street' GROUP BY key"
  ).all() as Array<{ street: string }>;
  db.close();
  const bad = learned.filter(l => !assessStreetKey(l.street).streetLike);
  assert.deepEqual(bad.map(b => b.street), [], 'run scripts/prune-street-keys.ts --apply');
});
