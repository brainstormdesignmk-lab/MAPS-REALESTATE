import { translitToLatin } from './offlineMap';

export const R_EARTH = 6371000;

export function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

// ── A CAPTURE MAY REFINE A PIN, NEVER RELOCATE THE PLACE ────────────────────
// WHY: the monthly top-up backfills an existing row by place_id and used to
// write Google's lat/lon unconditionally (refresh-monthly's `updateAll`). A
// Google record whose own pin is the sales OFFICE instead of the building then
// teleported the map's row: the November 2026 sweep moved «Беверли Хилс» from
// its Капиштец building footprint (41.99368, 21.41623) to the agency's office by
// the cathedral (41.99877, 21.42390) — 847 m — so every «кај Беверли Хилс»
// answer named the neighbourhood Центар instead of Капиштец, and the landmark
// distances of that quarter were measured from the wrong side of the city.
//
// THE RULE: a re-capture may correct a pin by up to a block's width; beyond that
// it is a DIFFERENT place (a namesake, an office, a branch) and the map keeps
// the pin it already had. The override drawer is how a genuine relocation is
// accepted, deliberately and once, instead of every month by accident.
export const CAPTURE_PIN_DRIFT_M = 300;

/** May a capture replace a stored pin with the one it just returned?
 *  `undefined`/empty stored coordinates mean the row never had a pin, so the
 *  capture is the only evidence and may fill it (drift = 0). */
export function captureMayMovePin(
  from: { lat: number; lon: number } | undefined | null,
  to: { lat: number; lon: number },
  maxM = CAPTURE_PIN_DRIFT_M,
): { ok: boolean; movedM: number } {
  if (!from || !Number.isFinite(from.lat) || !Number.isFinite(from.lon)) return { ok: true, movedM: 0 };
  const movedM = distM(from.lat, from.lon, to.lat, to.lon);
  return { ok: movedM <= maxM, movedM };
}

export function walkMinutes(meters: number): number {
  return Math.max(1, Math.round(meters / 80)); // 80 m/min pace
}

// ── Link format — ONE rule, learned from production failures ─────────────────
// Every client-facing map link is short, pure-ASCII and truncation-proof:
// the console that renders Lina's replies cuts long URLs at ~50-57 chars.
//   ✗ ?api=1&query=<percent-encoded Cyrillic name>  → cut mid-encoding → Google
//       received a stray "П " and showed a city-wide prefix search
//   ✗ ?api=1&query=lat,lon                           → cut at the comma → "Google
//       Maps can't find 41.99560"
//   ✗ tinyurl.com/...  → works, but the agency won't send third-party shorteners
//   ✓ google.com/maps/@lat,lon,zoom  → short, opens the map AT the point, but
//       shows no named place card
//   ✓ maps.google.com/?q=lat,lon      → Google's own domain, ~44 chars, drops
//       a RED PIN on the exact point. The primary landmark link since the
//       [23:50] capture (a place card names the place but shows no pin).
//   ✓ maps.google.com/?cid=<decimal> → Google's own domain, ~49 chars, opens
//       the EXACT place card but shows NO PIN (client-reported). Fallback for
//       landmarks with no usable coordinate; requires the POI's Google
//       place_id — the hex "0x…:0x…" pair whose second half decimalizes to it.
// The landmark/property NAME is carried in the reply TEXT ("во близина на …"),
// never in the URL.

/** ASCII-safe search term from a landmark name: canonical transliteration
 *  (Cyrillic→Latin, same table the offline map dedupe uses) + strip to letters,
 *  digits and single spaces. Empty when nothing usable survives — e.g. a name
 *  that was ONLY punctuation/emoji. */
export function asciiSearchName(name: string): string {
  const t = translitToLatin(name);
  return t.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Hex place_id → decimal cid (Google's canonical deep-link id).
// "0x135415004f259205:0xe6d8969b475a5b1e" → 16634210817354128158
export function cidFromPlaceId(placeId: string): string | null {
  // Format: "0x<prefix>:0x<cid-hex>" — the SECOND hex value is the cid.
  // If only one hex value is present, use it as-is.
  const parts = String(placeId).split(':').filter(Boolean);
  const raw = parts.length >= 2 ? parts[parts.length - 1] : parts[0];
  if (!raw) return null;
  const hex = raw.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  try {
    return BigInt('0x' + hex).toString();
  } catch { return null; }
}

/** Short original-Google link that pins the exact place card (verified). */
export function cidLink(placeId: string): string | null {
  const cid = cidFromPlaceId(placeId);
  if (!cid) return null;
  return `https://maps.google.com/?cid=${cid}`;
}

// DELIBERATE 3-decimal fuzz ≈ ±110m — client-facing property area ONLY.
// 16z = neighborhood view, wide enough that the ±110m fuzz is invisible.
export function propertyAreaLink(lat: number, lon: number): string {
  return `https://www.google.com/maps/@${lat.toFixed(3)},${lon.toFixed(3)},16z`;
}

// Full precision — staff/internal, and the coordinate fallback. 17z = street
// level, centered exactly on the point.
export function fullCoordsLink(lat: number, lon: number): string {
  // ?q=lat,lng DROPS A PIN at the exact point. The @lat,lng,zoom form only
  // CENTERS the viewport — the client reported "NO PIN ON THE MAP" for the
  // visit-day link. q= also snaps the pin label to Google's own knowledge of
  // the nearest address, matching the written address line in the message.
  return `https://maps.google.com/?q=${lat.toFixed(5)},${lon.toFixed(5)}`;
}

/** The POINT a maps link pins, when the link carries one: the coordinate-pin
 *  form (`?q=lat,lon`, fullCoordsLink) and the viewport form
 *  (`@lat,lon,zoom`, propertyAreaLink). A place-CARD link (`?cid=…`, a stored
 *  /maps/place/… URL) names a place but carries NO coordinate → undefined.
 *
 *  Used by the landmark rotation (from the FEED ROSTER, fix-list item 3): a
 *  curated entry's own pin is the point the feed validated, so the rotation
 *  serves THAT point instead of re-deriving one from the map. */
export function coordsFromMapsUrl(url: string | undefined | null): { lat: number; lon: number } | undefined {
  const u = String(url ?? '');
  if (!u) return undefined;
  const m = u.match(/[?&]q=(-?\d+(?:\.\d+)?)(?:,\s*|%2C)(-?\d+(?:\.\d+)?)/i)
    ?? u.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (!m) return undefined;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  // (0,0) is the Gulf of Guinea, never Skopje — an unset pin, not a location.
  if (lat === 0 && lon === 0) return undefined;
  return { lat, lon };
}

/** Is this a Google Maps link the agency may put in front of a client?
 *
 *  BANNED: the NAME-SEARCH forms — `…/maps/search/?api=1&query=<name>`, and
 *  the `?api=1&query=` / `?query=` relatives — and every non-Google shortener
 *  (tinyurl: the agency refuses third-party links). A percent-encoded Cyrillic
 *  name makes the link long enough for the console to cut mid-encoding, and a
 *  cut search link opens a results LIST at country zoom (production: a "crna
 *  gora" name search opened a Montenegro-wide list; a cut `?q=41.99560,`
 *  opened "Google Maps can't find 41.99560").
 *
 *  ALLOWED: the coordinate pin (`?q=lat,lon`), the @-view, the `?cid=` place
 *  card, and a stored canonical `/maps/place/…` URL — what the capture script
 *  records. `?q=` is accepted ONLY as coordinates: a NAME there is a search.
 *  This is the single judge for stored/curated links (the feed reader and
 *  landmarkLink both call it), so a dirty row can never be served verbatim. */
export function allowedLandmarkUrl(url: string | undefined | null): string | undefined {
  const u = String(url ?? '').trim();
  if (!u) return undefined;
  if (!/^https?:\/\/(?:www\.)?(?:google\.com|maps\.google\.com|google\.mk)\//i.test(u)) return undefined;
  if (/\/maps\/search\b/i.test(u)) return undefined;      // the banned form itself
  if (/[?&]query=/i.test(u)) return undefined;            // name/coordinate query
  if (/[?&]api=1(?:&|$)/i.test(u)) return undefined;      // the Maps URL-API params
  const q = u.match(/[?&]q=([^&]*)/i);
  if (q) {
    // ?q= is the coordinate pin — ONLY when it really is a coordinate pair.
    let v = q[1];
    try { v = decodeURIComponent(v); } catch { /* keep raw */ }
    if (!/^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(v.trim())) return undefined;
  }
  return u;
}

/** Is this an allowed link that carries only a POINT (a `?q=lat,lon` pin or an
 *  `@lat,lon,zoom` view) — i.e. it names NO place? */
export function isCoordinatePinUrl(url: string): boolean {
  return /[?&]q=\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?/i.test(url)
    || /\/maps\/@-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/i.test(url);
}

// Landmark link — CARD FIRST, PIN SECOND (the owner's rule, 2026-11-25).
//
// The [23:50] decision made the coordinate pin primary because a place CARD on
// its own answers «which place?» but not «where?». The [12:27] field answer then
// shipped «во близина на Kindergarten …» + a bare `?q=41.99727,21.41594` — and
// the owner's verdict on it is the other half of the same coin: a pin with no
// card names NOTHING (a dropped pin in a courtyard is not the kindergarten).
// Neither form alone is an answer, so both are emitted when the map can give
// them, each on its own line (each fits the console's ~50-char cut):
//   1. the place CARD — a canonical `/maps/place/…` URL from the map/capture
//      script, else Google's `?cid=<decimal>` deep-link from the POI's place_id;
//   2. the coordinate PIN — the exact point, for «where do I walk?».
// A landmark with no card identity keeps the pin alone (never a name search:
// percent-encoded Cyrillic names get cut and open a country-wide result list).
// Never tinyurl (third-party shortener — the agency refuses it), never
// `?api=1&query=`, never a bare @-view.
export function landmarkLink(name: string, placeId: string | null, lat: number, lon: number, placeUrl?: string): string {
  void name; // the name lives in the reply text, never in the URL
  const lines: string[] = [];
  // 1. THE CARD. A stored ORIGINAL Google URL (canonical place URL captured by
  //    scripts/capture-place-urls.ts) is emitted verbatim — but only when it
  //    really is a card: a stored `?q=lat,lon` is just the pin in another coat,
  //    and the cid is the shorter, exact place identity.
  const curated = allowedLandmarkUrl(placeUrl);
  if (curated && !isCoordinatePinUrl(curated)) lines.push(curated);
  if (lines.length === 0 && placeId) {
    const cid = cidLink(placeId);
    if (cid) lines.push(cid);
  }
  // 2. THE PIN, when the map has a usable point.
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    lines.push(`https://maps.google.com/?q=${lat.toFixed(5)},${lon.toFixed(5)}`);
  } else if (lines.length === 0 && curated) {
    // No point at all → the stored link as-is (allowed form), so a client still
    // gets something rather than a sentence with no reference.
    lines.push(curated);
  }
  return lines.join('\n');
}
