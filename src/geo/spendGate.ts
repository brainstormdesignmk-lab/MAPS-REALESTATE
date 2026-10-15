// THE PRE-FLIGHT GATE — the decision a dry run must make before a single key
// is touched: "can the keys on disk actually buy this pass?"
//
// The October failure this closes: the gate compared the plan against a
// NOMINAL ceiling (keys on disk × 250) instead of the account's real balance,
// so with 13 searches left an 8-key install still printed
// "Budget ceiling (keys on disk × 250): 2000", exited 0, and the real run
// stopped 13 searches in — with VERIFY reporting "budget exhausted" as a
// WARNING and the process exiting 0 ("RUN OK — the map is shippable") while
// 497 of 510 pairs were still open. A gate that cannot see the balance is not
// a gate.
//
// /account is FREE (it consumes no search), so the gate can always ask. The
// only case where it cannot is a probe failure (offline / API down); then the
// nominal ceiling is the honest fallback AND the verdict says so, because
// "we could not check" must never read as "you are fine".

/** Nominal monthly allowance per Free-plan key — used only when the live
 *  balance cannot be read. */
export const SEARCHES_PER_KEY = 250;

export interface SpendGateInput {
  /** Unscanned pairs the run would scan (planCoverage().estimatedSearches). */
  estimatedSearches: number;
  /** Sum of `total_searches_left` across keys, from the FREE /account probe. */
  liveRemaining: number;
  /** True when at least one key answered the probe (a real reading exists). */
  probeOk: boolean;
  /** Keys on disk — the nominal ceiling is keys × SEARCHES_PER_KEY. */
  keysOnDisk: number;
  /** The per-run hard stop; reported so the operator sees it before spending. */
  budgetFloor: number;
  /** --limit=N: a deliberately partial pass is always allowed to start. */
  limit?: number;
}

export interface SpendGateVerdict {
  /** false ⇒ the run must NOT start (the caller exits 1). */
  go: boolean;
  /** The number the verdict was measured against (live when probeOk). */
  budget: number;
  /** Where `budget` came from — the log must not hide this. */
  basis: 'live' | 'nominal';
  /** Human-readable lines the caller logs verbatim. */
  lines: string[];
}

/**
 * Decide whether a full pass may start. Pure — no I/O, no clock, no keys —
 * so the rule is unit-testable and the same judgement is applied every month.
 */
export function decideSpendGate(i: SpendGateInput): SpendGateVerdict {
  const nominalCeiling = i.keysOnDisk * SEARCHES_PER_KEY;
  const budget = i.probeOk ? i.liveRemaining : nominalCeiling;
  const basis: 'live' | 'nominal' = i.probeOk ? 'live' : 'nominal';
  const lines: string[] = [];

  lines.push(i.probeOk
    ? `  Budget now (free /account probe): ${i.liveRemaining} search(es) left across ${i.keysOnDisk} key(s)`
    : `  ⚠ Budget UNVERIFIED — /account did not answer; falling back to the nominal ceiling`);
  lines.push(`  Budget ceiling (keys on disk × ${SEARCHES_PER_KEY}): ${nominalCeiling}`);
  lines.push(`  Budget floor per run: ${i.budgetFloor} searches (hard stop)`);

  // A deliberately partial pass (--limit) is sized by the operator: never block it.
  if (i.limit !== undefined && Number.isFinite(i.limit)) {
    lines.push(`  --limit caps this run at ${i.limit} search(es) — the gate does not apply`);
    return { go: true, budget, basis, lines };
  }

  if (i.estimatedSearches > budget) {
    lines.push(`  ✗ This pass needs ${i.estimatedSearches} search(es); the ${basis === 'live' ? 'accounts hold' : 'keys on disk can buy'} ${budget}.`);
    lines.push(basis === 'live'
      ? '    Re-key first, wait for the monthly reset, or size a partial pass explicitly with --limit=N.'
      : '    Re-key first, or size a partial pass explicitly with --limit=N.');
    return { go: false, budget, basis, lines };
  }

  lines.push(`  ✓ This pass fits: ${i.estimatedSearches} of ${budget} ${basis === 'live' ? 'available now' : 'nominally available'}`);
  return { go: true, budget, basis, lines };
}
