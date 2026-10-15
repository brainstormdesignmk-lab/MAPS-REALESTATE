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

// Landmark link — priority order (revised 2026-10-13, the [23:50] capture):
//   1. A stored google.com/maps URL (canonical place_url from the capture
//      script) — emitted verbatim, original Google.
//   2. Coordinate pin via maps.google.com/?q=lat,lon (~44 chars) — DROPS A RED
//      PIN on the exact spot. Now the PRIMARY landmark link. The cid form was
//      primary until the operator reported what a client actually sees: "link
//      with card for the landmark but no pin" — a place CARD tells the client
//      which place it is, but not WHERE it is, and the reply already carries
//      the landmark's name in text. The pin is also shorter (44 vs 46–49 chars)
//      so it fits the narrowest supported chat pane, and it is ASCII-only.
//   3. Google place_id → maps.google.com/?cid=<decimal> — the EXACT place card,
//      now the FALLBACK for landmarks with no usable coordinate.
// Name searches are BANNED: with no city context Google biases them by the
// viewport/keywords and can return a results LIST at country zoom instead of a
// pin (production bug: a "crna gora" embassy name-search opened a
// Montenegro-wide list). The landmark's NAME is carried in the reply text,
// never in the URL.
// Never: tinyurl (third-party shortener — agency refuses it), never
// percent-encoded Cyrillic name searches, never a name-only ?q=<name> search,
// never a bare @-view (opens a map with no landmark).
export function landmarkLink(name: string, placeId: string | null, lat: number, lon: number, placeUrl?: string): string {
  void name; // name lives in the reply text, not in the URL
  // BEST: a stored ORIGINAL Google URL (canonical place URL captured by
  // scripts/capture-place-urls.ts). Only google.com/maps links are accepted —
  // tinyurl/other shorteners are never emitted.
  const curated = allowedLandmarkUrl(placeUrl);
  if (curated) return curated;
  // 1. Coordinate pin — deterministic, unambiguous, and the only form that
  //    puts a MARKER on the map (the [23:50] decision: card-but-no-pin loses
  //    to a pin that shows where the landmark is).
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return `https://maps.google.com/?q=${lat.toFixed(5)},${lon.toFixed(5)}`;
  }
  // 2. No usable coordinate → the exact place card via cid (Google's own short
  //    deep-link). Better the right place with no pin than nothing at all.
  if (placeId) {
    const cid = cidLink(placeId);
    if (cid) return cid;
  }
  return '';
}
