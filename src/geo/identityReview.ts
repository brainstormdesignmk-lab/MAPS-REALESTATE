/**
 * ADJUDICATING A REFUSED IDENTITY — WHICH SIDE HOLDS THE WRONG POINT?
 *
 * `backfill-identity` refuses an identity when Google's candidate is too far
 * from the map row (`movedM` > 200 m) or its name does not bind. The refusal is
 * usually right (a bank's other branch, a settlement that shares a name, a
 * translated name) and occasionally a real map defect (a pin planted a
 * kilometre off). The operator's review has to separate the two without paying
 * for evidence it already has, so this module decides the question from the
 * MAP's own witnesses first:
 *
 *   covered       an identified row 0–200 m already carries the place (the
 *                 reader merges the pair) — nothing to fix.
 *   branch        the candidate's name is already a KNOWN row somewhere else in
 *                 the map, so the search matched that branch — nothing to fix.
 *   generic-name  every word the two names share is a KIND (café, market,
 *                 mosque, municipality) — the names do not identify one place.
 *   corroborated  the map's own address fabric (`addresses`, OSM house
 *                 numbers) has a house number within 40 m of the row's pin —
 *                 the pin sits on a real building, so the row is where it says.
 *   verify        none of the above: the row's location is unsupported by any
 *                 free witness, so ONE paid search buys the missing evidence.
 *
 * After that search the candidate's ADDRESS decides it: Google names a street
 * and house number, our address table turns it into a coordinate, and the two
 * distances (from Google's pin, from the map's pin) say whose placement the
 * address agrees with. The order of the two numbers is the whole verdict.
 */
import { GENERIC_VENUE_TOKENS, identityTokens, streetKey } from './offlineMap';
import { CAPTURE_PIN_DRIFT_M, distM } from './precision';

export interface DriftRow {
  rowid: number;
  name: string;
  type: string;
  lat: number;
  lon: number;
}

export interface DriftCandidate {
  name: string;
  type?: string | null;
  lat?: number | null;
  lon?: number | null;
  address?: string | null;
  placeId?: string | null;
}

/** What the free map evidence says about one refused row. */
export interface FreeWitness {
  /** Identified rows within the pool radius that agree with the ROW's name. */
  twins: Array<{ name: string; d: number }>;
  /** An identified row somewhere in the map that agrees with the CANDIDATE's name. */
  branch?: { name: string; d: number } | null;
  /** Metres to the nearest house number in the map's address fabric. */
  nearestAddressM?: number | null;
  nearestAddress?: { street: string; housenumber: string } | null;
}

export type DriftAction =
  | 'leave'
  | 'verify'
  | 'fix-pin'
  | 'inconclusive';

export type DriftReason =
  | 'covered'
  | 'branch'
  | 'generic-name'
  | 'address-corroborated'
  | 'unanchored'
  | 'address-agrees-with-map-pin'
  | 'address-agrees-with-candidate-pin'
  | 'address-unknown'
  | 'address-does-not-fit-candidate'
  | 'candidate-too-far'
  | 'no-candidate-position';

export interface DriftDecision {
  action: DriftAction;
  reason: DriftReason;
  /** Operator-facing sentence: the evidence, in metres and street names. */
  detail: string;
  /** For `fix-pin`: where the address says the place is. */
  to?: { lat: number; lon: number };
}

/** A house number this close to a pin is the building the pin means. */
export const PIN_CORROBORATED_M = 40;
/** Two pin candidates on the same house number are the same building. */
export const SAME_ADDRESS_M = 100;
/** The identity pool radius — the distance at which a twin "is" the row. */
export const COVER_RADIUS_M = 200;

/** The words the two names have in common, folded (order and script ignored). */
export function sharedTokens(rowName: string, candidateName: string): string[] {
  const a = new Set(identityTokens(rowName));
  return [...new Set(identityTokens(candidateName).filter(t => a.has(t)))];
}

/** Does the shared part of the two names carry any identity at all? True when
 *  they share NOTHING, or share only KIND words («Caffe Skopje» folds to
 *  {caffe}) — either way the names cannot prove one place. */
export function sharedNameless(rowName: string, candidateName: string): boolean {
  return !sharedTokens(rowName, candidateName).some(t => t.length >= 4 && !GENERIC_VENUE_TOKENS.has(t));
}

const fmt = (d: number): string => `${Math.round(d)}m`;

/** DECIDE FROM FREE EVIDENCE. `verify` is the only outcome that spends money. */
export function decideFree(row: DriftRow, candidate: DriftCandidate, w: FreeWitness): DriftDecision {
  const twin = w.twins.slice().sort((a, b) => a.d - b.d)[0];
  if (twin && twin.d <= COVER_RADIUS_M) {
    return {
      action: 'leave', reason: 'covered',
      detail: `identified twin «${twin.name}» at ${fmt(twin.d)} already carries the place`,
    };
  }
  if (w.branch) {
    return {
      action: 'leave', reason: 'branch',
      detail: `«${w.branch.name}» is a known row ${fmt(w.branch.d)} away — the search matched that one`,
    };
  }
  if (sharedNameless(row.name, candidate.name)) {
    const shared = sharedTokens(row.name, candidate.name).filter(t => t.length >= 4 && !GENERIC_VENUE_TOKENS.has(t));
    const common = sharedTokens(row.name, candidate.name);
    return {
      action: 'leave', reason: 'generic-name',
      detail: shared.length === 0 && common.length > 0
        ? `«${row.name}» ⇄ «${candidate.name}» share only kind words (${common.join(', ')})`
        : `«${row.name}» ⇄ «${candidate.name}» share no distinctive word`,
    };
  }
  const near = w.nearestAddressM ?? null;
  if (near != null && near <= PIN_CORROBORATED_M) {
    const at = w.nearestAddress ? ` (${w.nearestAddress.street} ${w.nearestAddress.housenumber})` : '';
    return {
      action: 'leave', reason: 'address-corroborated',
      detail: `the map's address fabric puts a house number${at} ${fmt(near)} from the pin`,
    };
  }
  return {
    action: 'verify', reason: 'unanchored',
    detail: near == null
      ? 'no house number anywhere near the pin — one search buys the address'
      : `nearest house number is ${fmt(near)} from the pin — one search buys the address`,
  };
}

/**
 * «Orce Nikolov 137, Skopje 1000» → { street: 'Orce Nikolov', number: '137' }.
 *
 * The STREET LINE IS NOT ALWAYS FIRST, which the first version of this got
 * wrong for most of the 2026-11-23 pass: SerpApi returns
 * «1000, Boulevard Jane Sandanski 69, Skopje 1000, North Macedonia» (postcode
 * first) and «MK, Vasil Gjorgov no.12, Skopje 1000» (country first, «no.» before
 * the number). So every comma part is tried in order and the first that parses
 * wins; a part with no letters («1000») or a plus code («XCWQ+FQ4») never does.
 * No house number → null: an address without a number identifies no building,
 * and pretending otherwise is how a review invents agreement.
 */
export function parseGoogleAddress(addr: string | null | undefined): { street: string; number: string } | null {
  const text = String(addr ?? '').trim();
  if (!text) return null;
  for (const part of text.split(',')) {
    const seg = part
      // «Vasil Gjorgov no.12» / «бр. 12» — the marker is not part of the name.
      .replace(/\b(?:no|num|бр|br)\.?\s*(?=\d)/iu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/\p{L}{3}/u.test(seg)) continue;
    const m = seg.match(/^(.*?)[\s,]+(\d+[a-zA-Zа-яА-Я]?)\s*$/u);
    if (!m) continue;
    const street = m[1].replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/[\p{L}]{3}/u.test(street)) continue;
    // «Skopje 1000» is the CITY line with the postcode, not a street: a bare
    // city/country name and a postcode-shaped number are never an address.
    if (/^(?:skopje|скопје|mk|macedonia|makedonija|македонија|north macedonia)$/iu.test(street)) continue;
    if (/^\d{4}$/.test(m[2]) && /00$/.test(m[2])) continue;
    // «12-та Македонска Бригада 2а»: the trailing number is the house number, the
    // ordinal inside the street name is not.
    return { street, number: m[2].toLowerCase() };
  }
  return null;
}

/** A house number in the map's own address fabric, resolved to a coordinate. */
export interface AddressPoint {
  street: string;
  housenumber: string;
  lat: number;
  lon: number;
  /** Metres from Google's candidate pin. */
  d: number;
  /** Metres from the MAP row's pin — the SAME house number, both sides. */
  fromMapPinM: number;
}

/** DECIDE WITH THE PAID EVIDENCE. `addrAtMapPinM` is the same house number's
 *  distance from the MAP pin, or null when the map's fabric has no such point. */
export function decideVerified(
  row: DriftRow,
  candidate: DriftCandidate,
  free: FreeWitness,
  addr: AddressPoint | null,
): DriftDecision {
  const free0 = decideFree(row, candidate, free);
  if (free0.action !== 'verify') return free0;

  if (candidate.lat == null || candidate.lon == null) {
    return { action: 'inconclusive', reason: 'no-candidate-position', detail: 'Google returned no position for the candidate' };
  }
  if (!addr) {
    return {
      action: 'inconclusive', reason: 'address-unknown',
      detail: `Google's candidate has no house number this map can resolve${candidate.address ? ` («${candidate.address}»)` : ''}`,
    };
  }
  // THE ADDRESS MUST DESCRIBE GOOGLE'S OWN POINT before it can arbitrate ours.
  // «Авиатор» (2026-11-23) was read as corroborated because a «Фрањо Клуз 3»
  // exists 42 m from OUR pin — while Google's café sat 7.5 km away, naming a
  // street it does not stand on. That is a different place, not agreement.
  if (addr.d > PIN_CORROBORATED_M) {
    return {
      action: 'inconclusive', reason: 'address-does-not-fit-candidate',
      detail: `Google names ${addr.street} ${addr.housenumber}, ${fmt(addr.d)} from its own pin — not the candidate's building`,
    };
  }
  // THE SAME HOUSE NUMBER FROM BOTH PINS. Comparing the map pin to "the nearest
  // house number anywhere" proved nothing («Лабораторија»: Google's BIOTEK sits
  // on Васил Ѓоргов 12, and some unrelated number 113 m away was read as the
  // row's own building).
  if (addr.fromMapPinM <= SAME_ADDRESS_M) {
    return {
      action: 'leave', reason: 'address-agrees-with-map-pin',
      detail: `${addr.street} ${addr.housenumber} is ${fmt(addr.fromMapPinM)} from the map pin — both records name that building`,
    };
  }
  // A pin fix is for ONE place recorded twice, not for two branches of a chain:
  // beyond the sanctioned drift ceiling the candidate is somewhere else, and
  // moving the row there would delete a landmark to plant a stranger.
  if (addr.fromMapPinM > CAPTURE_PIN_DRIFT_M) {
    return {
      action: 'inconclusive', reason: 'candidate-too-far',
      detail: `${addr.street} ${addr.housenumber} is ${fmt(addr.fromMapPinM)} from the map pin — that is another place, not a drifted pin`,
    };
  }
  return {
    action: 'fix-pin', reason: 'address-agrees-with-candidate-pin',
    detail: `${addr.street} ${addr.housenumber} sits ${fmt(addr.d)} from Google's pin and ${fmt(addr.fromMapPinM)} from the map pin`,
    to: { lat: addr.lat, lon: addr.lon },
  };
}

/** Do two addresses name the same building? Script/case folded, numbers exact. */
export function sameAddress(
  a: { street: string; number: string } | null,
  b: { street: string; housenumber: string } | null,
): boolean {
  if (!a || !b) return false;
  const ka = streetKey(a.street);
  const kb = streetKey(b.street);
  if (!ka || !kb) return false;
  return ka === kb && a.number.toLowerCase() === b.housenumber.toLowerCase();
}
