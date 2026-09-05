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
//   ✓ maps.google.com/?cid=<decimal> → Google's own domain, ~49 chars, opens
//       the EXACT place card (verified in a real browser). Requires the POI's
//       Google place_id — the hex "0x…:0x…" pair whose second half decimalizes
//       into the cid. This is the primary landmark link.
// The landmark/property NAME is carried in the reply TEXT ("во близина на …"),
// never in the URL.

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
  return `https://www.google.com/maps/@${lat.toFixed(5)},${lon.toFixed(5)},17z`;
}

// Landmark link — priority order:
//   1. Google place_id → maps.google.com/?cid=<decimal> — the EXACT place card,
//      Google's own domain, ~49 chars (truncation-proof, verified in browser).
//   2. A stored google.com/maps URL (canonical place_url from the capture
//      script) is emitted verbatim — also original Google.
//   3. @-view at the POI coordinates — original Google, short, opens the point.
// Never: tinyurl (third-party shortener — agency refuses it), never
// percent-encoded Cyrillic name searches, never bare query=lat,lon.
export function landmarkLink(name: string, placeId: string | null, lat: number, lon: number, placeUrl?: string): string {
  const clean = (name || '').trim();
  // BEST: a stored ORIGINAL Google URL (canonical place URL captured by
  // scripts/capture-place-urls.ts). Only google.com/maps links are accepted —
  // tinyurl/other shorteners are never emitted.
  if (placeUrl && /^https?:\/\/(www\.)?(google\.com|maps\.google\.com|google\.mk)\//.test(placeUrl)) {
    return placeUrl;
  }
  // 1. place_id → exact place card via cid (Google's own short deep-link).
  if (placeId) {
    const cid = cidLink(placeId);
    if (cid) return cid;
  }
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    // Round to 4 decimals (±11 m) — enough for a landmark pin, keeps the URL
    // ~45 chars so it never hits the console's truncation window.
    return `https://www.google.com/maps/@${lat.toFixed(4)},${lon.toFixed(4)},17z`;
  }
  // No coordinates at all — last resort name search (never happens today:
  // every caller resolves the POI before linking).
  if (clean) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clean)}`;
  }
  return '';
}
