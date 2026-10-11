// THE WRITE-SIDE TRUST GUARD — "inside the Skopje bbox" is NOT evidence.
//
// THE HOLE THIS CLOSES (EB 73, 2026-09-03): backfill-geo stamped
// geo_source='google_cached' on any SerpApi coordinate inside the city bbox.
// A keyed probe on 2026-10-11 showed what Google actually answers for the
// queries the write side sends:
//
//   "АСНОМ 156, Skopje"      → title "Skopje", address "North Macedonia"
//                              gps 41.9981, 21.4254 — the CITY CENTRE
//                              (4.58 km from the real building). EB 73's pin.
//   "ХФГХФГХ, Skopje"        → place_results "Greater Skopje" / "North
//                              Macedonia" — a garbage query gets the region.
//   "ТЦ ОЛИМПИКО, Skopje"    → "Tire Shop Olimpiko", 8-mi Septemvri 38 —
//                              2.2 km from the real TC Olimpiko mall (which
//                              the POI table already knows!).
//   "БИСЕР, Skopje"          → "Pharmacy Biser", Jane Sandanski 82 — 44 m
//                              from the Biser POI. Correct.
//   "Владимир Назор бр.26-2" → "Central Loft Skopje", Vladimir Nazor 8 —
//                              right street, wrong number (~118 m).
//
// `engine=google_maps&type=search` answers with PLACES that match the query
// TEXT, not a geocode of the address. So three free checks on the response
// itself (plus two map cross-checks when the map has an opinion) separate
// evidence from luck:
//
//   0. bbox            — still required (a non-Skopje result is never trusted);
//   1. area-level      — the result's street line must not BE a city/country
//                        ("North Macedonia", "Greater Skopje"). A query Google
//                        could not place returns the region: that is exactly
//                        the EB 73 / EB 40 / РАМПА failure class;
//   2. query agreement — at least one significant token of the query must
//                        appear in the result's title+address (both folded to
//                        Latin: Cyrillic query vs Latin address is the norm);
//   3. street cross-check — if the offline map KNOWS the street, the pin must
//                        be within GUARD_MAX_DIST_M of a row on that street
//                        (EB 73: 3001 m → rejected);
//   4. POI cross-check  — if a POI's name contains the query, the pin must be
//                        within GUARD_MAX_DIST_M of it (TC Olimpiko: 2.2 km →
//                        rejected; БИСЕР: 44 m → trusted).
//
// A rejection never writes: the row stays osm_low_confidence / unlearned —
// the honest label for "we asked, but Google answered about something else".
// The reason string is returned so callers can log WHY.
//
// Also answers the precision question for the self-learning map:
// `exactBuilding` is true only when the query carried a house number AND the
// result's street line carries the SAME number — then (and only then) may a
// caller learnAddress() an exact building row; otherwise the honest learn is
// learnStreet() (a street ANCHOR, trusted at street level, never claiming a
// door number Google did not confirm).
//
// Pure: no DB, no network. The two map cross-checks arrive as optional
// distance functions, so the spec can feed them stubs and every rule stays
// testable without sqlite.

import { streetKey, extractHouseNum, toLatin, translitToLatin } from './offlineMap';

/** Max metres a trusted geocode may sit from the map's own opinion of the
 *  same street / same-named POI. Same cap the poison sweep uses for
 *  "cached landmark vs trusted center" (POISON_MAX_DIST_M) — one number for
 *  "these two points mean the same place". */
export const GUARD_MAX_DIST_M = 500;

/** A SerpApi geocode as the guard sees it: coordinates PLUS the matched
 *  result's own words. Callers that only forward {lat,lon} have no evidence
 *  to check and are rejected with 'no_evidence' — deliberately: that is the
 *  old bbox-only hole wearing a smaller coat. */
export interface GeocodeEvidence {
  lat: number;
  lon: number;
  /** local_results[0].title / place_results.title — what Google matched. */
  title?: string | null;
  /** local_results[0].address / place_results.address — where that match is. */
  address?: string | null;
}

/** Map cross-checks, injected so the core stays pure. Return null when the
 *  map has NO opinion (unknown street / no name-matching POI) — "no opinion"
 *  never rejects; only a DISAGREEMENT does. */
export interface GuardMapChecks {
  /** Metres from (lat,lon) to the nearest address row on the query's street,
   *  or null when the map does not know the street. */
  streetDistanceM?(query: string, lat: number, lon: number): number | null;
  /** Metres from (lat,lon) to the nearest POI whose name contains the
   *  query's normalized name, or null when no such POI exists. */
  poiDistanceM?(query: string, lat: number, lon: number): number | null;
}

export type GuardReason =
  | 'ok'
  | 'outside_bbox'
  | 'no_evidence'
  | 'area_level_result'      // Google answered with the city/country, not a place
  | 'query_mismatch'         // the matched result never mentions what we asked
  | 'street_disagreement'    // the map's street is hundreds of metres away
  | 'poi_disagreement';      // a same-named POI the map knows is far away

export interface GuardVerdict {
  /** True → the caller may stamp google_cached / learn the map from it. */
  trusted: boolean;
  reason: GuardReason;
  /** Human-readable detail for logs (always present). */
  detail: string;
  /** The query carried a house number AND the matched address repeats the
   *  SAME number → an exact building row may be learned. False for
   *  street-level evidence (right street, wrong/absent number) — learn a
   *  street anchor instead. */
  exactBuilding: boolean;
}

// ── Skopje bbox (same box queueDrain.insideBbox and serpCapture enforce) ─────
const BBOX = { latMin: 41.95, latMax: 42.05, lonMin: 21.35, lonMax: 21.50 };

/** City / country lines a "could not find it" Google answer comes back with.
 *  Matched against the result address's FIRST segment (its street line),
 *  number-free and Latin-folded. */
const AREA_LINES = new Set([
  'skopje', 'grad skopje', 'greater skopje', 'skopje 1000',
  'north macedonia', 'macedonia', 'makedonija', 'republic of north macedonia',
]);

/** Latin-fold + lowercase + collapse non-alnum to single spaces. */
export function normLine(s: string): string {
  return toLatin(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The street line of a Google address: everything before the first comma
 *  ("Vladimir Nazor 8, Skopje 1000, North Macedonia" → "Vladimir Nazor 8").
 *  Google always leads with the street for a real place match. */
export function streetLine(address: string | null | undefined): string {
  return (address ?? '').split(',')[0].trim();
}

/** True when the result's street line is a city/country rather than a street
 *  — the signature of "Google could not place this query and answered with
 *  the area instead". Numbers are dropped first so "Skopje 1000" folds to
 *  "skopje". */
export function isAreaLine(line: string): boolean {
  const n = normLine(line).replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n) return true;                    // empty line — no street evidence at all
  if (AREA_LINES.has(n)) return true;
  // "Severna Makedonija" is what toLatin() makes of "Северна Македонија"
  // (the suffix street-teach appends), "North Macedonia" is Google's English.
  if (/(^| )(severna |north |republic of )*(macedon|makedon)(ia|ija)$/.test(n)) return true;
  return false;
}

/** Words callers APPEND to the query (", Skopje" / ", Скопје, Северна
 *  Македонија") — they appear in EVERY Google answer and would make rule 2
 *  agree with anything. Excluded from the query side only; the result side
 *  keeps them so a real street match still has "skopje" to be seen in. */
const QUERY_STOP = new Set([
  'skopje', 'severna', 'makedonija', 'macedonia', 'north', 'republic',
  'republicof',
]);

/** The query with a trailing city/country segment removed — street-teach
 *  sends "<street>, Скопје, Северна Македонија" and backfill "<address>, Skopje".
 *  The guard must reason about the STREET the query names, not about the
 *  suffix every caller appends (otherwise the street cross-check could never
 *  fire for taught streets). Only trailing segments that ARE area lines are
 *  dropped, so a real street segment is never lost. */
export function sanitizeQuery(query: string): string {
  const parts = query.split(',').map(p => p.trim()).filter(p => p.length > 0);
  while (parts.length > 1 && isAreaLine(parts[parts.length - 1])) parts.pop();
  return parts.join(', ');
}

/** Significant query tokens for rule 2: the street key (house number and
 *  "ул./бр." prefixes already stripped), the all-alnum toLatin fold, and the
 *  English-style transliteration (ч→ch, ш→sh, ж→zh) Google actually writes.
 *  Keeping only tokens of ≥ 4 chars that are not pure digits and not the
 *  city/country suffix every query carries.
 *
 *  Both transliterations matter: "Мирче Оровчанец" folds to "mirce orovcanec"
 *  one way and "mirce orovchanec" the other — Google writes the latter. */
export function queryTokens(query: string): string[] {
  const q = sanitizeQuery(query);
  const folds = [streetKey(q), normLine(q), normLine(translitToLatin(q))];
  const out = new Set<string>();
  for (const f of folds) {
    for (const t of f.split(/\s+/)) {
      if (t.length >= 4 && !/^\d+$/.test(t) && !QUERY_STOP.has(t)) out.add(t);
    }
  }
  return [...out];
}

/** The result's title+address under BOTH folds (see queryTokens). */
function resultTexts(ev: GeocodeEvidence): string[] {
  const raw = `${ev.title ?? ''} ${ev.address ?? ''}`;
  const eng = translitToLatin(raw).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [normLine(raw), eng];
}

/** Rule 2 — does the matched result's title+address mention what we asked?
 *  Both sides are Latin-folded, so a Cyrillic query ("АСНОМ") meets a Latin
 *  Google address ("Asnom") on equal ground. */
function agreesWithQuery(query: string, ev: GeocodeEvidence): boolean {
  const toks = queryTokens(query);
  if (toks.length === 0) return true;     // nothing to verify (all-tiny tokens) — rule 1 still guards
  const texts = resultTexts(ev);
  if (!texts.some(t => t.length > 0)) return false;   // words we asked about, silence back
  return toks.some(tok => texts.some(t => t.includes(tok)));
}

/** Parse the SerpApi `engine=google_maps&type=search` payload into evidence.
 *  local_results[0] when Google found places; place_results when it fell back
 *  to a single knowledge-panel place (the garbage-query shape). Returns null
 *  when there are no coordinates — a miss, never a coordinate. */
export function extractGeocodeEvidence(data: any): GeocodeEvidence | null {
  const lr = data?.local_results?.[0];
  if (lr?.gps_coordinates?.latitude && lr?.gps_coordinates?.longitude) {
    return {
      lat: lr.gps_coordinates.latitude,
      lon: lr.gps_coordinates.longitude,
      title: lr.title ?? null,
      address: lr.address ?? null,
    };
  }
  const pr = data?.place_results;
  if (pr?.gps_coordinates?.latitude && pr?.gps_coordinates?.longitude) {
    return {
      lat: pr.gps_coordinates.latitude,
      lon: pr.gps_coordinates.longitude,
      title: pr.title ?? null,
      address: pr.address ?? null,
    };
  }
  return null;
}

/** THE GUARD. Every path that wants to stamp `google_cached` — or teach the
 *  offline map from a paid geocode — runs the evidence through here first.
 *
 *  Order matters: cheap pure checks first, map cross-checks only when the
 *  cheap ones passed (a city-level answer is rejected before we go looking
 *  for streets to disagree with). */
export function assessGeocode(
  query: string,
  ev: GeocodeEvidence | null,
  map?: GuardMapChecks,
): GuardVerdict {
  const base = (trusted: boolean, reason: GuardReason, detail: string, exactBuilding = false): GuardVerdict =>
    ({ trusted, reason, detail, exactBuilding });

  // 0. bbox — never trusted outside Skopje (unchanged from the old guard).
  if (!ev) return base(false, 'no_evidence', 'geocoder returned no coordinates');
  if (!(ev.lat >= BBOX.latMin && ev.lat <= BBOX.latMax
     && ev.lon >= BBOX.lonMin && ev.lon <= BBOX.lonMax)) {
    return base(false, 'outside_bbox', `(${ev.lat}, ${ev.lon}) outside Skopje bbox`);
  }

  // Evidence = the matched result's own words. Coordinates alone prove
  // nothing: that IS the hole (bbox-only labelling).
  const words = `${ev.title ?? ''} ${ev.address ?? ''}`.trim();
  if (!words) {
    return base(false, 'no_evidence', 'matched result carries neither title nor address');
  }

  // 1+2. WHERE Google answered, and WHETHER it answered about OUR query —
  //    both read off the matched result's own words:
  //    • area-level result + no agreement = "could not find it, here is the
  //      city" — the EB 73 / EB 40 / РАМПА class (4.58 km off, yet trusted);
  //    • non-area but no agreement = a real place, just NOT the one asked for
  //      (the TC Olimpiko → tire shop class).
  //    Exception: a STREET-typed result often carries the street in its title
  //    with a city-only address ("Some Street" / "Skopje, North Macedonia") —
  //    that IS agreement, so area alone only rejects when the words also fail.
  const q = sanitizeQuery(query);
  const line = streetLine(ev.address);
  const agree = agreesWithQuery(q, ev);
  if (isAreaLine(line) && !agree) {
    return base(false, 'area_level_result',
      `result is area-level: "${ev.title ?? ''}" / "${ev.address ?? ''}"`);
  }
  if (!agree) {
    return base(false, 'query_mismatch',
      `"${ev.title ?? ''}" / "${ev.address ?? ''}" does not mention "${q}"`);
  }

  // Building precision: the query asked for a NUMBER and Google's own
  // address line repeats that same number. Anything less is street-level
  // evidence — learnable as an anchor, never as an exact building.
  const qNum = extractHouseNum(q);
  const rNum = extractHouseNum(line);
  const exactBuilding = !!qNum && qNum === rNum;

  // 3. street cross-check — the map knows this street; does Google's pin
  //    actually sit on it? (EB 73: 3001 m from АСНОМ's rows → rejected.)
  if (map?.streetDistanceM) {
    const d = map.streetDistanceM(q, ev.lat, ev.lon);
    if (d != null && d > GUARD_MAX_DIST_M) {
      return base(false, 'street_disagreement',
        `pin is ${Math.round(d)} m from the map's "${streetKey(q)}" rows (max ${GUARD_MAX_DIST_M} m)`);
    }
  }

  // 4. POI cross-check — a POI whose name contains the query exists, so the
  //    name IS resolvable locally; a pin far from it matched something else
  //    (TC Olimpiko → the tire shop, 2.2 km). 44 m (БИСЕР) passes.
  if (map?.poiDistanceM) {
    const d = map.poiDistanceM(q, ev.lat, ev.lon);
    if (d != null && d > GUARD_MAX_DIST_M) {
      return base(false, 'poi_disagreement',
        `pin is ${Math.round(d)} m from the map's same-named POI (max ${GUARD_MAX_DIST_M} m)`);
    }
  }

  return base(true, 'ok',
    `trusted: "${ev.title ?? ''}" / "${ev.address ?? ''}"${exactBuilding ? ' (exact building)' : ' (street level)'}`,
    exactBuilding);
}
