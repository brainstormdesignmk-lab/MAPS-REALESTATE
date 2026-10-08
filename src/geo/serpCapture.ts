// THE SCRAPER CONTRACT (the data_id/data_cid lesson, made policy):
// "capture everything the API returns, schema-first, even before a use
// exists. Data you have costs nothing to keep; data you threw away costs
// a key to recover." — every SerpApi Google Maps place is mapped HERE, in
// one pure, unit-tested function, so a field can never be silently dropped
// again. refresh-monthly consumes it; tests pin it.

/** The pois columns the capture fills. The live DB self-upgrades to these
 *  (see ensurePoiColumns). Old DBs read NULL for the new columns everywhere —
 *  every reader already tolerates absent optional fields. */
export const POI_CAPTURE_COLUMNS = [
  'review_count', 'rating', 'plus_code', 'phone', 'website',
  'price_level', 'closed', 'types',
] as const;

/** The 15 landmark categories. 10 = the original Google/OSM set; +5 are the
 *  everyday anchors Skopje clients actually say ("спроти автобуската",
 *  "кај поштата", "до бензинската"). ATM had rank 9 already — it joins the
 *  scrape list so it carries identity too. */
export const FULL_CATEGORIES = [
  'supermarket', 'shopping mall', 'pharmacy', 'bank', 'school',
  'hospital', 'embassy', 'hotel', 'museum', 'gas station',
  'bus station', 'post office', 'kindergarten', 'atm',
  'fuel',
] as const;

/** Monthly light pass — 2 categories/tile (~72 searches/month on 36 tiles).
 *  The doc's budget math (P8): full pass quarterly, light monthly. */
export const LIGHT_CATEGORIES = ['supermarket', 'pharmacy'] as const;

/** true = quarterly full pass (Jan/Apr/Jul/Oct); false = monthly light. */
export function isFullPassMonth(d = new Date()): boolean {
  return d.getUTCMonth() % 3 === 0;
}

/** Categories for this run. CLI flags win (--full / --light) so a manual
 *  October run can force either; otherwise the calendar decides. */
export function categoriesForRun(cliFlag?: '--full' | '--light', d = new Date()): readonly string[] {
  if (cliFlag === '--light') return LIGHT_CATEGORIES;
  if (cliFlag === '--full') return FULL_CATEGORIES;
  return isFullPassMonth(d) ? FULL_CATEGORIES : LIGHT_CATEGORIES;
}

/** The Skopje map bounds — the same bbox the Phase A Overpass queries use
 *  and the queue drain validates geocodes against. Google's fuzzy geographic
 *  expansion returns places FAR outside these bounds for Skopje searches (a
 *  supermarket tile search surfaced "Walgreens Pharmacy" in California and a
 *  New York hospital); nothing outside may be stored or served, because a
 *  POI outside the city can never be honestly "во близина" of a property. */
export const SKOPJE_BBOX = { latMin: 41.95, latMax: 42.05, lonMin: 21.35, lonMax: 21.5 } as const;

export function insideSkopjeBbox(lat: number, lon: number): boolean {
  return lat >= SKOPJE_BBOX.latMin && lat <= SKOPJE_BBOX.latMax
    && lon >= SKOPJE_BBOX.lonMin && lon <= SKOPJE_BBOX.lonMax;
}

/** One SerpApi Google Maps place, with every field we keep. */
export interface CapturedPoi {
  name: string;
  type: string;
  lat: number;
  lon: number;
  place_id: string | null;   // hex pair "0x…:0x…" — Google identity
  review_count: number | null;
  rating: number | null;
  plus_code: string | null;
  phone: string | null;
  website: string | null;
  price_level: string | null;
  closed: number;            // 1 = permanently closed (demoted at ranking)
  types: string | null;      // Google's full type chain, JSON-encoded
  source: string;            // 'google'
}

/** Number-coercion guards: a finite number or null. `round` for counts. */
function numOrNull(v: unknown, round: boolean): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return round ? Math.round(v) : v;
}

/** String guard: a non-empty string or null. */
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** THE capture function — pure, total, never throws. Every field the API
 *  returns for a place is mapped here exactly once. A row without
 *  coordinates is skipped (nothing to anchor); everything else is kept. */
export function capturePoi(r: any, fallbackType: string): CapturedPoi | null {
  const name = typeof r?.title === 'string' ? r.title.trim() : '';
  if (name.length < 2) return null;
  const lat = r?.gps_coordinates?.latitude;
  const lon = r?.gps_coordinates?.longitude;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // IDENTITY: data_id (hex pair) verbatim; data_cid → hex pair when data_id
  // is absent (data_id high/low 32-bit halves = the decimal cid).
  let placeId: string | null = typeof r.data_id === 'string' && r.data_id ? r.data_id : null;
  if (!placeId && r.data_cid != null) {
    try {
      const cid = BigInt(r.data_cid);
      const hi = cid >> 32n & 0xffffffffn;
      const lo = cid & 0xffffffffn;
      placeId = `0x${hi.toString(16)}:0x${lo.toString(16)}`;
    } catch { placeId = null; }
  }

  const closed = r.permanently_closed === true
    || (typeof r.business_status === 'string' && /closed/i.test(r.business_status));

  return {
    name,
    type: typeof r.type === 'string' && r.type ? r.type : fallbackType,
    lat, lon,
    place_id: placeId,
    // FIELD-NAME LESSON (same class as data_id): SerpApi's local_results
    // item carries `reviews` (number) and `price` (string, "$"/"$$"/…),
    // NOT `review_count`/`price_level`. Reading the wrong key silently
    // returned null for EVERY place — the prominence signal was captured
    // as nothing. Read the API's real names, accept the old ones defensively.
    review_count: numOrNull(r.reviews ?? r.review_count, true),
    rating: numOrNull(r.rating, false),
    plus_code: typeof r.plus_code === 'string' && r.plus_code ? r.plus_code : null,
    phone: typeof r.phone === 'string' && r.phone ? r.phone : null,
    website: typeof r.website === 'string' && r.website ? r.website : null,
    price_level: strOrNull(r.price ?? r.price_level),
    closed: closed ? 1 : 0,
    types: Array.isArray(r.types) && r.types.length > 0 ? JSON.stringify(r.types) : null,
    source: 'google',
  };
}
