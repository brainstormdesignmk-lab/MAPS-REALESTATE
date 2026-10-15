// Canonical runtime DB / queue harvest — the fix for geo_reresolve_queue
// fragmentation (two checkouts × two cwd's = four queue copies, and Phase C
// only ever drained the one its cwd happened to open).
//
// [ ] resolveRuntimeDb: a RELATIVE DB_PATH resolves against the repo root,
//     NOT process.cwd() — same answer from any working directory
// [ ] resolveRuntimeDb: absolute wins verbatim; unset → repo default
// [ ] queueSourceFiles: finds sibling *.db copies, skips the canonical file
//     and non-.db/nonexistent roots
// [ ] harvestQueues: stray rows merge into canonical (existing property_id
//     keeps the canonical reason), stray copies are cleared, second run is a
//     no-op, files without the queue table / unreadable files are reported
//     instead of throwing

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from '../src/store/db';
import {
  REPO_ROOT,
  resolveRuntimeDb,
  resolveMapDb,
  queueSourceFiles,
  discoverQueueSources,
  atomSnapshotFiles,
  harvestQueues,
  toQueueTimestamp,
} from '../src/geo/runtimeDb';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-db-'));
}

function enqueue(db: Db, propertyId: number, reason: string, createdAt: number): void {
  db.db.prepare(
    `INSERT OR IGNORE INTO geo_reresolve_queue (property_id, reason, created_at) VALUES (?, ?, ?)`,
  ).run(propertyId, reason, createdAt);
}

function queueOf(db: Db): Array<{ property_id: number; reason: string; created_at: number }> {
  return db.db.prepare(
    `SELECT property_id, reason, created_at FROM geo_reresolve_queue ORDER BY property_id`,
  ).all() as any[];
}

// ── resolveRuntimeDb ─────────────────────────────────────────────────────────

test('resolveRuntimeDb: relative DB_PATH resolves against the repo, never the cwd', () => {
  const before = process.cwd();
  const elsewhere = tmp();
  try {
    process.chdir(elsewhere);
    const a = resolveRuntimeDb({ DB_PATH: 'data/lina.db' } as NodeJS.ProcessEnv);
    assert.equal(a.rule, 'repo-anchored');
    assert.ok(path.isAbsolute(a.file), 'resolution must be absolute');
    assert.equal(a.file, path.join(REPO_ROOT, 'data', 'lina.db'));
    // …and it must NOT have followed the working directory.
    assert.ok(!a.file.startsWith(elsewhere), 'must not resolve against cwd');
    assert.ok(!a.file.includes(path.join(elsewhere, '.')));
  } finally {
    process.chdir(before);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('resolveRuntimeDb: absolute DB_PATH is used verbatim, unset → repo default', () => {
  const abs = path.join(tmp(), 'custom.db');
  const a = resolveRuntimeDb({ DB_PATH: abs } as NodeJS.ProcessEnv);
  assert.equal(a.rule, 'absolute');
  assert.equal(a.file, path.normalize(abs));

  const b = resolveRuntimeDb({} as NodeJS.ProcessEnv);
  assert.equal(b.rule, 'default');
  assert.equal(b.file, path.join(REPO_ROOT, 'data', 'lina.db'));

  // Same object regardless of cwd (the whole point of the fix).
  const before = process.cwd();
  try {
    process.chdir(os.tmpdir());
    assert.equal(resolveRuntimeDb({} as NodeJS.ProcessEnv).file, b.file);
  } finally {
    process.chdir(before);
  }
});

// ── resolveMapDb (the same rule, for the artifact itself) ────────────────────

test('resolveMapDb: the MAP is cwd-independent too (relative anchors to the repo)', () => {
  const before = process.cwd();
  const elsewhere = tmp();
  try {
    process.chdir(elsewhere);
    const a = resolveMapDb({ SKOPJE_POIS_DB: 'data/skopje-pois.db' } as NodeJS.ProcessEnv);
    assert.equal(a.rule, 'repo-anchored');
    assert.equal(a.file, path.join(REPO_ROOT, 'data', 'skopje-pois.db'));
    assert.ok(!a.file.startsWith(elsewhere), 'must not resolve against cwd');

    const b = resolveMapDb({} as NodeJS.ProcessEnv);
    assert.equal(b.rule, 'default');
    assert.equal(b.file, path.join(REPO_ROOT, 'data', 'skopje-pois.db'));

    const abs = path.join(elsewhere, 'other-map.db');
    const c = resolveMapDb({ SKOPJE_POIS_DB: abs } as NodeJS.ProcessEnv);
    assert.equal(c.rule, 'absolute');
    assert.equal(c.file, path.normalize(abs));
  } finally {
    process.chdir(before);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

// ── the atom up-path: collected snapshots + the import ledger ───────────────
//
// An atom's queue row survives forever on the atom (nothing drains it there),
// so every `atoms:collect` re-pulls the SAME row. Without the ledger those
// re-imports would re-queue it, and any row the drain could not resolve would
// be re-geocoded on a paid key every single month.

test('atomSnapshotFiles: finds <root>/<atomId>/lina.db.copy and nothing else', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'atom01'));
  fs.mkdirSync(path.join(root, 'atom02'));
  const a1 = path.join(root, 'atom01', 'lina.db.copy');
  new Db(a1).close();
  fs.writeFileSync(path.join(root, 'atom01', 'enrichment-log.json'), '{}');
  fs.writeFileSync(path.join(root, 'atom02', 'collect-meta.json'), '{}');

  assert.deepEqual(atomSnapshotFiles([root]), [a1]);
  assert.deepEqual(atomSnapshotFiles([path.join(root, 'missing')]), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('discoverQueueSources: an atom snapshot is a source, and is marked keep-in-place', () => {
  const dir = tmp();
  const canonical = path.join(dir, 'lina.db');
  const stray = path.join(dir, 'stray.db');
  const snapshot = path.join(dir, 'snap.copy');
  new Db(canonical).close();
  fs.writeFileSync(stray, 'x');
  fs.writeFileSync(snapshot, 'x');

  const src = discoverQueueSources(canonical, { env: {}, roots: [dir], atomFiles: [snapshot] });
  const byFile = new Map(src.map(s => [s.file, s.clear]));
  assert.equal(byFile.get(stray), true, 'a live stray is cleared after the merge');
  assert.equal(byFile.get(snapshot), false, 'collected evidence is never mutated');
  assert.ok(!byFile.has(canonical), 'the canonical file is never a source');
  // Without explicit roots, the default discovery is used — proven by the
  // existence of the default call path (no throw, canonical excluded).
  assert.ok(!discoverQueueSources(canonical).some(s => s.file === canonical));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('harvestQueues: an atom snapshot is mirrored, never cleared, and never re-imported', () => {
  const dir = tmp();
  const canonical = path.join(dir, 'lina.db');
  const snapshot = path.join(dir, 'lina.db.copy');   // a collected atom DB
  new Db(canonical).close();
  const snap = new Db(snapshot);
  enqueue(snap, 74, 'low_confidence_center', 1_700_000_000_000);
  snap.close();

  const first = harvestQueues(canonical, { env: {}, roots: [], atomFiles: [snapshot] });
  assert.equal(first.merged, 1, 'the atom row reaches the canonical queue');
  assert.equal(first.cleared, 0, 'a collected snapshot is not a live stray');
  assert.equal(first.kept, 1);
  assert.deepEqual(first.skipped, []);
  const snapAfter = new Db(snapshot);
  assert.equal(queueOf(snapAfter).length, 1, 'the evidence is left in place');
  snapAfter.close();

  // Phase C drains it…
  const canonicalDb = new Db(canonical);
  assert.deepEqual(queueOf(canonicalDb).map(r => r.property_id), [74]);
  canonicalDb.db.prepare('DELETE FROM geo_reresolve_queue WHERE property_id = 74').run();
  canonicalDb.close();

  // …and the NEXT month re-collects the very same, unchanged snapshot. It must
  // NOT come back (that would be a geocode bought twice for one queue event).
  const second = harvestQueues(canonical, { env: {}, roots: [], atomFiles: [snapshot] });
  assert.equal(second.merged, 0, 'the import ledger blocks a duplicate import');
  assert.equal(second.alreadyImported, 1);
  const finalDb = new Db(canonical);
  assert.deepEqual(queueOf(finalDb), [], 'the drained row is not re-queued');
  finalDb.close();

  // But a GENUINELY NEW queue event on the atom imports. Note the atom's own
  // writers use INSERT OR IGNORE against a property_id-keyed table, so its row
  // is immutable while it exists — a "new event" means it was dropped and
  // re-queued, which is exactly what this models (and why keying the ledger on
  // the event, not just the property, is the honest choice).
  const snap2 = new Db(snapshot);
  snap2.db.prepare(
    `UPDATE geo_reresolve_queue SET reason = ?, created_at = ? WHERE property_id = ?`,
  ).run('center_mismatch', 1_800_000_000_000, 74);
  snap2.close();
  const third = harvestQueues(canonical, { env: {}, roots: [], atomFiles: [snapshot] });
  assert.equal(third.merged, 1, 'a new event on the same file is a new fact');
  const check = new Db(canonical);
  assert.equal(queueOf(check)[0].reason, 'center_mismatch');
  check.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── queueSourceFiles ─────────────────────────────────────────────────────────

test('queueSourceFiles: finds sibling copies, skips canonical and non-db roots', () => {
  const dir = tmp();
  const canonical = path.join(dir, 'lina.db');
  new Db(canonical).close();
  fs.writeFileSync(path.join(dir, 'stray.db'), 'x');
  fs.writeFileSync(path.join(dir, 'not-a-db.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'nested'));

  const files = queueSourceFiles(canonical, { env: {}, roots: [dir] });
  assert.deepEqual(files, [path.join(dir, 'stray.db')],
    'only the stray .db sibling, canonical excluded, non-db files ignored');

  // Nonexistent roots are ignored rather than throwing.
  assert.deepEqual(
    queueSourceFiles(canonical, { env: {}, roots: [path.join(dir, 'missing')] }),
    [],
  );

  // LINA_QUEUE_SOURCES adds explicit files on top of the roots.
  const explicit = path.join(dir, 'elsewhere.db');
  fs.writeFileSync(explicit, 'x');
  const withEnv = queueSourceFiles(canonical, {
    env: { LINA_QUEUE_SOURCES: explicit } as NodeJS.ProcessEnv,
    roots: [path.join(dir, 'missing')],
  });
  assert.ok(withEnv.includes(explicit));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── harvestQueues ────────────────────────────────────────────────────────────

test('harvestQueues: merges strays, canonical reason wins, strays cleared, idempotent', () => {
  const dir = tmp();
  const canonical = path.join(dir, 'lina.db');
  const strayA = path.join(dir, 'a.db');   // e.g. inbound_final/data/lina.db
  const strayB = path.join(dir, 'b.db');   // e.g. inbound_final/data/tui.db
  const canonicalDb = new Db(canonical);
  const a = new Db(strayA);
  const b = new Db(strayB);

  // Canonical already owns EB 46 with its own reason.
  enqueue(canonicalDb, 46, 'center_mismatch', 1_000);
  // Strays hold: an overlap with canonical, and rows only they know about.
  enqueue(a, 46, 'low_confidence_center', 500);      // overlap → canonical wins
  enqueue(a, 76, 'low_confidence_center', 2_000);
  enqueue(b, 74, 'low_confidence_center', 700);      // EB 74 — the stranded row
  enqueue(b, 76, 'low_confidence_center', 3_000);    // duplicate across strays
  canonicalDb.close(); a.close(); b.close();

  const rep = harvestQueues(canonical, { env: {}, roots: [dir] });

  assert.equal(rep.canonical, canonical);
  assert.equal(rep.merged, 2, 'EB 74 and EB 76 inserted; EB 46 already canonical');
  assert.equal(rep.cleared, 4, 'all four stray rows removed from their sources');
  assert.equal(rep.leftBehind, 0);
  assert.deepEqual(rep.skipped, []);

  const after = new Db(canonical);
  const rows = queueOf(after);
  assert.deepEqual(rows.map(r => r.property_id), [46, 74, 76]);
  assert.equal(rows[0].reason, 'center_mismatch',
    'canonical reason must win over the stray copy');
  assert.equal(rows[0].created_at, 1_000, 'canonical created_at preserved');
  const bAfter = new Db(strayB);
  assert.deepEqual(queueOf(bAfter), [], 'stray copy is emptied, not duplicated');
  after.close(); bAfter.close();

  // Second pass: nothing left anywhere → no-op, no rows lost.
  const again = harvestQueues(canonical, { env: {}, roots: [dir] });
  assert.equal(again.merged, 0);
  assert.equal(again.cleared, 0);
  assert.equal(again.rows.length, 0);
  const check = new Db(canonical);
  assert.equal(queueOf(check).length, 3, 'canonical queue untouched by re-harvest');
  check.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── created_at variance (the silent-swallow bug) ────────────────────────────
//
// The bot runtime stores `created_at` as ISO-8601 TEXT, this repo as INTEGER
// epoch ms. The first harvest implementation used `Math.min(iso, Date.now())`
// → NaN → SQLite stored NULL → `created_at NOT NULL` rejected the row — and
// `INSERT OR IGNORE` reported that rejection as success: 12 rows counted as
// merged, never written, then cleared from their source. These tests pin both
// halves of the fix.

test('toQueueTimestamp: accepts every format a writer uses, rejects the rest', () => {
  assert.equal(toQueueTimestamp(1_770_000_000_000), 1_770_000_000_000);
  assert.equal(toQueueTimestamp('1770000000000'), 1_770_000_000_000);
  const iso = '2026-09-13T10:00:00.000Z';
  assert.equal(toQueueTimestamp(iso), Date.parse(iso));
  assert.equal(toQueueTimestamp(new Date(iso)), Date.parse(iso));
  assert.throws(() => toQueueTimestamp(null), /unparseable created_at/);
  assert.throws(() => toQueueTimestamp(undefined), /unparseable created_at/);
  assert.throws(() => toQueueTimestamp('not a date'), /unparseable created_at/);
});

test('harvestQueues: a source storing created_at as ISO TEXT merges as epoch ms', () => {
  const dir = tmp();
  const canonical = path.join(dir, 'lina.db');
  const bot = path.join(dir, 'bot.db');
  new Db(canonical).close();

  // Bot-runtime schema: created_at TEXT NOT NULL, ISO-8601 value.
  const src = new Database(bot);
  src.exec(`CREATE TABLE geo_reresolve_queue (
    property_id INTEGER PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL)`);
  const iso = '2026-09-13T10:00:00.000Z';
  src.prepare('INSERT INTO geo_reresolve_queue VALUES (?, ?, ?)').run(74, 'low_confidence_center', iso);
  src.close();

  const rep = harvestQueues(canonical, { env: {}, roots: [dir] });
  assert.deepEqual(rep.skipped, [], 'nothing may be silently rejected');
  assert.equal(rep.merged, 1);
  assert.equal(rep.cleared, 1);

  const out = new Db(canonical);
  const row = queueOf(out).find(r => r.property_id === 74);
  assert.ok(row, 'EB 74 must land in the canonical queue');
  assert.equal(typeof row!.created_at, 'number');
  assert.equal(row!.created_at, Date.parse(iso));
  out.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('harvestQueues: a row that cannot be merged is reported AND left in its source', () => {
  const dir = tmp();
  const canonical = path.join(dir, 'lina.db');
  const bad = path.join(dir, 'bad.db');
  new Db(canonical).close();

  // A source whose `reason` is NULL-able: canonical declares NOT NULL, so the
  // insert must FAIL LOUDLY instead of being swallowed by INSERT OR IGNORE.
  const src = new Database(bad);
  src.exec(`CREATE TABLE geo_reresolve_queue (
    property_id INTEGER PRIMARY KEY, reason TEXT, created_at INTEGER NOT NULL)`);
  src.prepare('INSERT INTO geo_reresolve_queue VALUES (?, ?, ?)').run(7, null, 1_000);
  src.close();

  const rep = harvestQueues(canonical, { env: {}, roots: [dir] });
  assert.equal(rep.merged, 0);
  assert.equal(rep.cleared, 0, 'nothing may be cleared without being merged');
  const entry = rep.skipped.find(s => s.file === bad);
  assert.ok(entry, 'the failure must be reported, not swallowed');
  assert.match(entry!.why, /EB 7/);

  const stillThere = new Db(bad);
  assert.equal(queueOf(stillThere).length, 1, 'the unmerged row stays in its source');
  stillThere.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('harvestQueues: reports unreadable files and files without the queue table instead of throwing', () => {
  const dir = tmp();
  const canonical = path.join(dir, 'lina.db');
  const plain = path.join(dir, 'plain.db');     // valid sqlite, no queue table
  const junk = path.join(dir, 'junk.db');       // not a database at all
  new Db(canonical).close();
  // Built WITHOUT the geo schema — a table-less DB is not a queue source.
  const p = new Database(plain);
  p.exec('CREATE TABLE other (id INTEGER)');
  p.close();
  fs.writeFileSync(junk, 'this is not a database');

  const rep = harvestQueues(canonical, { env: {}, roots: [dir] });

  assert.equal(rep.merged, 0);
  assert.ok(!rep.withQueue.includes(plain), 'table-less file is not a queue source');
  assert.equal(rep.skipped.filter(s => s.file === plain).length, 0,
    'table-less file is skipped quietly, not an error');
  const junkSkip = rep.skipped.find(s => s.file === junk);
  assert.ok(junkSkip, 'unparseable file is reported');
  assert.ok(junkSkip!.why.length > 0);

  fs.rmSync(dir, { recursive: true, force: true });
});
