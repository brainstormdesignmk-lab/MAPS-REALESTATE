// IDENTITY BACKFILL — give an EXISTING map row the Google identity of the
// same physical place, one name search per row.
//
// Why this exists: the tile pass captures places Google returns for 15
// categories, so a row that Google never lists under one of those categories
// (or that OSM knows and Google's category search did not surface) stays
// `place_id IS NULL` forever. Those are exactly the rows a client hears: within
// 200 m of the 44 live properties, 464 of 629 landmark candidates had no
// identity. Without identity:
//   • prominence is 0, so the busiest branch can never win a tie;
//   • `closed` is unknown, so a permanently closed pharmacy keeps being served;
//   • two rows for one building never merge (the rotation spends two slots on
//     one place under two names).
//
// THE ACCEPTANCE RULE IS THE READER'S RULE (`samePlacePoi`), not a second fuzzy
// matcher: whatever the map build would merge is what this pass may stamp.
// Everything it refuses is REPORTED, never guessed — a wrong identity merges
// two different places and is worse than no identity at all.
//
// The pin is never moved here. A Google coordinate may refine a map pin, but
// that decision belongs to the capture path with its drift guard
// (captureMayMovePin); this pass only attaches identity and the fields that
// ride with it.

import type Database from 'better-sqlite3';
import { typeRank } from './types';
import { samePlacePoi, type MergedPoi } from './offlineMap';
import { distM } from './precision';
import { insideSkopjeBbox } from './serpCapture';

/** How far from a live property a row still counts as a landmark it may hear
 *  about. Mirrors the feed writer's own pool (FEED_LANDMARK_MAX_M = 500 in
 *  inbound_final, but the FIRST candidate is always inside 200 m). */
export const POOL_RADIUS_M = 200;

/** How far the Google answer may stand from the row it is claiming to be.
 *  Two encodings of one building differ by tens of metres (OSM building
 *  footprint vs Google's roof pin); 200 m still rejects the same name in
 *  another quarter — the «Кипер Маркет» family has ~20 branches in Skopje. */
export const MATCH_RADIUS_M = 200;

/** THE TIGHT TIER. Google answers a Skopje landmark query in Latin
 *  («Институт за хемија» → «Institute of Chemistry» 20 m away, «Правен
 *  факултет „Јустинијан Први“» → «Iustinianus Primus Faculty of Law» 23 m),
 *  and a token-set comparison can never see through a translation. Within one
 *  building footprint the query itself is the evidence: the top hit for the
 *  row's exact name, ≤60 m away, in an anchor class on BOTH sides (rank ≥3).
 *  That gate also kills Google's city fallback — a «Skopje» result is typed
 *  as a city (rank 0), so it can never take the tight tier no matter how close
 *  it lands. It is not a loose radius: 60 m is one building, and the class
 *  rule is what keeps a café row from borrowing its neighbour's identity. */
export const TIGHT_MATCH_M = 60;
/** The lowest typeRank that counts as a navigation anchor for the tight tier
 *  (artwork/monument at 3 and up: church 4, park 4, university 4, square 5). */
export const TIGHT_MIN_RANK = 3;

/** The classes that decide the FIRST landmark (tier 4–5 in types.ts) and that
 *  the 15-category tile grid either covers weakly or not at all. A church, a
 *  park, a faculty, a pazar, a police station, the municipality, the court —
 *  "кај Католичка", "спроти паркот", "кај општината" — and every one of them
 *  is OSM-only in this map today. */
export const ANCHOR_CLASSES = [
  'place_of_worship', 'church', 'cathedral', 'mosque',
  'park', 'university', 'market', 'marketplace',
  'police', 'townhall', 'courthouse',
] as const;

/** A name worth spending a search on: real letters, not a placeholder. OSM
 *  rows carry «Непозната», «unknown», «-» and bare numbers. */
export function isLandmarkName(name: string): boolean {
  const s = String(name ?? '').trim();
  if (s.length < 3) return false;
  if (!/\p{L}{2}/u.test(s)) return false;
  if (/^(?:непознат\p{L}*|unknown|n\/?a|tbd|-+|\.+)$/iu.test(s)) return false;
  return true;
}

export interface IdentityOrigin { lat: number; lon: number; }

export interface IdentityTarget {
  rowid: number;
  name: string;
  type: string;
  lat: number;
  lon: number;
  /** 'pool' = a landmark candidate within POOL_RADIUS_M of a live property;
   *  'class' = a named row of an ANCHOR_CLASSES class anywhere in the city. */
  group: 'pool' | 'class';
  /** Metres to the nearest live property ('pool' only, else Infinity). */
  nearestPropertyM: number;
}

interface RawRow { rowid: number; name: string; type: string; lat: number; lon: number; place_id: string | null; }

/** Every row that needs an identity, in the order worth spending on:
 *  landmarks the live feed can actually hear first (nearest property first),
 *  then the city-wide anchor classes. Rows with identity are never selected;
 *  neither are shops (typeRank 0) — a boutique is not a landmark. */
export function selectIdentityTargets(
  db: Database.Database,
  opts: { origins: IdentityOrigin[]; radius?: number; classes?: readonly string[]; limit?: number },
): IdentityTarget[] {
  const radius = opts.radius ?? POOL_RADIUS_M;
  const classes = new Set((opts.classes ?? ANCHOR_CLASSES).map(c => c.toLowerCase()));
  const picked = new Map<number, IdentityTarget>();

  // POOL: bounded box per property, exact distance check after.
  const dLat = radius / 111_320;
  const stmt = db.prepare(
    `SELECT rowid, name, type, lat, lon, place_id FROM pois
      WHERE place_id IS NULL AND lat IS NOT NULL AND lon IS NOT NULL
        AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`,
  );
  for (const o of opts.origins) {
    if (!Number.isFinite(o.lat) || !Number.isFinite(o.lon)) continue;
    const dLon = radius / (111_320 * Math.max(0.2, Math.cos((o.lat * Math.PI) / 180)));
    const rows = stmt.all(o.lat - dLat, o.lat + dLat, o.lon - dLon, o.lon + dLon) as RawRow[];
    for (const r of rows) {
      if (typeRank(r.type) <= 0 || !isLandmarkName(r.name)) continue;
      const d = distM(o.lat, o.lon, r.lat, r.lon);
      if (d > radius) continue;
      const prev = picked.get(r.rowid);
      if (prev && prev.nearestPropertyM <= d) continue;
      picked.set(r.rowid, {
        rowid: r.rowid, name: r.name, type: r.type, lat: r.lat, lon: r.lon,
        group: 'pool', nearestPropertyM: d,
      });
    }
  }

  // CLASSES: city-wide named anchors of the thin classes.
  const all = db.prepare(
    `SELECT rowid, name, type, lat, lon, place_id FROM pois
      WHERE place_id IS NULL AND lat IS NOT NULL AND lon IS NOT NULL`,
  ).all() as RawRow[];
  for (const r of all) {
    if (picked.has(r.rowid)) continue;
    if (!classes.has(String(r.type ?? '').trim().toLowerCase())) continue;
    if (!isLandmarkName(r.name)) continue;
    if (!typeRank(r.type)) continue;
    picked.set(r.rowid, {
      rowid: r.rowid, name: r.name, type: r.type, lat: r.lat, lon: r.lon,
      group: 'class', nearestPropertyM: Infinity,
    });
  }

  const out = [...picked.values()].sort((a, b) =>
    (a.group === b.group ? 0 : a.group === 'pool' ? -1 : 1)
    // THE FEED'S OWN ORDER: a rank-5 anchor is heard before a rank-2 shop, so
    // when the budget runs out it has been spent on the names that matter.
    || typeRank(b.type) - typeRank(a.type)
    || a.nearestPropertyM - b.nearestPropertyM
    || a.name.localeCompare(b.name));
  return typeof opts.limit === 'number' && opts.limit >= 0 ? out.slice(0, opts.limit) : out;
}

/** Is there already an identified row for this place? Two rows for one building
 *  (a Cyrillic OSM row and its Google twin, or three Ramstor spellings) need
 *  ONE identity: the reader merges them by the same rule, and a second search
 *  would spend quota to learn what the neighbouring row already knows. */
export function hasIdentifiedTwin(db: Database.Database, target: IdentityTarget): boolean {
  const dLat = MATCH_RADIUS_M / 111_320;
  const dLon = MATCH_RADIUS_M / (111_320 * Math.max(0.2, Math.cos((target.lat * Math.PI) / 180)));
  const rows = db.prepare(
    `SELECT name, type, lat, lon, place_id FROM pois
      WHERE place_id IS NOT NULL AND rowid != ?
        AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`,
  ).all(target.rowid, target.lat - dLat, target.lat + dLat, target.lon - dLon, target.lon + dLon) as RawRow[];
  const a: MergedPoi = { name: target.name, type: target.type, lat: target.lat, lon: target.lon, dist: 0 };
  return rows.some(r => samePlacePoi(a, {
    name: r.name, type: r.type, lat: r.lat, lon: r.lon,
    dist: distM(a.lat, a.lon, r.lat, r.lon), place_id: r.place_id ?? undefined,
  }).same);
}

/** What a SerpApi place carries that the map wants. Structurally compatible
 *  with serpCapture.CapturedPoi, declared here so the rule can be tested
 *  without the network. */
export interface IdentityCapture {
  name: string;
  /** Google's own type for the place («Church», «University», «City»…). The
   *  tight tier needs it: a city fallback is typed as a city, so it can never
   *  borrow an anchor's identity however close it lands. */
  type?: string | null;
  lat: number;
  lon: number;
  place_id: string | null;
  review_count: number | null;
  rating: number | null;
  plus_code: string | null;
  phone: string | null;
  website: string | null;
  closed: number;
  types: string | null;
}

export type IdentityVerdict =
  | { ok: true }
  | { ok: false; why: 'no-identity' | 'outside-bbox' | 'too-far' | 'not-same-place'; movedM?: number };

/** The one acceptance rule. Same building, inside Skopje, with an identity to
 *  write — otherwise refused with a reason the operator can read. */
export function acceptIdentity(target: IdentityTarget, cap: IdentityCapture): IdentityVerdict {
  // No identity = nothing to write. The search may still be a real match, but
  // stamping name-only fields onto a row is exactly the guess this refuses.
  if (!cap.place_id) return { ok: false, why: 'no-identity' };
  if (!insideSkopjeBbox(cap.lat, cap.lon)) return { ok: false, why: 'outside-bbox' };
  const movedM = distM(target.lat, target.lon, cap.lat, cap.lon);
  if (movedM > MATCH_RADIUS_M) return { ok: false, why: 'too-far', movedM: Math.round(movedM) };
  // TIGHT TIER first: same building, both sides an anchor class — the name may
  // be a translation (see TIGHT_MATCH_M).
  if (movedM <= TIGHT_MATCH_M
    && typeRank(target.type) >= TIGHT_MIN_RANK
    && typeRank(cap.type ?? '') >= TIGHT_MIN_RANK) {
    return { ok: true };
  }
  const a: MergedPoi = { name: target.name, type: target.type, lat: target.lat, lon: target.lon, dist: 0 };
  const b: MergedPoi = {
    name: cap.name, type: cap.type ?? target.type, lat: cap.lat, lon: cap.lon, dist: movedM,
    place_id: cap.place_id,
  };
  if (!samePlacePoi(a, b).same) return { ok: false, why: 'not-same-place', movedM: Math.round(movedM) };
  return { ok: true };
}

/** Attach the identity to the row. Lat/lon are deliberately absent from the
 *  UPDATE (see the header). Idempotent: a row that already has an identity is
 *  never rewritten by a second pass.
 *
 *  ONE IDENTITY, ONE ROW. `pois.place_id` is UNIQUE (the build's own rule: two
 *  rows for one place are a duplicate to merge, not a copy to stamp), so when
 *  the same place_id already sits on another row — a Google twin under a
 *  different spelling — this returns 'identity-taken' and writes NOTHING.
 *  The live pass died on this constraint once; a refusal is the correct
 *  behaviour, and the reader's twin merge already unifies the pair. */
export function writeIdentity(
  db: Database.Database,
  target: IdentityTarget,
  cap: IdentityCapture,
): 'written' | 'already-identified' | 'identity-taken' | 'unknown-row' {
  const cur = db.prepare('SELECT place_id FROM pois WHERE rowid = ?').get(target.rowid) as
    | { place_id: string | null } | undefined;
  if (!cur) return 'unknown-row';
  if (cur.place_id) return 'already-identified';
  const holder = db.prepare('SELECT rowid FROM pois WHERE place_id = ?').get(cap.place_id) as
    | { rowid: number } | undefined;
  if (holder && holder.rowid !== target.rowid) return 'identity-taken';
  db.prepare(
    `UPDATE pois SET place_id = ?, review_count = ?, rating = ?, plus_code = ?,
       phone = ?, website = ?, closed = ?, types = ?
     WHERE rowid = ? AND place_id IS NULL`,
  ).run(
    cap.place_id, cap.review_count, cap.rating, cap.plus_code,
    cap.phone, cap.website, cap.closed, cap.types, target.rowid,
  );
  return 'written';
}

/** Coverage in the two pools this pass exists for, so a run can be judged by
 *  the map's state rather than by its own log line. */
export function identityCoverage(
  db: Database.Database,
  opts: { origins: IdentityOrigin[]; radius?: number; classes?: readonly string[] },
): { totalCandidates: number; withIdentity: number; poolMissing: number; classMissing: number } {
  const radius = opts.radius ?? POOL_RADIUS_M;
  const classes = new Set((opts.classes ?? ANCHOR_CLASSES).map(c => c.toLowerCase()));
  const dLat = radius / 111_320;
  const stmt = db.prepare(
    `SELECT rowid, name, type, lat, lon, place_id FROM pois
      WHERE lat IS NOT NULL AND lon IS NOT NULL
        AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`,
  );
  const seen = new Set<string>();
  let totalCandidates = 0;
  let withIdentity = 0;
  let poolMissing = 0;
  for (const o of opts.origins) {
    if (!Number.isFinite(o.lat) || !Number.isFinite(o.lon)) continue;
    const dLon = radius / (111_320 * Math.max(0.2, Math.cos((o.lat * Math.PI) / 180)));
    for (const r of stmt.all(o.lat - dLat, o.lat + dLat, o.lon - dLon, o.lon + dLon) as RawRow[]) {
      if (typeRank(r.type) <= 0 || !isLandmarkName(r.name)) continue;
      if (distM(o.lat, o.lon, r.lat, r.lon) > radius) continue;
      const key = `${r.rowid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      totalCandidates++;
      if (r.place_id) withIdentity++;
      else poolMissing++;
    }
  }
  const classRows = db.prepare(
    `SELECT name, type, place_id FROM pois WHERE lat IS NOT NULL AND lon IS NOT NULL`,
  ).all() as Array<{ name: string; type: string; place_id: string | null }>;
  let classMissing = 0;
  for (const r of classRows) {
    if (!classes.has(String(r.type ?? '').trim().toLowerCase())) continue;
    if (!isLandmarkName(r.name) || !typeRank(r.type)) continue;
    if (!r.place_id) classMissing++;
  }
  return { totalCandidates, withIdentity, poolMissing, classMissing };
}
