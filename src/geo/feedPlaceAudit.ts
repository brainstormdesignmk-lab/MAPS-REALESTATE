// THE FEED'S OWN GEOGRAPHY, CHECKED AGAINST THE MAP.
//
// Every listed flat must RESOLVE to a real map place before the funnel can
// honestly say «во близина на …» or anchor a search on the address the client
// named. Three things make that true, and each one is checked here from the
// feed's OWN fields — never from a fresh geocode, so the report says what the
// bot will actually read:
//
//   • ADDRESS — must resolve in the shipped map through the same resolver the
//     import queue uses (exact building → interpolation → Google-verified
//     street anchor). A feed address that is a PLACE NAME («ТЦ ОЛИМПИКО»,
//     «БИСЕР») is resolved as that place; anything else that resolves nowhere
//     is a violation, because no map row can ever anchor it.
//   • LANDMARK — every stored entry must BE a map POI, compared FOLD-EQUAL
//     (punctuation, case and spacing ignored). Containment is not enough:
//     «Скопјанка» is a shop word that also sits inside «ТЦ Скопјанка», and a
//     landmark the map does not actually hold is a name the bot can never
//     measure, link or rotate to.
//   • DISTANCE — when the row carries its own pin, the stored `distance_m` is
//     re-measured against the map's pin for that landmark. Disagreement is
//     DRIFT, not a violation: a coarse stored pin legitimately moves the
//     number, and the operator should see it without the sweep failing.
//
// A row with no address is a violation (nothing can resolve it). A row with no
// pin is a warning (the flat still serves a landmark, but its distances cannot
// be confirmed). An empty landmark list is NOT a violation — the honest
// neighbourhood line is the documented answer, as in audit-feed-landmarks.

import { distM } from './precision';
import { translitToLatin } from './offlineMap';

/** The two map capabilities this audit needs. `OfflineMapStore` satisfies it
 *  structurally, so the sweep runs against the shipped map and a test can run
 *  against a tiny fixture map. */
export interface FeedPlaceMap {
  geocodeAddress(address: string): { lat: number; lon: number; street?: string } | undefined;
  findPoisByName(name: string, limit?: number): Array<{ name: string; lat: number; lon: number }>;
}

export type FeedPlaceIssueKind =
  | 'no-address'          // the row carries no address at all
  | 'address-unresolved'  // the address matches no building, street or POI
  | 'landmark-no-name'    // an entry with an empty name
  | 'landmark-not-on-map';// a named landmark the map does not hold

export type FeedPlaceWarningKind =
  | 'no-pin'              // the row has no coordinates — distances uncheckable
  | 'distance-drift';     // stored distance disagrees with the map's own pins

export interface FeedPlaceIssue {
  eb: string;
  kind: FeedPlaceIssueKind;
  detail: string;
}

export interface FeedPlaceWarning {
  eb: string;
  kind: FeedPlaceWarningKind;
  detail: string;
}

export interface FeedPlaceReport {
  properties: number;
  /** Rows that carry an address (the rest are `no-address` issues). */
  addressed: number;
  /** Rows whose address resolved to a real map place (address row OR POI). */
  resolved: number;
  resolvedAsPlace: number;
  landmarkEntries: number;
  landmarksOnMap: number;
  issues: FeedPlaceIssue[];
  warnings: FeedPlaceWarning[];
}

/** One spelling for name comparison: punctuation, case and spacing ignored.
 *  «ТЦ Скопјанка», «тц скопјанка» and «ТЦ  Скопјанка» are one name. */
export function foldPlaceName(s: string): string {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
}

/** Is the FEED's stored landmark the MAP's row — across scripts and a trailing
 *  qualifier, but never across a different place?
 *
 *  The live feed stores names in Macedonian Cyrillic while the map holds what
 *  Google and OSM hold (~38% Latin-only): «Комерцијална банка» vs «Komercijalna
 *  Banka AD Skopje» is the SAME bank, and a plain string compare called it a
 *  missing place. Two rules, both learned in the handler's coverage guard:
 *    1. the map name must OPEN with one of the stored words — a brand put in
 *       front («ТЦ Скопјанка» for «Скопјанка», «ELS Novo Lisice» for «Novo
 *       Lisice») is a DIFFERENT place, not an abbreviation of this one;
 *    2. the stored words must sit CONTIGUOUSLY in the map name, in order, so a
 *       qualifier may be dropped or added at either end («… AD Skopje», «…
 *       Аптека») while a substituted word is never accepted.
 *  Both sides are folded to the Latin letter class first, so the comparison is
 *  one spelling rather than two scripts. */
export function samePlace(stored: string, mapName: string): boolean {
  const tok = (s: string): string[] => foldPlaceName(translitToLatin(s)).split(' ').filter(Boolean);
  const a = tok(stored);
  const b = tok(mapName);
  if (a.length === 0 || b.length === 0) return false;
  if (!a.includes(b[0]!)) return false;
  for (let i = 0; i + a.length <= b.length; i++) {
    if (a.every((w, k) => b[i + k] === w)) return true;
  }
  return false;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Default disagreement cap. A stored pin from OSM buildings and the map's own
 *  pin for the same landmark routinely differ by a block; 200 m separates
 *  "same place, coarser pin" from "this is another place". */
export const FEED_PLACE_DRIFT_M = 200;

export function auditFeedPlaces(
  rows: Array<Record<string, unknown>>,
  map: FeedPlaceMap,
  opts: { driftM?: number } = {},
): FeedPlaceReport {
  const driftM = opts.driftM ?? FEED_PLACE_DRIFT_M;
  const report: FeedPlaceReport = {
    properties: rows.length,
    addressed: 0,
    resolved: 0,
    resolvedAsPlace: 0,
    landmarkEntries: 0,
    landmarksOnMap: 0,
    issues: [],
    warnings: [],
  };

  for (const r of rows) {
    const eb = String(r.evidenten_broj ?? r.eb ?? '?');
    // THE FEED'S OWN FIELD NAME (found by this sweep): public-properties ships
    // the street as `adresa` (and the quarter as `naselba`), never `address`.
    // Reading only `address` reported all 44 live flats as "no address" — a
    // clean-looking sweep that checked nothing. Both spellings are accepted so
    // a fixture and the live payload audit identically.
    const address = (str(r.address) || str(r.adresa)).trim();
    const lat = num(r.lat);
    const lon = num(r.lon);
    const hasPin = lat !== undefined && lon !== undefined && lat !== 0 && lon !== 0;

    // ── ADDRESS ────────────────────────────────────────────────────────────
    if (!address) {
      report.issues.push({ eb, kind: 'no-address', detail: 'the row carries no address' });
    } else {
      report.addressed++;
      const geo = map.geocodeAddress(address);
      if (geo) {
        report.resolved++;
      } else {
        // A PLACE NAME IS A REAL MAP PLACE (the «БИСЕР» / «ТЦ ОЛИМПИКО»
        // family): the feed files some addresses as the complex itself. Accept
        // it only on a FOLD-EQUAL name, so «Скопјанка» still never passes for
        // «ТЦ Скопјанка».
        const exact = map.findPoisByName(address, 12)
          .find(c => samePlace(address, c.name));
        if (exact) {
          report.resolved++;
          report.resolvedAsPlace++;
        } else {
          report.issues.push({
            eb, kind: 'address-unresolved',
            detail: `„${address}“ matches no building, street or place in the map`,
          });
        }
      }
    }

    // ── LANDMARKS ──────────────────────────────────────────────────────────
    const list = Array.isArray(r.landmarks) ? r.landmarks as Array<Record<string, unknown>> : [];
    for (let i = 0; i < list.length; i++) {
      report.landmarkEntries++;
      const name = str(list[i]?.landmark).trim();
      if (!name) {
        report.issues.push({ eb, kind: 'landmark-no-name', detail: `entry #${i + 1} has no name` });
        continue;
      }
      // CHAIN BRANCHES ARE ONE NAME (the live feed's «Зегин», «KAM маркет»,
      // «Комерцијална банка»): a bank or pharmacy exists at many addresses, and
      // the feed stores the distance to the NEAREST branch. Comparing against
      // whichever row the name lookup happened to return first reported 6 km of
      // "drift" for a flat whose branch sits 10 m away. Every covering row is
      // kept; existence is the first, distance is the nearest.
      const cands = map.findPoisByName(name, 12).filter(c => samePlace(name, c.name));
      if (cands.length === 0) {
        report.issues.push({
          eb, kind: 'landmark-not-on-map',
          detail: `#${i + 1} „${name}“ is not a map place — it can never be measured or named`,
        });
        continue;
      }
      report.landmarksOnMap++;
      // Distance is a CLAIM only when the row has its own pin to measure from.
      const claimed = num(list[i]?.distance_m);
      if (claimed !== undefined && hasPin) {
        const measured = Math.min(...cands.map(c => distM(lat as number, lon as number, c.lat, c.lon)));
        if (Math.abs(measured - claimed) > driftM) {
          report.warnings.push({
            eb, kind: 'distance-drift',
            detail: `#${i + 1} „${name}“ stored ${Math.round(claimed)} m, map says ${Math.round(measured)} m`,
          });
        }
      }
    }

    if (!hasPin) {
      report.warnings.push({ eb, kind: 'no-pin', detail: 'no coordinates — distances cannot be confirmed' });
    }
  }

  return report;
}
