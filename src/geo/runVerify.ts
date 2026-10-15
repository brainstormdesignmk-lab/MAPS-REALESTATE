// THE INVARIANTS OF A SHIPPABLE MAP — checked, not assumed.
//
// These used to be a manual §6 checklist in the runbook: read five numbers out
// of a one-liner and decide by eye whether the map was good. That is a patch.
// A monthly run now calls this and exits non-zero when an invariant is broken,
// so "the script printed a successful summary" can never again mean "the map is
// fine" while 444 tile×category pairs are quietly still open.
//
// Every check below is a way the map has ALREADY been wrong at least once:
//   • integrity / poi count — the cwd bug's signature is a freshly CREATED,
//     near-empty `skopje-pois.db` that `new Database()` happily writes into.
//   • duplicate place_id     — Phase B2 (the OSM↔Google merge) not running;
//     the reader's place_id collapse then drops the Cyrillic name.
//   • uncovered pairs        — the calendar gate: a November run considered 2
//     of 15 categories, left 444 pairs open, and reported success.
//
// A violation is a HARD failure (the map is not shippable). A pair count that
// is open only because the SerpApi budget ran out is a WARNING: the ledger
// keeps it, and the next run resumes on it. That distinction is the whole
// point — "we ran out of keys" and "we silently skipped it" must not look the
// same in the log.

import Database from 'better-sqlite3';
import { planCoverage } from './tileCoverage';

/** Below this the file cannot be the real map. */
export const MAP_MIN_POIS = 1000;

export interface RunVerifyResult {
  /** Hard failures — the run must exit non-zero and the map must not ship. */
  violations: string[];
  /** Carry-over that is expected and safe (budget-bound coverage). */
  warnings: string[];
  integrity: string;
  pois: number;
  duplicatedPlaceIds: number;
  ledgerScans: number;
  uncoveredPairs: number;
  totalPairs: number;
}

export interface RunVerifyOpts {
  /** Live SerpApi budget left when the run finished. */
  searchesLeft: number;
  /** The same hard floor every phase stops at (queueDrain.BUDGET_STOP / the
   *  script's BUDGET_FLOOR) — below it, stopping is correct, not a defect. */
  budgetFloor: number;
  minPois?: number;
}

export function verifyMapDb(
  db: Database.Database,
  categories: readonly string[],
  opts: RunVerifyOpts,
): RunVerifyResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  // 1. Is this even a database?
  let integrity = 'unknown';
  try {
    integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
  } catch (e) {
    integrity = `unreadable (${(e as Error).message})`;
  }
  if (integrity !== 'ok') violations.push(`integrity_check = ${integrity}`);

  // 2. Is it the REAL map? `new Database(file)` creates a missing file, so a
  //    wrong-directory run "succeeds" against an empty one.
  const minPois = opts.minPois ?? MAP_MIN_POIS;
  let pois = 0;
  try {
    pois = (db.prepare('SELECT COUNT(*) c FROM pois').get() as { c: number }).c;
  } catch (e) {
    violations.push(`pois table unreadable: ${(e as Error).message}`);
  }
  if (pois < minPois) {
    violations.push(`pois = ${pois} (< ${minPois} — wrong or empty map file?)`);
  }

  // 3. Did the merge hold? One row per place_id, or the reader loses the
  //    Cyrillic name to the Google row it collapses onto.
  let duplicatedPlaceIds = 0;
  try {
    duplicatedPlaceIds = (db.prepare(
      `SELECT COUNT(*) c FROM (SELECT place_id FROM pois WHERE place_id IS NOT NULL GROUP BY place_id HAVING COUNT(*) > 1)`,
    ).get() as { c: number }).c;
  } catch { duplicatedPlaceIds = 0; }
  if (duplicatedPlaceIds !== 0) {
    violations.push(`duplicate place_id groups = ${duplicatedPlaceIds} (Phase B2 did not merge)`);
  }

  // 4. Is the grid closed — or is the budget, not the calendar, why it is not?
  //    (The plan runs first: it is what ensures the ledger table exists.)
  let uncoveredPairs = 0;
  let totalPairs = 0;
  try {
    const plan = planCoverage(db, categories);
    uncoveredPairs = plan.uncoveredPairs;
    totalPairs = plan.totalPairs;
  } catch (e) {
    violations.push(`coverage plan unreadable: ${(e as Error).message}`);
  }
  let ledgerScans = 0;
  try {
    ledgerScans = (db.prepare('SELECT COUNT(*) c FROM tile_scans').get() as { c: number }).c;
  } catch {
    ledgerScans = 0;   // no ledger yet: every pair is open, which the plan says
  }
  if (uncoveredPairs > 0) {
    const detail = `${uncoveredPairs} of ${totalPairs} pairs unscanned `
      + `(ledger ${ledgerScans}, ${opts.searchesLeft} searches left)`;
    if (opts.searchesLeft < opts.budgetFloor) {
      warnings.push(`${detail} — budget exhausted; they resume on the next run`);
    } else {
      violations.push(`${detail} — the budget was there, so the pass should have finished`);
    }
  }

  return { violations, warnings, integrity, pois, duplicatedPlaceIds, ledgerScans, uncoveredPairs, totalPairs };
}
