// SUSPECT-PAIR MERGE — the decision half of the suspect-pairs report.
//
// The report (scripts/suspect-pairs.ts) finds pairs that MIGHT be one place
// under two identities. MOST are; some are NOT (a bank and its ATM, a mall and
// a store inside it, two branches of a chain). Deleting every suspect would
// destroy real landmarks, so the merge is deliberately CONSERVATIVE and
// explains every decision. This module is pure and unit-tested so the rule is
// inspectable before a single row is deleted.

export interface PoiRow {
  rowid: number;
  name: string;
  type: string;
  lat: number;
  lon: number;
  source?: string | null;
  place_id?: string | null;
  phone?: string | null;
  review_count?: number | null;
}

export type SuspectKind =
  | 'same-place_id-different-name'
  | 'same-name-drifted'
  | 'same-phone'
  | 'dual-identified-near';

export interface SuspectPair {
  kind: SuspectKind;
  a: PoiRow;
  b: PoiRow;
  distanceM: number;
  evidence: string;
}

/** Lowercased, punctuation- and space-stripped — the equality used everywhere. */
export function normName(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

/** Tokens that describe the KIND of place or a corporate/administrative
 *  qualifier — they do not distinguish one place from another. Stripping them
 *  lets "NLB Banka ATM" and "NLB Bank" share a core ("nlb"), while a brand
 *  prefix like "FABUspot" survives and keeps the pair apart. */
const DESCRIPTOR = new Set([
  // ATMs / terminals
  'at', 'atm', 'атм', 'банкомат', 'апарат', 'aparat', 'pos', 'terminal',
  // corporate suffixes
  'ad', 'a.d', 'doo', 'dooel', 'дпт', 'друштво', 'dd',
  // place qualifiers
  'skopje', 'скопје', 'mk', 'makedonija', 'македонија',
  'filijala', 'филијала', 'filial', 'branch', 'kancelarija', 'канцеларија',
  'office', 'експозитура', 'ekspozitura',
  // generic type nouns
  'bank', 'banka', 'банка', 'банк', 'banking',
  'market', 'supermarket', 'маркет', 'супермаркет',
  'mall', 'shopping', 'center', 'centar', 'центар', 'trgovski', 'трговски',
  'city', 'град', 'grad', 'mol', 'мол',
  'store', 'shop', 'продавница', 'дуќан',
  'hotel', 'хотел', 'restaurant', 'ресторан', 'cafe', 'кафе', 'bar', 'бар',
  'apoteka', 'аптека', 'pharmacy',
]);

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The name with every descriptor token removed — the "which place" core. */
export function coreName(name: string): string {
  return tokens(name).filter(t => !DESCRIPTOR.has(t)).join('');
}

/** The suspect-pair detector — the exact heuristics of suspect-pairs.ts, moved
 *  here so the report and the merge share one definition. */
export function detectSuspects(rows: PoiRow[]): SuspectPair[] {
  const cell = (lat: number, lon: number): string => `${Math.round(lat * 400)}:${Math.round(lon * 260)}`;
  const buckets = new Map<string, PoiRow[]>();
  for (const r of rows) {
    const k = cell(r.lat, r.lon);
    const arr = buckets.get(k) ?? [];
    arr.push(r);
    buckets.set(k, arr);
  }
  const suspects: SuspectPair[] = [];
  const seen = new Set<string>();
  // Same dedupe key as the report (raw names) so the merge sees exactly the
  // pairs the report lists — no silent divergence between the two views.
  const key = (a: PoiRow, b: PoiRow): string =>
    [a.name, b.name].sort().join('|') + Math.round(a.lat * 400) + Math.round(b.lat * 400);

  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i], b = bucket[j];
        const d = distM(a, b);
        const k = key(a, b);
        if (seen.has(k)) continue;
        if (a.place_id && b.place_id && a.place_id === b.place_id && normName(a.name) !== normName(b.name)) {
          seen.add(k);
          suspects.push({ kind: 'same-place_id-different-name', a, b, distanceM: d, evidence: `place_id ${a.place_id}, ${d}m apart` });
          continue;
        }
        if (normName(a.name) === normName(b.name) && d > 50) {
          seen.add(k);
          suspects.push({ kind: 'same-name-drifted', a, b, distanceM: d, evidence: `${d}m apart` });
          continue;
        }
        if (a.phone && b.phone && a.phone === b.phone && normName(a.name) !== normName(b.name) && d > 50) {
          seen.add(k);
          suspects.push({ kind: 'same-phone', a, b, distanceM: d, evidence: `phone ${a.phone}, ${d}m apart` });
          continue;
        }
        if (a.place_id && b.place_id && a.place_id !== b.place_id && d < 30
          && (normName(a.name).includes(normName(b.name)) || normName(b.name).includes(normName(a.name)))) {
          seen.add(k);
          suspects.push({ kind: 'dual-identified-near', a, b, distanceM: d, evidence: `${d}m apart, distinct ids — keep richer reviews` });
        }
      }
    }
  }
  return suspects;
}

/** Same normalized name within this distance is almost certainly one physical
 *  place. Beyond it, a chain can legitimately have two same-named branches, so
 *  we do NOT auto-merge — the pair is reported for review instead. */
export const SAME_NAME_MERGE_MAX_M = 100;

// THE MALL/COMPLEX RULE (domain): when a shop sits in a mall or complex, the
// MALL is the anchor and the contents are NOT relevant for serving. So a pair
// where one name contains the other and the container is a mall/complex
// collapses onto the container.
const MALL_ANCHOR_RE = /mall|shopping|trgovski|трговски|kompleks|комплекс|\bmol\b|\bмол\b|centar|центар/iu;

export function isMallAnchor(r: PoiRow): boolean {
  return MALL_ANCHOR_RE.test(r.name) || MALL_ANCHOR_RE.test(r.type.replace(/_/g, ' '));
}

/** True when `other`'s name is the anchor's name plus extra words — the
 *  "FABUspot Skopje City Mall"-inside-"Skopje City Mall" shape. */
export function isContainedIn(anchor: PoiRow, other: PoiRow): boolean {
  const an = normName(anchor.name);
  const on = normName(other.name);
  return an.length >= 4 && on.includes(an) && on !== an;
}

export interface MergeDecision {
  merge: boolean;
  survivor: PoiRow;
  dropped: PoiRow;
  reason: string;
}

/** Pick which of two rows to keep: more reviews, then Google identity, then
 *  the FEWER descriptor words (so "Stopanska Banka" beats "ATM Stopanska
 *  Banka" — the anchor, not the ATM), then the longer name, then the older
 *  rowid. Deterministic. */
export function pickSurvivor(a: PoiRow, b: PoiRow): PoiRow {
  const descriptorCount = (r: PoiRow): number => tokens(r.name).filter(t => DESCRIPTOR.has(t)).length;
  const score = (r: PoiRow): [number, number, number, number, number] => [
    r.review_count ?? 0,
    r.place_id ? 1 : 0,
    -descriptorCount(r),
    r.name.length,
    -r.rowid,
  ];
  const sa = score(a), sb = score(b);
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return sa[i] > sb[i] ? a : b;
  }
  return a.rowid <= b.rowid ? a : b;
}

/** The capture columns a dropped row can donate to its survivor when the
 *  survivor is missing them — so merging never loses data (capture-everything
 *  policy). Returns only the fields to actually update. */
export function mergeRowFields(
  survivor: PoiRow,
  dropped: PoiRow,
): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  const sv0 = survivor as unknown as Record<string, unknown>;
  const dv0 = dropped as unknown as Record<string, unknown>;
  const fillStr = (k: 'phone' | 'website' | 'plus_code' | 'price_level' | 'types' | 'place_url' | 'place_id'): void => {
    const sv = sv0[k];
    const dv = dv0[k];
    if ((sv == null || sv === '') && dv != null && dv !== '') out[k] = dv as string;
  };
  for (const k of ['phone', 'website', 'plus_code', 'price_level', 'types', 'place_url', 'place_id'] as const) fillStr(k);
  if ((survivor.review_count ?? 0) === 0 && (dropped.review_count ?? 0) > 0) out.review_count = dropped.review_count ?? null;
  if (sv0.rating == null && dv0.rating != null) out.rating = dv0.rating as number;
  return out;
}

/** THE MERGE RULE — conservative by design. Returns merge:false with a reason
 *  for every pair we deliberately leave alone, so nothing is silently dropped. */
export function decideMerge(p: SuspectPair): MergeDecision {
  const { a, b, kind, distanceM } = p;
  const survivor = pickSurvivor(a, b);
  const dropped = survivor === a ? b : a;

  if (kind === 'same-phone') {
    return { merge: true, survivor, dropped, reason: 'same phone number — identity evidence' };
  }
  if (kind === 'same-place_id-different-name') {
    // The UNIQUE(place_id) index makes this impossible live, but if seen, the
    // shared id is proof of one place.
    return { merge: true, survivor, dropped, reason: 'shared place_id — one place, two spellings' };
  }
  // THE MALL/COMPLEX RULE: the container is the anchor; the shop inside it is
  // not relevant for serving. The mall always survives, regardless of reviews.
  if (isMallAnchor(a) && isContainedIn(a, b)) {
    return { merge: true, survivor: a, dropped: b, reason: `"${b.name}" is inside "${a.name}" — mall/complex is the anchor, interior POI not relevant for serving` };
  }
  if (isMallAnchor(b) && isContainedIn(b, a)) {
    return { merge: true, survivor: b, dropped: a, reason: `"${a.name}" is inside "${b.name}" — mall/complex is the anchor, interior POI not relevant for serving` };
  }
  if (kind === 'same-name-drifted') {
    if (distanceM <= SAME_NAME_MERGE_MAX_M) {
      return { merge: true, survivor, dropped, reason: `same name, ${distanceM}m apart — one place` };
    }
    return { merge: false, survivor, dropped, reason: `same name but ${distanceM}m apart — may be two branches; left for review` };
  }
  // dual-identified-near: merge only when the descriptor-stripped cores agree,
  // i.e. the longer name is the shorter plus generic words (bank/ATM/AD/…).
  const coreA = coreName(a.name);
  const coreB = coreName(b.name);
  if (coreA && coreA === coreB) {
    return { merge: true, survivor, dropped, reason: `same core name "${coreA}" (descriptors stripped) — one place` };
  }
  return { merge: false, survivor, dropped, reason: `names differ beyond descriptors ("${a.name}" vs "${b.name}") — likely distinct; left for review` };
}

export interface MergeComponent {
  survivor: PoiRow;
  dropped: PoiRow[];
  reasons: string[];
}

/** Union the merge edges (A~B, B~C → one component) and pick a single survivor
 *  per component. Returned sorted by survivor rowid for stable output. */
export function mergeComponents(pairs: SuspectPair[]): MergeComponent[] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (x: number, y: number): void => {
    if (!parent.has(x)) parent.set(x, x);
    if (!parent.has(y)) parent.set(y, y);
    const rx = find(x), ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  const byId = new Map<number, PoiRow>();
  const reasonsByPair = new Map<string, string>();

  for (const p of pairs) {
    byId.set(p.a.rowid, p.a);
    byId.set(p.b.rowid, p.b);
    const d = decideMerge(p);
    if (!d.merge) continue;
    union(p.a.rowid, p.b.rowid);
    reasonsByPair.set(`${p.a.rowid}|${p.b.rowid}`, d.reason);
  }

  const groups = new Map<number, number[]>();
  for (const id of byId.keys()) {
    const r = find(id);
    const arr = groups.get(r) ?? [];
    arr.push(id);
    groups.set(r, arr);
  }

  const out: MergeComponent[] = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const members = ids.map(id => byId.get(id)!);
    let survivor = members[0];
    for (const m of members.slice(1)) survivor = pickSurvivor(survivor, m);
    const reasons = pairs
      .filter(p => ids.includes(p.a.rowid) && ids.includes(p.b.rowid) && decideMerge(p).merge)
      .map(p => decideMerge(p).reason);
    out.push({ survivor, dropped: members.filter(m => m.rowid !== survivor.rowid), reasons: [...new Set(reasons)] });
  }
  out.sort((x, y) => x.survivor.rowid - y.survivor.rowid);
  return out;
}
