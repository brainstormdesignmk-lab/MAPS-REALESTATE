// THE STREET CENSUS CORE (October runbook Step 2) — pure, network-free.
//
// The probe classifies every candidate street the bot could ever be asked
// about (union: the local map's own streets ∪ every street ever carried in
// a feed address ∪ OSM street names) into the runbook's three classes:
//   (a) known  — the map resolves it trusted (≥2 numbered building rows)
//   (b) thin   — the street is IN the map but numbers are missing/thin
//   (c) unknown — the street is not in the map at all
// and projects the SerpApi cost of teaching the gaps BEFORE anything is
// spent. The DECISION GATE rule lives here: class (c) is never trimmed —
// it is the whole point of the October run.
//
// Purity contract: every input is plain data or an injected probe callback;
// no fs, no fetch, no clock. scripts/street-census.ts and
// scripts/street-teach.ts consume it; tests pin it.

import { streetKey, extractHouseNum } from './offlineMap';

/** Where a candidate street was seen. A street may come from several — the
 *  display spelling prefers the map's own (it is what OSM/Google confirm). */
export type StreetOrigin = 'map' | 'feed' | 'osm';

export interface StreetCandidate {
  /** Canonical street key (streetKey) — the union identity. */
  key: string;
  /** Best display spelling seen (first occurrence, map spelling wins). */
  display: string;
  origins: StreetOrigin[];
  /** Housenumbers the feed has carried on this street → occurrence count.
   *  Class (b) teaches ONLY these — never all numbers in existence. */
  feedNumbers: Map<string, number>;
  /** Numbered address rows the local map carries (0 when the street is
   *  absent or the probe is unavailable). */
  mapNumbers: number;
}

export interface CensusInputs {
  /** Distinct street rows from the map's addresses table. */
  mapStreets?: string[];
  /** Every feed address line ever carried (incl. removed properties). */
  feedAddresses?: string[];
  /** OSM street names (Phase A data). */
  osmStreets?: string[];
  /** Map probes — injected so this module never opens a DB.
   *  knows: does the map know the street AT ALL (any rows);
   *  numberedRows: how many NUMBERED building rows it carries. */
  probes?: {
    knows: (street: string) => boolean;
    numberedRows: (street: string) => number;
  };
}

/** The street part of a feed address line: everything before the trailing
 *  house-number token ("Мирче Оровчанец 86 - 1" → "Мирче Оровчанец",
 *  "Бул. АСНОМ Бр.134" → "Бул. АСНОМ"). Same trailing-number rule
 *  learnAddress/learnStreet use, plus the Бр.-prefixed house number form
 *  (Број = number) that feeds write before the digits. */
export function streetPart(address: string): string {
  return address
    .replace(/(?:^|\s)бр\.?\s*\d+(?:[\/\-\s]\d+)*\s*$/i, '')
    .replace(/\s+\d+(?:[\s.\-/]*(?:\d+|[а-яa-z]+))*\s*$/i, '')
    .trim();
}

/** Build the candidate union. Idempotent: the same inputs always produce
 *  the same candidate list (stable order: first-seen by origin priority
 *  map → feed → osm, then insertion within each). */
export function collectCandidates(inputs: CensusInputs): StreetCandidate[] {
  const byKey = new Map<string, StreetCandidate>();
  const get = (street: string, origin: StreetOrigin): StreetCandidate | undefined => {
    const name = streetPart(street.trim());
    if (name.length < 3) return undefined;
    const key = streetKey(name);
    if (!key || key.length < 3) return undefined;
    let c = byKey.get(key);
    if (!c) {
      c = { key, display: name, origins: [], feedNumbers: new Map(), mapNumbers: 0 };
      byKey.set(key, c);
    }
    if (!c.origins.includes(origin)) c.origins.push(origin);
    // Display spelling: the map's own name wins; otherwise first seen.
    if (origin === 'map') c.display = name;
    return c;
  };

  for (const s of inputs.mapStreets ?? []) get(s, 'map');
  for (const a of inputs.feedAddresses ?? []) {
    const c = get(a, 'feed');
    if (!c) continue;
    const num = extractHouseNum(a);
    if (num) c.feedNumbers.set(num, (c.feedNumbers.get(num) ?? 0) + 1);
  }
  for (const s of inputs.osmStreets ?? []) get(s, 'osm');

  // Map probe LAST so it sees the merged candidate set (probe by display
  // name — the spelling the map itself uses for map-origin streets).
  if (inputs.probes) {
    for (const c of byKey.values()) c.mapNumbers = inputs.probes.numberedRows(c.display);
  }

  return [...byKey.values()];
}

export type StreetClass = 'known' | 'thin' | 'unknown';

export interface StreetClassification {
  candidate: StreetCandidate;
  cls: StreetClass;
  /** Class (b) only: the numbers worth geocoding, feed-ranked (count desc,
   *  then numeric). Empty for known/unknown — unknowns need ONE street
   *  geocode, not per-number ones. */
  teachNumbers: string[];
}

/** THE CLASSIFIER (the runbook's table, made code):
 *  (c) unknown — the map has no row for the street at all → ONE geocode
 *      "<street>, Скопје" teaches it forever (class (c) is never trimmed);
 *  (a) known  — ≥2 numbered rows → interpolation works for any in-range
 *      number, plus Stage-A exact hits → skip;
 *  (b) thin   — in the map with 0–1 numbered rows → geocode ONLY the
 *      numbers the feed actually carried (skip when the feed carried none:
 *      nothing to anchor, the standing B3 loop owns it). */
export function classifyStreet(c: StreetCandidate, knows: boolean): StreetClassification {
  if (!knows) return { candidate: c, cls: 'unknown', teachNumbers: [] };
  if (c.mapNumbers >= 2) return { candidate: c, cls: 'known', teachNumbers: [] };
  const teachNumbers = pickThinNumbers(c.feedNumbers);
  return { candidate: c, cls: teachNumbers.length > 0 ? 'thin' : 'known', teachNumbers };
}

/** Classify the whole candidate set. Batch knows-probe via the injected
 *  callback; numberedRows already rode the candidate (collectCandidates). */
export function classifyAll(candidates: StreetCandidate[], knows: (street: string) => boolean): StreetClassification[] {
  return candidates.map(c => classifyStreet(c, knows(c.display)));
}

/** Thin-street number picker: feed-ranked. minCount trims per the runbook's
 *  budget rule (drop numbers the feed carried fewer than N times BEFORE
 *  dropping class (b) entirely). */
export function pickThinNumbers(feedNumbers: Map<string, number>, minCount = 1): string[] {
  return [...feedNumbers.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1] || numValue(a[0]) - numValue(b[0]))
    .map(([num]) => num);
}

function numValue(h: string): number {
  const m = h.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

// ---------------------------------------------------------------------------
// Cost projection — the DECISION GATE printout
// ---------------------------------------------------------------------------

export interface CensusProjection {
  known: number;
  thin: number;
  /** Class (b) searches: one per feed-carried number on thin streets. */
  thinNumbers: number;
  /** Class (c) searches: one per unknown street — never trimmed. */
  unknown: number;
  /** Total projected SerpApi searches (teach steps 3+4 together). */
  searches: number;
}

export function projectCoverage(classified: StreetClassification[]): CensusProjection {
  const p: CensusProjection = { known: 0, thin: 0, thinNumbers: 0, unknown: 0, searches: 0 };
  for (const c of classified) {
    if (c.cls === 'known') p.known++;
    else if (c.cls === 'thin') { p.thin++; p.thinNumbers += c.teachNumbers.length; }
    else p.unknown++;
  }
  p.searches = p.thinNumbers + p.unknown;
  return p;
}

// ---------------------------------------------------------------------------
// Teach-plan selection — shared by scripts/street-teach.ts (--unknowns/--thin)
// ---------------------------------------------------------------------------

export interface TeachTask {
  key: string;
  /** The street to geocode ("<street>, Скопје, Северна Македонија"). */
  street: string;
  cls: 'unknown' | 'thin';
  /** Class (b): the numbers to learn (one geocode EACH). Class (c): empty —
   *  the single street geocode plants the anchor via learnStreet. */
  numbers: string[];
}

export interface TeachPlanOpts {
  mode: 'unknown' | 'thin' | 'all';
  /** Max SEARCHES (not tasks) — the runbook's --cap counts SerpApi calls. */
  cap?: number;
  /** Class (b) trim: keep only numbers the feed carried ≥ minFeedCount times. */
  minFeedCount?: number;
}

/** Build the ordered teach plan. Order: class (c) first (never trimmed),
 *  then class (b); within a class, feed+OSM-origin streets before map-only
 *  (a street the feed carried is one a client can actually ask about),
 *  then stable alphabetical. The cap slices the SEARCH budget: class (c)
 *  streets first in full, then class (b) numbers — the runbook's trip
 *  order (drop (b) numbers → drop (b) → never (c)) is exactly what falls
 *  out of this ordering. */
export function buildTeachPlan(classified: StreetClassification[], opts: TeachPlanOpts): TeachTask[] {
  const minCount = opts.minFeedCount ?? 1;
  const unknowns: TeachTask[] = [];
  const thins: TeachTask[] = [];

  for (const c of classified) {
    const feedish = c.candidate.origins.includes('feed') || c.candidate.origins.includes('osm');
    if (c.cls === 'unknown') {
      unknowns.push({ key: c.candidate.key, street: c.candidate.display, cls: 'unknown', numbers: [] });
    } else if (c.cls === 'thin') {
      const numbers = pickThinNumbers(c.candidate.feedNumbers, minCount);
      if (numbers.length === 0) continue;
      thins.push({ key: c.candidate.key, street: c.candidate.display, cls: 'thin', numbers });
    }
  }

  // Class (c) first, feed/OSM-carrying streets first, then alphabetical —
  // stable across runs so --dry and the real run teach the same list.
  const feedSet = new Set(classified
    .filter(c => c.candidate.origins.includes('feed') || c.candidate.origins.includes('osm'))
    .map(c => c.candidate.key));
  const rank = (t: TeachTask): number =>
    (t.cls === 'unknown' ? 0 : 1000)
    + (feedSet.has(t.key) ? 0 : 500);
  const sorted = [...unknowns, ...thins].sort((a, b) =>
    rank(a) - rank(b) || a.street.localeCompare(b.street, 'mk'));

  if (opts.cap === undefined) {
    return opts.mode === 'all' ? sorted
      : sorted.filter(t => t.cls === opts.mode);
  }
  // Cap = searches. Unknowns consume 1 each and are NEVER dropped; thin
  // numbers fill whatever budget remains.
  const plan: TeachTask[] = [];
  let budget = opts.cap;
  for (const t of sorted) {
    if (t.cls === 'unknown') {
      if (opts.mode === 'thin') continue;
      if (budget <= 0) break;
      plan.push(t); budget -= 1;
    } else {
      if (opts.mode === 'unknown') break;
      const affordable = Math.max(0, budget);
      if (affordable === 0) break;
      const numbers = t.numbers.slice(0, affordable);
      plan.push({ ...t, numbers });
      budget -= numbers.length;
    }
  }
  return plan;
}
