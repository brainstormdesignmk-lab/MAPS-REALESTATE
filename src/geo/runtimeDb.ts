// maps-realestate: standalone geo stack.
//
// runtimeDb — THE ONE resolution of "which file is Lina's runtime DB", plus
// the same for the MAP, plus the harvest that makes queue fragmentation
// harmless.
//
// THE [16:04] FRAGMENTATION (found while diagnosing EB 74's wrong pin):
// `geo_reresolve_queue` is WRITTEN by every runtime that touches Lina's geo
// data — geo-watcher, importGeo (bot side), the poison sweep — and DRAINED by
// exactly one thing, refresh-monthly Phase C. But every entry point resolved
// DB_PATH its OWN way: `~/.lina/lina.env` carries the RELATIVE string
// `data/lina.db`, and each script resolved it against ITS OWN process.cwd().
// Two checkouts × two working directories = four queue copies, and Phase C
// drained only whichever file IT happened to open:
//
//   maps-realestate/data/lina.db        2 rows  (EB 46, 69)
//   inbound_final/data/lina.db          5 rows  (EB 76, 78, 89, 90, 91)
//   inbound_final/data/tui.db           8 rows  (EB 51 … 74 … 89)
//   atom production data/lina.db        6 rows  (own machine — see below)
//
// EB 74 sat in tui.db from 13 Sept until now: the label fix shipped in
// October, but the November drain would still have missed it, because the
// drain only ever opened the file the caller's cwd pointed at.
//
// THE FIX, in four parts:
//   1. resolveRuntimeDb() — ONE absolute answer for the queue, cwd-independent.
//      A relative DB_PATH resolves against THIS REPO (the module's own
//      location), never against whatever directory the operator `cd`'d into.
//   2. resolveMapDb() — the SAME rule for the MAP. The queue stopped depending
//      on cwd; the artifact the whole run produces did not, so a cron `cd`, an
//      ssh'd shell or a symlinked cwd could make a run open — or CREATE — a
//      different `skopje-pois.db`, spend the month's SerpApi budget into it, and
//      print success while the authoritative map sat untouched.
//   3. harvestQueues() — before the drain, every known sibling queue is MERGED
//      into that one file (earliest created_at wins per property_id). A row may
//      be queued anywhere; Phase C still drains it. Fragmentation becomes
//      harmless instead of a silent way to lose work.
//   4. the atom up-path — a collected per-atom snapshot (`data/atoms/<id>/
//      lina.db.copy`, written by collect-atoms.sh) is a queue source too, so
//      the rows live traffic actually created on the atom finally reach the
//      drain. Because atoms never push and every collect re-pulls the SAME
//      unchanged file, that import is guarded by an IMPORT LEDGER: the second
//      identical (source, property, reason, created_at) event is skipped, so a
//      re-collected snapshot can never re-queue — and therefore never re-spend
//      a geocode — on work already done.
//
// Scope: this file's own machine. The atom is reached only through the
// snapshot collect-atoms.sh pulls (no path resolution can reach another box).
// Set LINA_QUEUE_SOURCES (path list) to name extra queue files explicitly.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { Db } from '../store/db';

/** The repo root — derived from THIS file's location, never from cwd. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The one table that must not exist in more than one file. */
export const QUEUE_TABLE = 'geo_reresolve_queue';

export type ResolveRule = 'absolute' | 'repo-anchored' | 'default';

export interface ResolvedRuntimeDb {
  /** Absolute path to the canonical runtime DB (the one Phase C drains). */
  file: string;
  /** Which rule produced it — logged at refresh start so the operator can see it. */
  rule: ResolveRule;
}

/**
 * Resolve the canonical runtime DB. Contract:
 *   - DB_PATH absolute      → used verbatim (operator said exactly which file)
 *   - DB_PATH relative      → resolved against REPO_ROOT (NOT process.cwd())
 *   - DB_PATH unset         → <repo>/data/lina.db
 *
 * The old rule — `DB_PATH ?? cwd + '/data/lina.db'` — meant the same env file
 * produced a different database for every working directory. That is the whole
 * bug; do not reintroduce process.cwd() here.
 */
export function resolveRuntimeDb(env: NodeJS.ProcessEnv = process.env): ResolvedRuntimeDb {
  const raw = (env.DB_PATH ?? '').trim();
  if (raw && path.isAbsolute(raw)) {
    return { file: path.normalize(raw), rule: 'absolute' };
  }
  if (raw) {
    return { file: path.resolve(REPO_ROOT, raw), rule: 'repo-anchored' };
  }
  return { file: path.join(REPO_ROOT, 'data', 'lina.db'), rule: 'default' };
}

// ── THE MAP FILE — the same cwd-independent rule ─────────────────────────────
// SKOPJE_POIS_DB used to fall back to `process.cwd() + '/data/skopje-pois.db'`.
// A deployed box, a cron `cd /srv/app`, or an ssh'd shell resolved a DIFFERENT
// map than the one the operator had just been editing — and because
// `new Database(file)` CREATES a missing file, the run did not fail: it built a
// fresh, nearly empty map, wrote 500 Google POIs into it, and reported success.
// The map is the deliverable; it does not get to depend on the shell.

export type MapResolveRule = 'absolute' | 'repo-anchored' | 'default';

export interface ResolvedMapDb {
  /** Absolute path to the offline map (skopje-pois.db) this run reads/writes. */
  file: string;
  rule: MapResolveRule;
}

/**
 * Resolve the offline map. Contract:
 *   - SKOPJE_POIS_DB absolute → used verbatim (a machine may point elsewhere)
 *   - SKOPJE_POIS_DB relative → resolved against REPO_ROOT
 *   - unset                   → <repo>/data/skopje-pois.db
 *
 * On a maps-role machine this repo IS the map's home, so the default is the
 * right answer there too; the rule is logged at run start either way.
 */
export function resolveMapDb(env: NodeJS.ProcessEnv = process.env): ResolvedMapDb {
  const raw = (env.SKOPJE_POIS_DB ?? '').trim();
  if (raw && path.isAbsolute(raw)) {
    return { file: path.normalize(raw), rule: 'absolute' };
  }
  if (raw) {
    return { file: path.resolve(REPO_ROOT, raw), rule: 'repo-anchored' };
  }
  return { file: path.join(REPO_ROOT, 'data', 'skopje-pois.db'), rule: 'default' };
}

/** The two DB files a LINA checkout actually keeps a queue in. */
export const SIBLING_RUNTIME_DBS = ['lina.db', 'tui.db'] as const;

/** Sibling LINA checkouts' data dirs (workstation layout). Existence-checked:
 *  on a deployed box (T60 `/srv/app`, the atom) they simply are not there. */
export function siblingDataDirs(): string[] {
  return [
    path.resolve(REPO_ROOT, '..', 'real-estate-atoms', 'secretaries', 'inbound_final', 'data'),
    path.resolve(REPO_ROOT, '..', 'inbound_final', 'data'),
  ].filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

/**
 * Directories scanned for stray copies of the runtime DB when LINA_QUEUE_SOURCES
 * does not name them: this repo's own data dir, plus any sibling LINA data dir.
 */
export function defaultQueueRoots(): string[] {
  return [path.join(REPO_ROOT, 'data'), ...siblingDataDirs()];
}

/**
 * Where collect-atoms.sh may have left per-atom DB snapshots. The collector
 * runs from the BOT repo (`cd scripts/..`), so its `data/atoms/<id>/` is the
 * sibling checkout's — checked first after this repo's own, for a deployment
 * where this repo collects directly.
 */
export function atomSnapshotRoots(): string[] {
  const candidates = [
    path.join(REPO_ROOT, 'data', 'atoms'),
    path.resolve(REPO_ROOT, '..', 'real-estate-atoms', 'secretaries', 'inbound_final', 'data', 'atoms'),
    path.resolve(REPO_ROOT, '..', 'inbound_final', 'data', 'atoms'),
  ];
  return candidates.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

/**
 * Collected per-atom DB snapshots: `<root>/<atomId>/lina.db.copy`.
 *
 * This is the ONLY way an atom's queue can reach this machine — atoms never
 * push, and collect-atoms.sh carries the file down. It is EVIDENCE, not live
 * state: rows are read out and never deleted from it (an operator may still
 * want to inspect what the atom had), which is exactly why the import ledger
 * below exists — re-collecting an unchanged snapshot must not re-import.
 */
export function atomSnapshotFiles(roots: string[] = atomSnapshotRoots()): string[] {
  const out: string[] = [];
  for (const root of roots) {
    let ids: string[];
    try { ids = fs.readdirSync(root); } catch { continue; }
    for (const id of ids) {
      const dir = path.join(root, id);
      let names: string[];
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        names = fs.readdirSync(dir);
      } catch { continue; }
      for (const n of names) {
        // `lina.db.copy` and any timestamped variant the collector used — but
        // NEVER the SQLite sidecars (-shm / -wal / -journal). They are not
        // databases: probing them only produces a bogus "unreadable" entry in
        // the refresh log, and the snapshot's own WAL is read through the main
        // file anyway.
        if (n.endsWith('-shm') || n.endsWith('-wal') || n.endsWith('-journal')) continue;
        if (!/^lina\.db(\.copy.*)?$/.test(n)) continue;
        out.push(path.join(dir, n));
      }
    }
  }
  return out.sort();
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  // Colon-separated (POSIX PATH style); commas tolerated so a single env var
  // can be written either way in lina.env.
  return value.split(/[:,]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function sameFile(a: string, b: string): boolean {
  try { return fs.realpathSync(a) === fs.realpathSync(b); }
  catch { return path.resolve(a) === path.resolve(b); }
}

/** A candidate stray queue + the policy for the rows found in it. */
export interface QueueSource {
  file: string;
  /**
   * true  = live state on this machine (a stray copy). Merge the rows, then
   *         CLEAR them from the source — they now live in the canonical file.
   * false = collected atom snapshot (evidence). Merge the rows and LEAVE them;
   *         the import ledger, not deletion, is what makes a re-run a no-op.
   */
  clear: boolean;
}

export interface QueueDiscoveryOpts {
  env?: NodeJS.ProcessEnv;
  roots?: string[];
  /** Explicit atom-snapshot files. Defaults to the collected ones — but ONLY
   *  when no explicit `roots` were given, so a caller working on a temp dir
   *  never has the live cluster's snapshots merged into it by surprise. */
  atomFiles?: string[];
}

/**
 * Every file that could hold a stray copy of the queue:
 *   - `roots` (or the convention defaults) are scanned for *.db (non-recursive)
 *   - LINA_QUEUE_SOURCES adds files/dirs explicitly (colon-separated)
 *   - collected atom snapshots (data/atoms/<id>/lina.db.copy)
 *   - the canonical file itself is always excluded
 */
export function discoverQueueSources(
  canonical: string,
  opts: QueueDiscoveryOpts = {},
): QueueSource[] {
  const env = opts.env ?? process.env;
  const found = new Map<string, boolean>();
  const add = (file: string, clear: boolean): void => {
    found.set(path.resolve(file), clear);
  };

  // A root is either a directory (scan `only`, or every *.db when null) or an
  // explicitly named file, which is taken as given — extension or not — so an
  // operator can point at a snapshot (.copy) by hand.
  const scanRoot = (root: string, only: readonly string[] | null): void => {
    let stat: fs.Stats;
    try { stat = fs.statSync(root); } catch { return; }
    if (!stat.isDirectory()) { add(root, true); return; }
    let names: string[];
    try { names = fs.readdirSync(root); } catch { return; }
    for (const n of names) {
      if (only ? only.includes(n) : n.endsWith('.db')) add(path.join(root, n), true);
    }
  };

  if (opts.roots) {
    for (const root of opts.roots) scanRoot(root, null);
  } else {
    // This repo's data dir: any *.db (its own stray copies and their backups).
    scanRoot(path.join(REPO_ROOT, 'data'), null);
    // A SIBLING checkout: only the two files a LINA runtime actually queues in.
    // A blanket *.db here would ingest whatever scratch/test databases happen
    // to sit in that directory — and a queue row in a test DB would be drained
    // against REAL Supabase properties, spending real SerpApi budget. Name a
    // non-standard file explicitly with LINA_QUEUE_SOURCES instead.
    for (const dir of siblingDataDirs()) scanRoot(dir, SIBLING_RUNTIME_DBS);
  }

  // Operator-named extras: a file is taken as given, a directory is scanned.
  for (const f of splitList(env.LINA_QUEUE_SOURCES)) scanRoot(f, null);

  const atomFiles = opts.atomFiles ?? (opts.roots ? [] : atomSnapshotFiles());
  for (const f of atomFiles) {
    if (!found.has(path.resolve(f))) add(f, false);
  }

  return [...found.entries()]
    .map(([file, clear]) => ({ file, clear }))
    .filter(s => { try { return fs.statSync(s.file).isFile(); } catch { return false; } })
    .filter(s => !sameFile(s.file, canonical))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** Back-compat view of discoverQueueSources — the file list, policy dropped. */
export function queueSourceFiles(canonical: string, opts: QueueDiscoveryOpts = {}): string[] {
  return discoverQueueSources(canonical, opts).map(s => s.file);
}

function hasQueueTable(db: Database.Database): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(QUEUE_TABLE) as { name?: string } | undefined;
  return !!row?.name;
}

/**
 * Normalize a queue row's `created_at` to epoch ms — the canonical schema's
 * declared type.
 *
 * The writers disagree about what this column holds:
 *   • maps-realestate (Db.migrate)  INTEGER epoch ms
 *   • bot runtime (inbound_final)   TEXT ISO-8601  ('2026-09-06T09:58:58.095Z')
 *   • TUI runtime                   INTEGER epoch ms
 * `Math.min(isoString, Date.now())` is NaN, and SQLite stores NaN as NULL →
 * `created_at NOT NULL` → the insert is REJECTED. With INSERT OR IGNORE that
 * rejection was silent: the row never landed but the harvest counted it as
 * merged and then cleared the source. Never use OR IGNORE here — normalize
 * here, and let a failure be a failure (see harvestQueues).
 */
export function toQueueTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const asNumber = Number(value.trim());
    if (Number.isFinite(asNumber)) return Math.trunc(asNumber);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value instanceof Date) return value.getTime();
  throw new Error(`unparseable created_at: ${JSON.stringify(value)}`);
}

export interface HarvestRow {
  propertyId: number;
  reason: string;
  created_at: number;
  from: string;
}

export interface HarvestReport {
  /** The canonical file rows were merged into. */
  canonical: string;
  /** Every candidate file considered. */
  sources: string[];
  /** Candidates that actually had a geo_reresolve_queue table. */
  withQueue: string[];
  /** Rows inserted into the canonical queue (it did not have these). */
  merged: number;
  /** Rows now represented canonically AND removed from a stray copy. */
  cleared: number;
  /** Rows copied over and deliberately LEFT in place (atom evidence). */
  kept: number;
  /** Rows skipped because the import ledger already recorded the exact event. */
  alreadyImported: number;
  /** Stray rows copied over but left in place (source not writable). */
  leftBehind: number;
  /** What moved, for the refresh log. */
  rows: HarvestRow[];
  /** Files that could not be read, with the reason. */
  skipped: Array<{ file: string; why: string }>;
}

/**
 * The IMPORT LEDGER — the second ledger in this system, and for the same reason
 * `tile_scans` exists: work already done must cost nothing the second time.
 *
 * An atom's queue row survives on the atom forever (nothing drains it there),
 * so every collect re-pulls it. Without a ledger, each month would re-merge it,
 * and any row the drain could not resolve would be re-geocoded on a paid key
 * every month forever. The ledger keys on the exact queue EVENT, so:
 *   • the same row, re-collected  → skipped (no merge, no spend)
 *   • a genuinely NEW queue event on the atom (new created_at / reason) → imported
 *
 * Created lazily on the runtime DB so the v7 schema contract in
 * src/store/db.ts stays byte-for-byte what the bot expects.
 */
export const IMPORT_LEDGER = 'geo_queue_imports';

function ensureLedger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${IMPORT_LEDGER} (
      source      TEXT    NOT NULL,
      property_id INTEGER NOT NULL,
      reason      TEXT,
      created_at  INTEGER NOT NULL,
      imported_at INTEGER NOT NULL,
      PRIMARY KEY (source, property_id, reason, created_at)
    );
  `);
}

/**
 * Merge every stray queue into `canonical` — the precondition for draining
 * "the" queue. Idempotent in both directions: a source row already present
 * canonically (same property_id) keeps the canonical reason/created_at, and a
 * source row already recorded in the import ledger is skipped outright.
 *
 * Never throws: an unreadable/unwritable source is reported in `skipped` so
 * the refresh logs it instead of losing the run. A source that cannot be
 * written keeps its rows — they are still copied over, so the drain sees them
 * and next month retries the cleanup.
 */
export function harvestQueues(
  canonical: string,
  opts: QueueDiscoveryOpts = {},
): HarvestReport {
  const sources = discoverQueueSources(canonical, opts);
  const res: HarvestReport = {
    canonical,
    sources: sources.map(s => s.file),
    withQueue: [],
    merged: 0,
    cleared: 0,
    kept: 0,
    alreadyImported: 0,
    leftBehind: 0,
    rows: [],
    skipped: [],
  };

  // Opens/creates the canonical file with the geo schema (landmarks +
  // geo_reresolve_queue) — the same shape Phase C then drains. The import
  // ledger lives beside it.
  const dst = new Db(canonical);
  ensureLedger(dst.db);
  const exists = dst.db.prepare(
    `SELECT 1 FROM ${QUEUE_TABLE} WHERE property_id=?`,
  );
  const ledgerSeen = dst.db.prepare(
    `SELECT 1 FROM ${IMPORT_LEDGER} WHERE source=? AND property_id=? AND reason=? AND created_at=?`,
  );
  const ledgerRecord = dst.db.prepare(
    `INSERT INTO ${IMPORT_LEDGER} (source, property_id, reason, created_at, imported_at) VALUES (?, ?, ?, ?, ?)`,
  );

  try {
    for (const source of sources) {
      const file = source.file;
      // 1. Read the stray queue read-only — never mutate on the first pass.
      let rows: Array<{ property_id: number; reason: string; created_at: number }> = [];
      let hasTable = false;
      try {
        const src = new Database(file, { readonly: true, fileMustExist: true });
        try {
          hasTable = hasQueueTable(src);
          if (hasTable) {
            rows = src.prepare(
              `SELECT property_id, reason, created_at FROM ${QUEUE_TABLE} ORDER BY created_at`,
            ).all() as typeof rows;
          }
        } finally {
          src.close();
        }
      } catch (e) {
        res.skipped.push({ file, why: (e as Error).message });
        continue;
      }
      if (!hasTable) continue;
      res.withQueue.push(file);
      if (rows.length === 0) continue;

      // 2. Merge — plain INSERT (NOT `OR IGNORE`): we already know the row is
      //    absent, so any failure here is a real failure and must surface in
      //    `skipped`. OR IGNORE swallowed the bot's ISO `created_at` (NaN →
      //    NULL → NOT NULL rejection) and reported 12 lost rows as merged.
      const insert = dst.db.prepare(
        `INSERT INTO ${QUEUE_TABLE} (property_id, reason, created_at) VALUES (?, ?, ?)`,
      );
      const represented: number[] = [];   // ids provably in canonical NOW
      for (const r of rows) {
        const propertyId = r.property_id;
        let createdAt: number;
        try {
          createdAt = toQueueTimestamp(r.created_at);
        } catch (e) {
          res.skipped.push({ file, why: `EB ${propertyId} ${(e as Error).message}` });
          continue;   // stays in its source, unledgered → retried next run
        }

        // THE IMPORT LEDGER: this exact event was already taken from this exact
        // file. Re-collecting an unchanged atom snapshot must not re-queue it —
        // and therefore must not re-spend a geocode in Phase C.
        if (ledgerSeen.get(file, propertyId, r.reason, createdAt) !== undefined) {
          res.alreadyImported++;
          represented.push(propertyId);
          continue;
        }

        if (exists.get(propertyId) === undefined) {
          try {
            const info = insert.run(propertyId, r.reason, createdAt);
            if (info.changes !== 1) {
              throw new Error(`insert reported ${info.changes} changed row(s)`);
            }
            // Verify on the same connection — "it did not throw" is not proof.
            if (exists.get(propertyId) === undefined) {
              throw new Error('row absent after insert');
            }
            res.merged++;
            res.rows.push({ propertyId, reason: r.reason, created_at: createdAt, from: file });
          } catch (e) {
            res.skipped.push({ file, why: `EB ${propertyId} not merged: ${(e as Error).message}` });
            continue;   // NOT represented: stays in the source, retried next run
          }
        }

        // Merged (or already canonical) → record the event so a re-collected
        // copy of this same source never imports it again.
        try {
          ledgerRecord.run(file, propertyId, r.reason, createdAt, Date.now());
        } catch (e) {
          res.skipped.push({ file, why: `EB ${propertyId} merged but not ledgered: ${(e as Error).message}` });
        }
        represented.push(propertyId);
      }

      // 3. Clear the stray copy — ONLY a live source, and ONLY rows proven
      //    canonical (a row we failed to merge stays in its source so nothing
      //    is ever lost and the next run retries it). Atom snapshots are kept:
      //    they are the collected evidence, and the ledger already guarantees
      //    they cannot be imported twice.
      if (!source.clear) {
        res.kept += represented.length;
        continue;
      }
      let clearedHere = 0;
      if (represented.length > 0) {
        try {
          const src = new Database(file);
          try {
            const del = src.prepare(`DELETE FROM ${QUEUE_TABLE} WHERE property_id=?`);
            for (const id of represented) {
              const info = del.run(id);
              clearedHere += info.changes;
            }
          } finally {
            src.close();
          }
          res.cleared += clearedHere;
        } catch (e) {
          res.leftBehind += represented.length;
          res.skipped.push({ file, why: `merged but not cleared: ${(e as Error).message}` });
        }
      }
      const unrepresented = rows.length - represented.length;
      if (unrepresented > 0) res.leftBehind += unrepresented;
    }
  } finally {
    dst.close();
  }

  return res;
}
