
// Single choke point for landmark decision logging. Every resolution event
// (layer returns, cache skips, proximity rejections) flows through here —
// one file, one line format ([iso] EB n: EVENT …) so ops greps stay stable.
function dbgLog(line: string): void {
  try { fs.appendFileSync('/tmp/landmark-debug.log', line.endsWith('\n') ? line : line + '\n'); } catch {}
}
// LandmarkService — resolves the APPROXIMATE public location of a property.
//
// The exact street address is a trade secret of the funnel: a client who knows
// the street goes straight to the owner and cuts the agency out (the owner
// agrees — nobody likes paying agencies when they can bypass them). So Lina
// answers "каде се наоѓа?" with a nearby PUBLIC LANDMARK, like a human agent
// would: "во близина на Градежен Факултет". The exact location (Google Maps
// link with the real address) is revealed ONLY in the visit protocol, 2 hours
// before the visit, when the visit is already arranged.
//
// Resolution layers — DB-ONLY. No network, no table, no LLM in the request
// path (network lives only in scripts/: the offline-map builder, the SerpApi
// geocoders, the monthly refresh cron). Each hit is cached in the `landmarks`
// table keyed by property.id:
//   1. feed landmarks      — ANA's import-time ranked list (Supabase),
//                            proximity-guarded against wrong upstream entries.
//   2. DB cache            — previous resolution (any source), tier-guarded
//                            by canServeLandmark (never serves poison).
//   3. details extraction  — parse "спроти X", "кај X", "близина на X" from
//      the property's own description text. Zero cost, always available.
//   4. offline map         — local OSM POIs + addresses, zero network
//                            (Skopje only). Trusted only for exact building /
//                            interpolated resolutions; centroid guesses are
//                            honest "населба" fallbacks, never landmarks.
// If everything fails → { source: 'none' } and the caller falls back to the
// neighborhood alone — the street is never revealed.

import fs from 'fs';
import { Db } from '../store/db';
import { FeedLandmark } from '../data/properties';
import { OfflineMapStore, isShopLevelPlace, type Center } from './offlineMap';
export type { Center } from './offlineMap';

export interface Landmark {
  landmark: string;
  type: string;
  mapsUrl?: string;
  // 'table'|'google'|'osm'|'hermes' kept for legacy DB-cache rows written by
  // older generations — canServeLandmark gates them by tier before serving.
  source: 'feed' | 'extract' | 'offline' | 'table' | 'google' | 'osm' | 'hermes' | 'none';
}

// ── Tier system (replaces old address_key cache + 24h TTL + suspect bypass) ──
// Higher rank = higher quality. Only UPGRADE on rewrite, never downgrade.
export const TIER_RANK: Record<string, number> =
  { feed: 5, google: 4, extract: 3, osm_poi: 2, osm_low_confidence: 1 };
export type LandmarkTier = keyof typeof TIER_RANK;

/** Minimal property row shape needed by the tier system. The caller passes
 *  whatever Property fields are available — we never depend on the full
 *  Property type so the function stays testable. */
export interface PropertyRow {
  id: number;
  eb?: number;
  landmark_tier?: string | null;
  landmark_lat?: number | null;
  landmark_lon?: number | null;
  landmark_name?: string | null;
  geo_source?: string | null;   // 'stored'|'google_cached'|'osm_low_confidence'
  address?: string;
  lat?: number | null;
  lon?: number | null;
  /** Feed description text — present only when callers pass the full
   *  property (whereIsReply does); enables the feed landmark-pair top-up. */
  details?: string | null;
  /** The property's OWN ranked landmark list (Ана's import-time resolution,
   *  stored next to the property in Supabase). When present it IS the rotation
   *  — see nearbyLandmarks (fix-list item 3). Present only when the caller
   *  passes the full Property (every handler lane does; whereIsReply carries
   *  it explicitly). */
  landmarks?: FeedLandmark[];
}

/** The rotation's size: L1 → L2 → L3 ("каде?" → "што уште има во близина?").
 *  Matches FEED_LANDMARK_COUNT, the length of the feed's own list. */
const ROTATION_SLOTS = 3;

/** Rotation slots from the FEED's curated landmark list — the list the agency
 *  page itself shows, resolved once at import, ranked and distance-capped
 *  there (fix-list item 3).
 *
 *  Each entry's own point is used when its link pins one (?q= / @form);
 *  otherwise the map row behind the name supplies the point and the place
 *  identity — the roster was BUILT from that map pool, so a name the map no
 *  longer knows is a stale roster entry, and an entry we cannot point at is
 *  not a claim the chat may make (drop it; the caller falls back to the map
 *  scan only when the WHOLE roster is unpinnable). */
function feedRosterSlots(
  p: PropertyRow,
  map: OfflineMapStore | undefined,
  center: Center,
): Array<{ landmark: string; lat: number; lon: number; place_url?: string; place_id?: string }> {
  const out: Array<{ landmark: string; lat: number; lon: number; place_url?: string; place_id?: string }> = [];
  const seen = new Set<string>();
  // A claim is only honest when it can be MEASURED. The declared distance_m
  // stored in the feed is not evidence: it was written at import time from a
  // centre that may since have changed (or never existed — EB 42/46 carry no
  // coordinates at all) and it is not re-checked. Without a real centre the
  // entry is an unverifiable assert, so it is dropped (the caller falls back
  // to the honest neighborhood line).
  const hasCenter = Number.isFinite(center.lat) && Number.isFinite(center.lon)
    && (center.lat !== 0 || center.lon !== 0);
  const near = hasCenter ? { lat: center.lat, lon: center.lon } : undefined;
  for (const e of p.landmarks ?? []) {
    if (out.length >= ROTATION_SLOTS) break;
    let name = String(e?.landmark ?? '').trim();
    if (!name) continue;
    const pin = coordsFromMapsUrl(e?.maps_url);
    let lat = pin?.lat;
    let lon = pin?.lon;
    let place_url: string | undefined;
    let place_id: string | undefined;
    if (map?.available) {
      const poi = map.findPoiByName(name, near);
      if (poi) {
        if (lat == null || lon == null) { lat = poi.lat; lon = poi.lon; }
        place_url = poi.place_url;
        place_id = poi.place_id;
      }
    }
    // A SHOP IS NOT A PLACE (the owner's rule, the EB 53 capture): the roster
    // led with «Butik Galion» — a boutique inside ТЦ Бисер — and the card told
    // the client the flat was near a shopfront nobody navigates by. When the
    // shop stands inside a complex, the COMPLEX takes the slot and its own
    // distance is measured below; when it does not, the entry is dropped (the
    // honest neighborhood line beats an unknown name).
    if (isShopLevelPlace(name, e?.type)) {
      const complex = lat != null && lon != null ? map?.enclosingComplex(lat, lon) : undefined;
      if (!complex) {
        try { dbgLog(`[${new Date().toISOString()}] EB ${p.eb}: NEARBY-FEED-SKIP "${name}" is a shop, not a landmark\n`); } catch {}
        continue;
      }
      name = complex.name;
      lat = complex.lat;
      lon = complex.lon;
      place_url = complex.place_url;
      place_id = complex.place_id;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue; // one place, one slot (the feed can carry a dupe)
    if (lat == null || lon == null) {
      try { dbgLog(`[${new Date().toISOString()}] EB ${p.eb}: NEARBY-FEED-SKIP "${name}" not pinnable (stale roster entry)\n`); } catch {}
      continue;
    }
    // RING GUARD: the roster was built under an older cap (500 m). A slot we
    // can measure beyond the current ring is not a "во близина" claim any
    // more — drop it and let the map scan serve the in-ring places. No centre
    // → no measurement → no claim.
    if (!near) {
      try { dbgLog(`[${new Date().toISOString()}] EB ${p.eb}: NEARBY-FEED-SKIP "${name}" no centre to measure from\n`); } catch {}
      continue;
    }
    const claimM = _distM(near.lat, near.lon, lat, lon);
    if (claimM > FEED_LANDMARK_MAX_M) {
      try { dbgLog(`[${new Date().toISOString()}] EB ${p.eb}: NEARBY-FEED-SKIP "${name}" ${Math.round(claimM)}m > ${FEED_LANDMARK_MAX_M}m\n`); } catch {}
      continue;
    }
    seen.add(key);
    out.push({ landmark: name, lat, lon, place_url, place_id });
  }
  return out;
}

export function centerTrusted(geoSource: string | null | undefined): boolean {
  // Trusted: real geocodes (stored / google_cached) AND the Phase-1 offline
  // import resolutions (osm_building exact / osm_interpolated between two
  // neighbours / osm_street_anchor — a Google-verified street anchor taught
  // to the map by the self-learning loop). Untrusted: osm_low_confidence
  // (street centroid, endpoint clamp, name-fail) — never anchors a claim.
  return geoSource === 'stored' || geoSource === 'google_cached'
    || geoSource === 'osm_building' || geoSource === 'osm_interpolated'
    || geoSource === 'osm_street_anchor';
}

// Can the CACHED landmark be served to a client right now?
export function canServeLandmark(p: PropertyRow): boolean {
  if (!p.landmark_tier) return false;
  if (p.landmark_tier === 'osm_low_confidence') return false;   // NEVER serves
  if (p.landmark_tier === 'osm_poi') return centerTrusted(p.geo_source); // needs trusted center
  return true;
}

export interface LandmarkOpts {
  /** Local OSM map (named POIs + addresses) — the zero-network landmark
   *  layer for Skopje. Resolves the address locally (exact building →
   *  interpolation → centroid), finds the nearest named POI, returns it as
   *  the landmark. Falls through when the map is unavailable or the address
   *  can't be resolved. Trusted only for building/interpolated resolutions. */
  offlineMap?: OfflineMapStore;
}

/** Google Maps link for a query (real address or landmark name) — the ONLY
 *  link format that may ever reach a customer: "everyone uses Google Maps".
 *  Pure string builder, no network. Shared by the visit protocol (exact
 *  address reveal) and every landmark answer, so an OSM/other URL can never
 *  leak into a message or cache. */
export function googleMapsLink(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// Re-export precision utilities for callers (handler, scripts)
import { distM as _distM, propertyAreaLink, fullCoordsLink, landmarkLink, coordsFromMapsUrl } from './precision';
import { typeRank } from './types';
export { propertyAreaLink, fullCoordsLink, landmarkLink };

// --- DB cache (property.id keyed, no TTL, upgrade-only) ---------------------
// The old address_key cache caused two buildings sharing an address to collide.
// Property.id is the stable, unique key. No 24h TTL: freshness comes from the
// monthly cron refresh and the upgrade-only write policy.
export class LandmarkStore {
  constructor(private db: Db) {}

  /** Read the cached landmark for a property. No TTL — once resolved, it stays
   *  until the cron or a higher-quality layer supersedes it. */
  get(propertyId: number): { landmark: string; type: string; mapsUrl: string | null; source: string; tier: string | null } | undefined {
    const row = this.db.db.prepare(
      `SELECT landmark, type, maps_url as mapsUrl, source, tier FROM landmarks WHERE property_id = ?`
    ).get(propertyId) as any;
    return row ?? undefined;
  }

  /** Write a landmark to the cache. Upgrade-only: if the existing entry has
   *  a higher or equal tier, this is a no-op. Never downgrade quality. */
  put(propertyId: number, l: { landmark: string; type: string; mapsUrl?: string; source: string }, tier: LandmarkTier): void {
    const existing = this.db.db.prepare(
      `SELECT tier FROM landmarks WHERE property_id = ?`
    ).get(propertyId) as { tier: string } | undefined;
    // Upgrade-only rule: only write if new tier is higher than existing
    if (existing?.tier && (TIER_RANK[tier] ?? 0) <= (TIER_RANK[existing.tier as LandmarkTier] ?? 0)) {
      try { dbgLog(`    SKIP-UPGRADE id=${propertyId} tier ${tier} <= ${existing.tier}\n`); } catch {}
      return;
    }
    this.db.db.prepare(
      `INSERT OR REPLACE INTO landmarks (property_id, landmark, type, maps_url, source, tier, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(propertyId, l.landmark, l.type, l.mapsUrl ?? null, l.source, tier, new Date().toISOString());
  }

  /** Read the nearby-landmarks rotation for a property. No TTL. */
  getNearby(propertyId: number): Array<{ landmark: string; lat: number; lon: number }> | undefined {
    const row = this.db.db.prepare(
      `SELECT nearby FROM landmarks WHERE property_id = ? AND nearby IS NOT NULL`
    ).get(propertyId) as { nearby: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.nearby); } catch { return undefined; }
  }

  putNearby(propertyId: number, nearby: Array<{ landmark: string; lat: number; lon: number }>): void {
    if (nearby.length === 0) return;
    this.db.db.prepare(
      `UPDATE landmarks SET nearby = ? WHERE property_id = ?`
    ).run(JSON.stringify(nearby), propertyId);
  }
}

/** Canonical cache key — now just property.id. Kept for backward compat during migration. */
export function landmarkCacheKey(p: { address?: string; location?: string }): string {
  return `${p.location ?? ''} | ${p.address ?? ''}`.toLowerCase().replace(/\s+/g, ' ');
}

// Cache write: UPGRADE-ONLY. Never overwrite a better tier. Never downgrade.
let _offlineMapRef: OfflineMapStore | undefined;
export function setOfflineMapRef(m: OfflineMapStore | undefined): void { _offlineMapRef = m; }

export function cacheLandmark(
  p: PropertyRow,
  lm: Landmark,
  tier: string,
): void {
  if (!lm?.landmark) return;
  if (p.landmark_tier && (TIER_RANK[tier] ?? 0) <= (TIER_RANK[p.landmark_tier] ?? 0)) return;
  // Uses the LandmarkStore internally — store reference set via LandmarkService constructor
  if (_landmarkStoreInstance) _landmarkStoreInstance.put(p.id, lm, tier as LandmarkTier);
}

let _landmarkStoreInstance: LandmarkStore | undefined;

// Search center: the property row's OWN coordinates, with ONE cross-check.
// geocodeAddress is called NOWHERE in the request path — but the map's own
// ADDRESS resolution is, because it is local, offline and trusted
// (building/interpolated), and the feed's geocode is not always right.
//
// THE EB 94 LESSON (2026-10-10): the feed held lat/lon a `google_cached`
// geocode had put 76m away from the real building, while the map's own
// resolution of "Тоне Томшиќ 25" sat 21m from it. The rotation ran from the
// wrong point and served a bus stop 145m out. A mismatch of more than
// CENTER_MISMATCH_M now prefers the map's point (and nearbyLandmarks queues the
// row so the feed itself gets repaired by the monthly drain).
/** Metres of disagreement above which the map's own address resolution wins. */
export const CENTER_MISMATCH_M = 50;

export interface SearchCenter {
  lat: number; lon: number; trusted: boolean;
  /** Where the point came from — 'map' means the cross-check overrode the feed. */
  source: 'stored' | 'map' | 'geocode' | 'none';
  /** Distance in metres between the stored point and the map's point. */
  mismatchM?: number;
}

export function resolveSearchCenter(p: PropertyRow): SearchCenter {
  // A STREET CENTROID IS NOT A BUILDING POINT (the EB 85 class):
  // `osm_street_anchor` means the address resolved to the middle of a street —
  // the import reaches that stage only after the exact-building and
  // interpolation stages both failed — so the stored point is a NEIGHBOURHOOD-
  // grade guess, exactly like `osm_low_confidence`. Trusting it let a flat the
  // feed records in Ново Лисиче answer «на која улица е?» with a landmark and a
  // pin from the town centre. Both weak labels now take the same path: the
  // map's own resolution gets its chance, and whatever it cannot prove stays
  // untrusted, so no landmark is ever measured from a street middle and served
  // as the property's own address.
  const weakStored = p.geo_source === 'osm_low_confidence' || p.geo_source === 'osm_street_anchor';
  if (p.lat && p.lon && !weakStored) {
    const stored = { lat: p.lat, lon: p.lon };
    const map = _offlineMapRef?.resolvePropertyOffline(p.address ?? '');
    // ONLY A BUILDING-LEVEL MATCH MAY OUTRANK AN EXISTING TRUSTED PIN.
    // 'osm_street_anchor' is a Google-verified STREET CENTROID: the resolver
    // reaches it only after the exact-building AND interpolation stages both
    // failed, so it is street-granularity by construction — it cannot be the
    // more precise answer for an address the feed already resolved to a point.
    // Letting it win inverted the trust order (the EB 62 case: "ТЦ ОЛИМПИКО",
    // Тафталиджe was served from an anchor 2.2 km away while the row's own pin
    // sat ~246 m from the mall, per the agency's own address-overrides file).
    // The anchor still serves as the FALLBACK in the branch below, where there
    // is no trusted pin for it to outrank.
    const buildingLevel = map?.source === 'osm_building' || map?.source === 'osm_interpolated';
    if (map?.trusted && map.lat != null && map.lon != null && buildingLevel) {
      const d = _distM(stored.lat, stored.lon, map.lat, map.lon);
      if (d > CENTER_MISMATCH_M) {
        return { lat: map.lat, lon: map.lon, trusted: true, source: 'map', mismatchM: d };
      }
    }
    return { lat: stored.lat, lon: stored.lon, trusted: true, source: 'stored' };
  }
  // NO TRUSTWORTHY STORED POINT (osm_low_confidence, or none at all): the map's
  // OWN address resolution goes first, and it may be TRUSTED (exact building /
  // interpolated) — the same resolver importGeo and the drain already use.
  //
  // WHY (EB 89, 2026-10-11): the row sat at a fine point but was labelled
  // osm_low_confidence, so this function fell through to geocodeAddress() —
  // which by design never returns trusted:true. The rotation then took the
  // "grace" path (only POIs 300–500m away, a 300m distance floor) and answered
  // "во близина на Полициска Станица" (351m) — while the park across the
  // boulevard (Парк Авионче, 180m) was never even considered. A confirmed
  // building point is a confirmed building point, whatever the feed's label
  // says about it.
  const building = _offlineMapRef?.resolvePropertyOffline(p.address ?? '');
  if (building?.trusted && building.lat != null && building.lon != null) {
    const mismatchM = p.lat && p.lon ? _distM(p.lat, p.lon, building.lat, building.lon) : undefined;
    return { lat: building.lat, lon: building.lon, trusted: true, source: 'map', mismatchM };
  }
  const osm = _offlineMapRef?.geocodeAddress(p.address ?? '');
  if (osm) return { lat: osm.lat, lon: osm.lon, trusted: false, source: 'geocode' };
  return { lat: 0, lon: 0, trusted: false, source: 'none' };
}

/**
 * Extract a landmark name from the property's description text, validated
 * against the local POI table. Returns null-coords for text-only hits
 * (the description SAYS "спроти X" but X isn't in the POI table).
 * Never generates a coordinate link for null-coords results.
 */
const NEAR_RE = /(?:спроти|кај|близина на|до|во близина на)\s+([\p{L}][\p{L} .'-]{2,40})/iu;

export interface DetailsLandmark {
  name: string;
  lat: number | null;
  lon: number | null;
  place_url?: string;
}

/** A sentence end inside a captured span. The description names the anchor and
 *  then keeps talking about the FLAT — "...во близина на Сити Мол. Купатилото
 *  и Кујната се комплет изреновирани..." — and the capture class (letters,
 *  spaces, periods) swallowed the next sentence, so the rotation served
 *  "Сити Мол. Купатилото" as a landmark NAME (EB 48; the same shape on EB 63
 *  "Црногорска Амбасада. Поседува Посебна Спа" and EB 79 "главниот влез на
 *  Клинички Центар. Станот"). Prose is not a place. Cut at the first sentence
 *  end; an ABBREVIATION ("ул.", "бул.", "бр.") is not one, so its token is
 *  exempt — the street guard below then rejects the name as usual. */
const ABBREV_BEFORE_DOT_RE = /(?:^|\s)(?:ул|бул|бр|кв|с|стр|мк|г|д|т)\.$/iu;
function cutAtSentenceEnd(blob: string): string {
  for (let i = 1; i < blob.length; i++) {
    if (blob[i - 1] !== '.') continue;
    if (!/\s/.test(blob[i] ?? '')) continue;                    // "Мол.Купатилото" — no sentence gap
    if (ABBREV_BEFORE_DOT_RE.test(blob.slice(0, i))) continue;  // "ул." is not an ending
    return blob.slice(0, i - 1).trim();
  }
  return blob;
}

export function extractDetailsLandmark(
  details: string | undefined,
  center?: Center,
  offlineMap?: OfflineMapStore,
): DetailsLandmark | null {
  const hits = extractDetailsLandmarks(details, center, offlineMap, 1);
  return hits[0] ?? null;
}

/**
 * FEED LANDMARK PAIRS (the doc's zero-cost add): the feed's own description
 * language is a CHAIN of anchors — "во потегот меѓу X и Y", "спроти X, до Y".
 * Every distinct anchor after the first is a second VERIFIED reference for
 * the same property; the rotation uses the full list instead of repeating
 * one anchor three times. Order: as written in the description (humans list
 * the nearest first). Returns up to `max` distinct, validated anchors.
 */
export function extractDetailsLandmarks(
  details: string | undefined,
  center?: Center,
  offlineMap?: OfflineMapStore,
  max = 3,
): DetailsLandmark[] {
  if (!details || details.length < 10 || max <= 0) return [];
  // All anchor mentions, in written order — the ПОТЕГ chain: "меѓу X и Y",
  // "спроти X", "кај Y", "во близина на Z".
  const CHAIN_RE = /(?:спроти|кај|близина на|до|во близина на|меѓу)\s+([\p{L}][\p{L} .'-]{2,40})/giu;
  const out: DetailsLandmark[] = [];
  const seen = new Set<string>();
  for (const m of details.matchAll(CHAIN_RE)) {
    if (out.length >= max) break;
    let blob = m[1].trim().replace(/[.,]$/, '');
    // SENTENCE BOUNDARY: the anchor is a PLACE, the rest of the span is the
    // ad's prose (see cutAtSentenceEnd).
    blob = cutAtSentenceEnd(blob);
    // Strip trailing junk: quotes, parens
    blob = blob.replace(/[{}`\[\]()"„‟«»'']+$/g, '').trim();
    // Remove leading articles: "на" etc.
    blob = blob.replace(/^на\s+/i, '').trim();
    if (blob.length < 3 || blob.length > 60) continue;
    // THE PAIR RULE (the doc's headline zero-cost add): the feed's signature
    // phrase is "во потегот меѓу X и Y" — TWO anchors in one captured span.
    // Split on the conjunction when both sides look like place names, so a
    // pair yields two verified references instead of one unfindable blob.
    const parts = blob.split(/\s+и\s+/).map(s => s.trim()).filter(s => s.length >= 3);
    const candidates = parts.length >= 2 ? parts : [blob];
    for (const name of candidates) {
      if (out.length >= max) break;
    if (name.length < 3 || name.length > 60) continue;
    // Reject time expressions
    if (/пред\s+\d|\bмесец|\bден|\bгодин|\bнедел|januar|februar|mart|april|maj|juni|juli|avgust|septembar|oktombar|noembar|deke(mbar|c)/iu.test(name)) continue;
    // STREET GUARD (the privacy contract): a street name would leak the
    // exact location — skip it in every layer.
    if (isStreetName(name)) continue;

    // Validate against merged POI table — local, free, fuzzy
    let hit: DetailsLandmark | null = null;
    if (center && offlineMap?.available) {
      const pois = offlineMap.findPoisLike(name, center);
      if (pois.length > 0) {
        hit = { name: pois[0].name, lat: pois[0].lat, lon: pois[0].lon, place_url: pois[0].place_url ?? undefined };
      }
    }
    if (!hit) hit = { name, lat: null, lon: null }; // text-only: may SAY "спроти X"
    const key = hit.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    }
  }
  return out;
}

/**
 * Clean + guard an LLM-provided landmark name. The whole point of the address
 * privacy rule is that the STREET never leaks — so any answer containing the
 * street name (case/space-insensitive) is rejected. Also strips markdown,
 * quotes, numbering ("1. Кафе бар") and keeps only a short clean name.
 */
// A landmark must be a PUBLIC PLACE — a street name (улица/булевар/ул./бул.)
// would hand the client the exact location, defeating the whole privacy
// protocol. Applied to EVERY layer (table included) as a hard guard.
// Unicode boundaries are required: bare "ул" / "пат" match inside words
// ("фаКУЛтет", "ПАТека") unless bounded on both sides.
const STREET_NAME_RE = /(?<![А-Яа-яA-Za-z])(?:улиц(?:а|и|ата|ите)|булевар(?:от|и)?|бул\.?|ул\.?|пат(?:от|и)?|street|boulevard)(?![А-Яа-яA-Za-z])/i;
const isStreetName = (s: string): boolean => STREET_NAME_RE.test(s);
// Time expressions that are NOT landmarks: "пред 2 месеци", "до јануари", etc.
const IS_TIME_EXPR = /пред\s+\d|\bмесец|\bден|\bгодин|\bнедел|\bjanuar|\bfebruar|\bmart|\bapril|\bmaj|\bjuni|\bjuli|\bavgust|\bseptembar|\boktombar|\bnoembar|\bdeke(mbar|c)/iu;

/** Drop a landmark that is actually a street or time expression — every layer is checked. */
function publicPlace(l: Landmark | undefined): Landmark | undefined {
  if (!l) return undefined;
  if (isStreetName(l.landmark)) return undefined;
  if (IS_TIME_EXPR.test(l.landmark)) return undefined;
  return l;
}

/** The client-facing ceiling for a "во близина" claim, in metres. 200 m is
 *  the walk-out-the-door ring: inside it the most RECOGNIZABLE place wins
 *  (embassy, mall, church, school), because that is what a client navigates by;
 *  farther away a name stops being "nearby" and the claim becomes geography
 *  the property cannot honestly support. The runtime rotation
 *  (nearbyLandmarks), the feed enricher and the reader
 *  (properties.parseFeedLandmarks) all use this one number — legacy rows carry
 *  300 m–1.2 km entries and a stored list must not smuggle one past the rule.
 *  A DISTANCE QUESTION ("колку далеку е од GTC?") is NOT a proximity claim and
 *  is answered from the whole city map — see the handler's distance lane. */
export const FEED_LANDMARK_MAX_M = 200;

/** The FIRST entry carries a stronger contract than the rest of the list:
 *  it is the one name a client actually hears ("во близина на X"), so it must
 *  be both MEASURABLE (a real distance inside FEED_LANDMARK_MAX_M) and
 *  RECOGNIZABLE (a type the map engine ranks). An unranked type is exactly how
 *  EB 94's Студентски дом Пелагонија fell out of its own landmark list —
 *  `dormitory` was missing from LANDMARK_PREFERENCE, scored 0, and a 257 m
 *  shopping mall took the first slot.
 *
 *  Returns a human-readable reason, or undefined when the first entry is
 *  compliant. An EMPTY list is not a violation: a property the map cannot
 *  honestly place carries no claim at all (the callers say so explicitly). */
export function firstLandmarkProblem(list: FeedLandmark[] | undefined): string | undefined {
  const first = list?.[0];
  if (!first) return undefined;  // no claim → nothing to verify
  const name = stripPoiAnnotation(first.landmark ?? '') || '(без име)';
  const d = first.distance_m;
  if (typeof d !== 'number' || !Number.isFinite(d)) {
    return `„${name}“ нема измерено растојание — не може да се тврди „во близина“`;
  }
  if (d > FEED_LANDMARK_MAX_M) {
    return `„${name}“ е на ${Math.round(d)} м — над дозволените ${FEED_LANDMARK_MAX_M} м`;
  }
  if (isShopLevelPlace(name, first.type)) {
    return `„${name}“ е продавница, не јавен ориентир`;
  }
  if (typeRank(first.type ?? '') === 0) {
    return `„${name}“ е од непрепознатлив тип „${first.type ?? '(празно)'}“ — не е јавен ориентир`;
  }
  return undefined;
}

/** Strip OUR OWN list annotation from an LLM answer.
 *
 *  The pick prompt hands the model lines like
 *    - AgroTehnA - Head Office (Shopping mall, 257м)
 *  and models regularly echo the whole line back instead of just the name.
 *  Truncated answers lose the closing paren, so it must be stripped balanced
 *  OR dangling — the real 2026-10-10 feed row (EB 94, ANA's enrichment) was
 *  literally `AgroTehnA - Head Office (Shopping mall, 257м` — the client would
 *  have read a name that is half annotation. The parenthetical is metadata
 *  (type, distance) that the runner re-attaches from the POI table, never part
 *  of a landmark name. */
export function stripPoiAnnotation(s: string): string {
  return s
    // The annotation ALWAYS ends in a number: "(Shopping mall, 257м)" — with or
    // without the closing paren (truncated answers) — or a bare " 257м" tail.
    // A name's own parenthetical ("… (привремено затворен)") has no digit and
    // is deliberately left alone.
    .replace(/\s*\([^()]*,\s*\d+(?:[.,]\d+)?\s*(?:м|m|km)?\s*\)?/giu, '')
    .replace(/\s+\d+(?:[.,]\d+)?\s*(?:м|m|km)\s*$/giu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** True when every opening quote has a closing partner. Apostrophes are
 *  ignored — they sit mid-word in Macedonian names ("Кафе 'Мак'"). */
function balancedQuotes(s: string): boolean {
  return (s.match(/[„«]/g) ?? []).length === (s.match(/[“”»]/g) ?? []).length;
}

export function sanitizeLandmarkAnswer(raw: string, street?: string): string | undefined {
  let s = raw.trim().split(/\n/)[0].trim(); // the LLM's first line only
  s = s
    .replace(/^\d+[.)]\s*/, '')        // "1. Кафе бар" / "2) …"
    .replace(/^[„“”«»"'`\[\]()\-*_]+/, '') // leading decoration
    .trim();
  // Trailing decoration — but a name may legitimately CONTAIN quotes
  // („Приватна градинка „Little Me“). If stripping the tail would leave an
  // opening quote without its partner, the tail was content, not decoration.
  const beforeTail = s;
  s = s
    .replace(/[„“”«»"'`\[\]()\-*_]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!balancedQuotes(s) && balancedQuotes(beforeTail)) s = beforeTail.replace(/\s+/g, ' ').trim();
  // …then drop the echoed list annotation (type, distance) — see above.
  s = stripPoiAnnotation(s);
  if (s.length < 2 || s.length > 80) return undefined;
  // The exact street must never appear in the landmark.
  if (street) {
    const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ');
    const st = norm(street);
    if (st.length >= 3 && norm(s).includes(st)) return undefined;
  }
  // Junk guard: must contain at least one letter.
  if (!/[\p{L}]/u.test(s)) return undefined;
  return s;
}

// ── CLIENT-TYPED PLACE WORDS ─────────────────────────────────────────────────
// A client names a place the way people SAY it, not the way the map stores it:
// definite forms („трговскиот“, „пазарчето“ — and the Latin keyboard twins
// „trgovskiot“, „pazarceto“) plus ordinary plural forms. The POI table carries
// the base names, so the definite article has to come off before the lookup.
// TWO-CHARACTER articles are tried first: „трговскиот“ must strip to
// „трговски“ (not to „трговск“), because the shorter stem is the one the map
// indexes. A stem is never taken below 4 characters — „тато“ must not become
// „та“ and match half the city.
const DEFINITE_SUFFIXES = ['ot', 'ov', 'ta', 'to', 'te', 'та', 'то', 'те', 'от', 'ов',
  'iot', 'ite', 'ata', 'oto', 'иот', 'ите', 'ата', 'ото'];

/** The forms of a client-typed place word worth trying against the POI table:
 *  the word itself, then the same word with its definite article removed.
 *  Returns [] for anything too short to be a place name. */
export function anchorWordForms(word: string): string[] {
  const base = word.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  if (base.length < 3) return [];
  const out = [base];
  // THE ч/ц TWIN. Latin keyboards spell ч as "c" („pazarceto“) as often as
  // "ch" („pazarcheto“); the script bridge only knows one of them, so the ч
  // reading is offered as its own form. Bounded on purpose: only c before a
  // front vowel, the position where Macedonian actually writes ч/ќ.
  const chTwin = base.replace(/c(?=[ei])/g, 'ch');
  if (chTwin !== base) out.push(chTwin);
  // …and its Cyrillic side: the runtime hands this function NORMALIZED text
  // („пазарцето“, from the client's „pazarceto“), where the same ч/ц choice is
  // written ц. Both twins are offered; the original is always tried first.
  const chTwinCyr = base.replace(/ц(?=[еи])/g, 'ч');
  if (chTwinCyr !== base) out.push(chTwinCyr);
  for (const w of [...out]) {
    for (const suf of DEFINITE_SUFFIXES) {
      if (!w.endsWith(suf)) continue;
      const stem = w.slice(0, -suf.length);
      if (stem.length < 4) continue;
      out.push(stem);
      break;
    }
  }
  return [...new Set(out)];
}

export class LandmarkService {
  private store: LandmarkStore;

  constructor(private db: Db, private opts: LandmarkOpts = {}) {
    this.store = new LandmarkStore(db);
    _landmarkStoreInstance = this.store;
    setOfflineMapRef(opts.offlineMap);
  }

  /** Public access to the offline map for external callers (handler, scripts). */
  get offlineMap(): OfflineMapStore | undefined { return this.opts.offlineMap; }

  /** Public passthrough: resolve a place name against the offline POI table
   *  ("kade e toa Helen Doron?"). Undefined when the map is unavailable or
   *  nothing matches. When center is given, the NEAREST branch of a chain
   *  wins ("TTK Banka" near Капиштец = the Beverly Hills branch, not Ново
   *  Лисиче). */
  findPlace(name: string, center?: { lat: number; lon: number }): { name: string; lat: number; lon: number; type?: string; place_url?: string; place_id?: string } | undefined {
    if (!this.opts.offlineMap?.available) return undefined;
    return this.opts.offlineMap.findPoiByName(name, center);
  }

  /** MISS RECOVERY for a name the exact passes could not place: the same map,
   *  one slipped letter allowed (OfflineMapStore.findPoiByNameLoose). Called
   *  ONLY after the exact lookup already failed or was refused, so a typo can
   *  never displace an exact hit. The caller still runs the name-coverage
   *  guard on the result. */
  findPlaceLoose(name: string, center?: { lat: number; lon: number }): { name: string; lat: number; lon: number; type?: string; place_url?: string; place_id?: string } | undefined {
    if (!this.opts.offlineMap?.available) return undefined;
    return this.opts.offlineMap.findPoiByNameLoose(name, center);
  }

  /** WHICH NEIGHBOURHOOD a point sits in — the map's own OSM suburb rows.
   *  Answers „во која населба е ТЦ Лептокарија?“ and seeds the area a place
   *  implies, so the funnel stops guessing a district from feed votes.
   *  Undefined when the map has no quarter tagged nearby: the caller then says
   *  it does not know instead of naming a district it never measured. */
  areaAt(lat: number, lon: number, maxM = 2500): { name: string; distance_m: number } | undefined {
    if (!this.opts.offlineMap?.available) return undefined;
    try { return this.opts.offlineMap.areaAt(lat, lon, maxM); } catch { return undefined; }
  }

  /** A place word the CLIENT typed, resolved to a LOCAL anchor of a property —
   *  the map's position for it, never further than maxM away.
   *
   *  WHY the two extra rules on top of findPlace():
   *   1. CLIENTS WRITE THE DEFINITE FORM. „od stranata na trgovskiot ili odkaj
   *      pazarceto“ ([01:29] capture) resolves to NOTHING as typed, while
   *      „trgovski“ finds the mall. anchorWordForms() strips the article; the
   *      map's own script bridge does the Latin/Cyrillic rest.
   *   2. A NAME ALONE CAN BE ANOTHER NEIGHBOURHOOD. „pazarceto“ also matches
   *      „пазарчето Тафталиџе“ 1.9 km away, and „trgovski“ matches „Трговски
   *      Лисиче“ 5.5 km away. A side answer built on either would tell the
   *      client their flat is on the side of a place two neighbourhoods over —
   *      invented geography, which is exactly what the landmark rules exist to
   *      prevent. Everything beyond maxM is therefore not an anchor of THIS
   *      property, however well the name matches. */
  findAnchor(word: string, center: { lat: number; lon: number }, maxM = 900):
  { name: string; lat: number; lon: number; distance_m: number; place_id?: string } | undefined {
    const map = this.opts.offlineMap;
    if (!map?.available || !center || !Number.isFinite(center.lat) || !Number.isFinite(center.lon)) return undefined;
    // FIRST FORM THAT RESOLVES WINS — the forms are ordered by FIDELITY (the
    // client's own spelling, then the ч/ц twins, then the definite-stem), so a
    // synthetic twin must never outrank the exact reading by happening to land
    // nearer. The 2026-10-29 [01:29] capture: «трговски центар буњаковец»
    // resolved the MALL under the exact spelling, while its ч twin matched only
    // a BUS STOP of the same name — and "nearest across forms" chose the stop,
    // so the side answer named the mall as both the side AND the farther place.
    // The nearest BRANCH is still chosen, by findPoiByName itself (its center
    // tie-break).
    for (const form of anchorWordForms(word)) {
      let hit: { name: string; lat: number; lon: number; place_url?: string; place_id?: string } | undefined;
      try { hit = map.findPoiByName(form, center); } catch { hit = undefined; }
      if (!hit || !Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) continue;
      const d = Math.round(_distM(center.lat, center.lon, hit.lat, hit.lon));
      if (d > maxM) continue;
      return { name: hit.name, lat: hit.lat, lon: hit.lon, distance_m: d, place_id: hit.place_id };
    }
    return undefined;
  }

  /** Resolve the approximate location for a property. Cached in the DB after
   *  the first successful layer — later calls cost nothing. */
  async resolve(p: { id?: number; eb: number; address?: string; location?: string; details?: string; landmarks?: FeedLandmark[]; geo_source?: string | null; lat?: number | null; lon?: number | null }): Promise<Landmark> {
    // 0) FEED layer
    //    PROXIMITY GUARD (same contract as the table layer below): a
    //    feed-authored landmark can be wrong upstream — an earlier enrichment
    //    wrote a theater ~750 m off onto EB 78's Supabase record, and this
    //    layer is trusted blindly by everything downstream. When both the
    //    property position and the landmark position are computable, reject
    //    any entry too far to honestly be called "blizina".
    if (p.landmarks && p.landmarks.length > 0) {
      let propGeo: { lat: number; lon: number } | undefined;
      try {
        propGeo = p.address && this.opts.offlineMap?.available
          ? this.opts.offlineMap.geocodeAddress(p.address) : undefined;
      } catch { propGeo = undefined; }
      // The SAME ring the client-facing claim obeys — a feed landmark the chat
      // cannot honestly call "во близина" is not a usable answer here either.
      const FEED_MAX_DISTANCE_M = FEED_LANDMARK_MAX_M;
      type PoiHit = { lat: number; lon: number; name: string; place_url?: string; place_id?: string } | undefined;
      // PIN, NOT SEARCH (the banned link form): the feed stores Google's
      // *name-search* URL ("maps/search/?api=1&query=<name>"), which opens a
      // results LIST rather than the place — the exact form the project banned
      // for landmark answers. The landmark NAME is authoritative from the feed;
      // the PIN is resolved here against the offline POI table — the matched
      // POI's own coordinates, i.e. a coordinate pin (its place_id serves the
      // exact place card only when no coordinate exists). The feed's URL survives
      // only
      // for places the map does not know, where it is the only evidence there is.
      const guarded = p.landmarks.map(l => {
        let poi: PoiHit;
        try {
          poi = this.opts.offlineMap?.available ? this.opts.offlineMap.findPoiByName(l.landmark) : undefined;
        } catch { poi = undefined; }
        // A SHOP INSIDE A COMPLEX IS THE COMPLEX (the owner's EB 53 rule): the
        // feed had «Butik Galion» typed «Shopping mall» 35 m out and it won the
        // rotation, so the card claimed the flat sits near a boutique most
        // people have never heard of — while ТЦ Бисер, the complex that
        // boutique is inside, is the name from that neighbourhood. A shop with
        // no complex around it carries no claim at all.
        let name = l.landmark;
        let entry = l;
        if (isShopLevelPlace(name, l.type)) {
          const complex = poi ? this.opts.offlineMap?.enclosingComplex(poi.lat, poi.lon) : undefined;
          if (!complex) return { l, poi, hit: undefined as Landmark | undefined };
          name = complex.name;
          poi = { ...complex } as PoiHit;
          // The substituted place's OWN distance replaces the shop's (the feed
          // row said 35 m for the boutique; the complex is measured from the
          // same property point), or the ranking would compare stale numbers.
          const d = propGeo ? Math.round(_distM(propGeo.lat, propGeo.lon, complex.lat, complex.lon)) : l.distance_m;
          entry = { ...l, landmark: name, distance_m: d };
        }
        const pin = poi ? landmarkLink(name, poi.place_id ?? null, poi.lat, poi.lon) : '';
        return { l: entry, poi, hit: publicPlace({
          landmark: name, type: l.type ?? 'place',
          mapsUrl: pin || l.maps_url, source: 'feed' as const,
        }) };
      })
        .filter((x): x is { l: FeedLandmark; poi: PoiHit; hit: Landmark } => !!x.hit)
        .filter(x => {
          if ((x.l.distance_m ?? 0) > FEED_MAX_DISTANCE_M) return false;
          if (!propGeo || !x.poi) return true; // cannot measure — benefit of the doubt
          try {
            const d = _distM(propGeo.lat, propGeo.lon, x.poi.lat, x.poi.lon);
            if (d > FEED_MAX_DISTANCE_M) {
              try { dbgLog(
                `[${new Date().toISOString()}] EB ${p.eb}: REJECT-FEED ${x.l.landmark} — ${Math.round(d)}m > ${FEED_MAX_DISTANCE_M}m\n`); } catch {}
              return false;
            }
          } catch { /* measurement failure is not grounds for rejection */ }
          return true;
        });
      const ranked = guarded
        .sort((a, b) => {
          // Prefer malls first ("Беверли Хилс" / "ТЦ Бисер" / "Рамстор"),
          // then by distance. People navigate by malls, not by kiosks.
          // Canonical: typeRank() (normalized) instead of exact-type lists.
          const aMall = typeRank(a.l.type) >= typeRank('mall') ? 0 : 1;
          const bMall = typeRank(b.l.type) >= typeRank('mall') ? 0 : 1;
          if (aMall !== bMall) return aMall - bMall;
          return (a.l.distance_m ?? Infinity) - (b.l.distance_m ?? Infinity);
        });
      if (ranked.length > 0) {
        // THE FIRST NAME IS THE ONE THE CLIENT HEARS, so it is the TOP of this
        // ranking — most significant, then nearest — never an EB-hash pick from
        // the top three. The hash made the same flat say a different neighbour
        // than its own rotation led with (EB 53: «Трговски центар Капитол» on
        // the card while the map's nearest complex — ТЦ Бисер, 55 m — led the
        // page), which is exactly the disagreement between chat and page the
        // roster-first rule exists to prevent. Variety lives in the ROTATION
        // (nearbyLandmarks), not in the first claim.
        const _r = ranked[0].hit; dbgLog(
        `[${new Date().toISOString()}] EB ${p.eb}: RETURN-FEED ${_r.landmark} [${_r.source}]\n`); return _r;
      }
    }

    // 2) DB cache — keyed by property.id, upgrade-only, no TTL.
    //    canServeLandmark decides whether the cached tier is trustworthy.
    //    osm_low_confidence → NEVER served. osm_poi → served only if center trusted.
    const cached = p.id != null ? this.store.get(p.id) : undefined;
    if (cached && canServeLandmark({ id: p.id!, landmark_tier: cached.tier, geo_source: p.geo_source } as PropertyRow)) {
      const hit = publicPlace({
        landmark: cached.landmark, type: cached.type,
        mapsUrl: cached.mapsUrl ?? undefined,
        source: cached.source as Landmark['source'],
      });
      if (hit) { dbgLog(
        `[${new Date().toISOString()}] EB ${p.eb}: RETURN-DB-CACHE ${hit.landmark} [${hit.source}] tier=${cached.tier} id=${p.id}\n`); return hit; }
    }
    if (cached && !canServeLandmark({ id: p.id!, landmark_tier: cached.tier, geo_source: p.geo_source } as PropertyRow)) {
      dbgLog(
        `[${new Date().toISOString()}] EB ${p.eb}: SKIP-BLOCKED-CACHE ${cached.landmark} [${cached.source}] tier=${cached.tier} → re-resolving\n`);
    }

    // 3) DETAILS extraction — parse landmark names from the property's own
    //    description text ("спроти ОУ Димитар Миладинов", "кај ТЦ Олимпико").
    //    Zero cost, always available. Validated against the local POI table —
    //    returns coords when matched. Requires a TRUSTED center: validating
    //    "спроти X" against POIs within 900m of an interpolated guess would
    //    bless a wrong building as the reference. Untrusted → text-only hits
    //    only (name, null coords — never a link), which resolve() skips so
    //    the property lands in the honest fallback + re-resolve queue.
    const detailsCenter = resolveSearchCenter({ ...p, id: p.id! } as PropertyRow);
    const detailsHit = detailsCenter.trusted
      ? extractDetailsLandmark(p.details, detailsCenter, this.opts.offlineMap)
      : null;
    if (detailsHit) {
      const l = publicPlace({ landmark: detailsHit.name, type: 'details', source: 'extract' as const });
      if (l) { dbgLog(
        `[${new Date().toISOString()}] EB ${p.eb}: RETURN-DETAILS ${l.landmark} [${l.source}] coords=${detailsHit.lat},${detailsHit.lon}\n`); if (p.id != null) this.store.put(p.id, l, 'extract'); return l; }
    }

    // 4) OFFLINE MAP — local OSM POIs + addresses, zero network. The map has
    //    thousands of named POIs; geocoding is local (exact building →
    //    interpolation → centroid). No Photon/OSM/Google fallback — if the
    //    local geocoder can't match the address, the property gets the honest
    //    "населба" fallback and is queued for the monthly Google upgrade.
    if (this.opts.offlineMap?.available) {
      try {
        // 4a) Try the address as a POI name first ("Кај Бранка", "Палома Бјанка")
        //     A named complex is a landmark in itself — no center needed.
        if (p.address) {
          const poi = this.opts.offlineMap.findPoiByName(p.address);
          if (poi) {
            const l = publicPlace({ landmark: poi.name, type: 'poi', source: 'osm' as const });
            if (l) { if (p.id != null) this.store.put(p.id, l, 'osm_poi'); return l; }
          }
        }
        // 4b) Nearest POI around the search center. resolveSearchCenter prefers
        //    stored property coordinates (trusted); only rows WITHOUT coords
        //    fall back to the local geocodeAddress (untrusted). Never geocode
        //    the address when the property already carries its real position.
        //    TRUST GATE: an untrusted center (OSM street/centroid guess) never
        //    produces a served landmark — searching from it would re-create the
        //    "Златна вилушка 1km away" bug. Such rows fall through to the
        //    honest fallback and the monthly Google upgrade queue.
        const center = resolveSearchCenter({ ...p, id: p.id! } as PropertyRow);
        const geo = center.trusted && center.lat && center.lon ? center : undefined;
        if (geo) {
          // ADAPTIVE RADIUS — a landmark 150m away is a real reference ("кај
          // Тинекс"); "близина на ТЦ Џевахир" 1.1km away is not. Start tight
          // at 150m, widen only when the area is genuinely sparse.
          let pois = this.opts.offlineMap.nearestPois(geo.lat, geo.lon, 150, 25);
          if (pois.length === 0) pois = this.opts.offlineMap.nearestPois(geo.lat, geo.lon, 400, 25);
          if (pois.length === 0) pois = this.opts.offlineMap.nearestPois(geo.lat, geo.lon, 1000, 25);
          // A SHOP IS NOT A LANDMARK (the owner's EB 53 rule): a boutique
          // typed «Shopping mall» by Google used to win the mall tier by TYPE
          // alone. Tenant rows are removed first, so the complex that holds
          // them (ТЦ Бисер) is what the card names.
          const anchors = pois.filter(po => !isShopLevelPlace(po.name, po.type));
          if (anchors.length > 0) pois = anchors;
          // Three-tier landmark preference (canonical, typeRank-based):
          //   1. Malls — everyone knows "Беверли Хилс" / "ТЦ Бисер" / "Рамстор"
          //   2. Institutional anchors (schools, hospitals, universities, …)
          //   3. Any POI with name >= 3 chars (fallback)
          const best = pois.find(po => po.name.length >= 3 && typeRank(po.type) >= typeRank('mall'))
            ?? pois.find(po => po.name.length >= 3 && typeRank(po.type) >= typeRank('school'))
            ?? pois.find(po => po.name.length >= 3);
          if (best) {
            const l = publicPlace({ landmark: best.name, type: best.type, source: 'offline' as const });
            if (l) { dbgLog(
            `[${new Date().toISOString()}] EB ${p.eb}: RETURN-OFFLINE-MAP ${l.landmark} [${l.source}]\n`); if (p.id != null) this.store.put(p.id, l, 'osm_poi'); return l; }
          }
        }
      } catch (e) { try { dbgLog(
          `[${new Date().toISOString()}] EB ${p.eb}: OFFLINE-MAP-FAILED: ${(e as Error).message}\n`); } catch {} }
    }

    return { landmark: '', type: '', source: 'none' };
  }

  /** Batch stamp: enriches properties with `landmark` before they reach any
   *  reply builder (cards, LLM context, where-is, availability). */
  async enrich(props: Array<{ id?: number; eb: number; address?: string; location?: string; details?: string; landmark?: string; landmarks?: FeedLandmark[]; geo_source?: string | null; lat?: number | null; lon?: number | null }>): Promise<void> {
    await Promise.all(props.map(async pr => {
      // Feed landmarks from Supabase (ANA's import-time resolution) are
      // authoritative — never override them. But ALWAYS re-resolve for all
      // other cases: the DB cache (sub-ms) handles performance, and skipping
      // based on pr.landmark causes stale results when the PropertyService
      // caches a mutated property object for 5 minutes.
      const l = await this.resolve(pr);
      if (l.source !== 'none') pr.landmark = l.landmark;
      try { dbgLog(
        `[${new Date().toISOString()}] EB ${pr.eb}: resolved=${l.landmark} source=${l.source} addr=${JSON.stringify(pr.address?.substring(0, 40))}\n`); } catch {}
    }));
  }

  /** Returns the top 3 nearby landmarks with coordinates for rotation.
   *  Uses resolveSearchCenter (property.lat/lon only, no geocodeAddress in
   *  request path). If the center is untrusted, pushes to the re-resolve
   *  queue and returns empty — the handler serves an honest fallback.
   *  Client-facing claims are capped at FEED_LANDMARK_MAX_M (200 m), and the
   *  order inside that ring is significance-first. */
  nearbyLandmarks(p: PropertyRow): Array<{ landmark: string; lat: number; lon: number; place_url?: string; place_id?: string }> {
    const center = resolveSearchCenter(p);

    // CENTRE MISMATCH → queue the property so the FEED gets repaired, not just
    // this answer. The monthly drain re-resolves it from the local map first
    // (free) and only falls back to a budget-guarded SerpApi geocode.
    if (center.source === 'map' && (center.mismatchM ?? 0) > CENTER_MISMATCH_M && p.id != null) {
      try {
        this.db.db.prepare(
          `INSERT OR IGNORE INTO geo_reresolve_queue (property_id, reason, created_at) VALUES (?, ?, ?)`
        ).run(p.id, 'center_mismatch', new Date().toISOString());
      } catch {}
      try { dbgLog(
        `[${new Date().toISOString()}] EB ${p.eb}: NEARBY-CENTER-MISMATCH stored=${Math.round(center.mismatchM ?? 0)}m off → using the map's own address point, queued\n`); } catch {}
    }

    // FEED REPAIR for an untrustworthy STORED centre (missing coordinates, or a
    // neighbourhood centroid). resolveSearchCenter may still hand us a trusted
    // map point below, so the ANSWER is good — but the feed row itself must be
    // corrected, or every future reader walks back into the same path and the
    // public page keeps a missing/wrong pin (EB 89: trusted building point
    // available, feed row still labelled osm_low_confidence). The monthly drain
    // re-resolves it offline for free and writes the real geo_source.
    const storedUntrusted = !p.lat || !p.lon || p.geo_source === 'osm_low_confidence';
    if (storedUntrusted && p.id != null) {
      try {
        this.db.db.prepare(
          `INSERT OR IGNORE INTO geo_reresolve_queue (property_id, reason, created_at) VALUES (?, ?, ?)`
        ).run(p.id, 'low_confidence_center', new Date().toISOString());
      } catch {}
    }

    // ── FEED ROSTER FIRST (fix-list item 3) ────────────────────────────────
    // The property's own curated list is the answer whenever it exists: it is
    // what the agency's page shows, ranked and distance-capped at import time,
    // and every entry came from this same map. Rotating freshly-scanned POIs
    // while a curated roster sits right there is how the chat and the page came
    // to disagree (EB 76: the page's Капиштец entry vs the map's embassy row).
    // The scan below is the FALLBACK — for a property the feed has not placed
    // yet, or whose whole roster is stale (unpinnable). NOTE: the roster does
    // not need a trusted center — it was validated against the property's own
    // address at import — so it also serves the low-confidence rows the grace
    // floor below can only approximate.
    const roster = feedRosterSlots(p, this.opts.offlineMap, center);
    if (roster.length > 0) {
      try { dbgLog(
        `[${new Date().toISOString()}] EB ${p.eb}: NEARBY-FEED ${roster.map(r => r.landmark).join(', ')}\n`); } catch {}
      return roster;
    }

    if (!center.trusted) {
      // NO GRACE CLAIMS (the 200 m ring). A low-confidence centre is a
      // neighborhood centroid, not a building point: any POI around it may be
      // a few hundred metres from the real door in either direction, so a
      // "во близина на X" built on it is invented geography. The old
      // 300 m-floor / 500 m-ceiling compromise cannot exist inside a 200 m
      // ring (the floor is outside the cap), so the turn is honestly empty
      // and the row is queued for a real geocode.
      try {
        this.db.db.prepare(
          `INSERT OR IGNORE INTO geo_reresolve_queue (property_id, reason, created_at) VALUES (?, ?, ?)`
        ).run(p.id, 'low_confidence_center', new Date().toISOString());
      } catch {}
      try { dbgLog(
        `[${new Date().toISOString()}] EB ${p.eb}: NEARBY-BLOCKED center untrusted (lat=${center.lat}, lon=${center.lon}) → queue\n`); } catch {}
      return [];
    }

    // THE RING — one radius, the honesty cap. Inside 200 m the map's own
    // significance-first order decides (embassy/mall/church/school before the
    // closer pharmacy — see OfflineMapStore.nearestPois). No adaptive
    // widening: 200 m IS the claim, so a sparse block gets fewer names rather
    // than a farther place presented as "nearby".
    let found: Array<{ name: string; distance_m: number; lat: number; lon: number; place_url?: string; place_id?: string }> = [];
    if (this.opts.offlineMap?.available) {
      found = this.opts.offlineMap.nearestPois(center.lat, center.lon, FEED_LANDMARK_MAX_M, 50)
        .filter(poi => poi.distance_m <= FEED_LANDMARK_MAX_M && poi.lat != null && poi.lon != null)
        // A SHOP IS NOT A LANDMARK (the owner's EB 53 rule): the rotation never
        // names a tenant — the complex it stands in is its own POI row and
        // fills the slot honestly.
        .filter(poi => !isShopLevelPlace(poi.name, poi.type))
        .slice(0, 3)
        .map(poi => ({ name: poi.name, distance_m: poi.distance_m, lat: poi.lat!, lon: poi.lon!, place_url: poi.place_url ?? undefined, place_id: poi.place_id ?? undefined }));
    }

    // FEED LANDMARK PAIRS (the doc's zero-cost add): the feed's own
    // description is a CHAIN of anchors — "во потегот меѓу X и Y", "спроти
    // X, до Y". Every validated anchor is a second human-curated reference
    // for THIS property; top the POI rotation up with them (deduped) so the
    // L1→L2→L3 rotation carries the anchors ordinary people actually say.
    if (p.details && p.details.length >= 10) {
      const chain = extractDetailsLandmarks(p.details, { lat: center.lat, lon: center.lon, trusted: true }, this.opts.offlineMap, 2);
      for (const d of chain) {
        if (found.length >= 3) break;
        if (d.lat == null || d.lon == null) continue; // never claim coords for an unvalidated anchor
        if (found.some(f => f.name.toLowerCase() === d.name.toLowerCase())) continue;
        // The chain anchors pass the same ring test as everything else — an
        // anchor named in the description is not "во близина" just because
        // the copy mentioned it.
        const dM = Math.round(_distM(center.lat, center.lon, d.lat, d.lon));
        if (dM > FEED_LANDMARK_MAX_M) continue;
        found.push({ name: d.name, distance_m: dM, lat: d.lat, lon: d.lon, place_url: d.place_url, place_id: undefined });
      }
    }

    if (found.length > 0) {
      const tier: LandmarkTier = 'osm_poi';
      cacheLandmark(p, { landmark: found[0].name, type: 'poi', source: 'offline' }, tier);
      try { dbgLog(
        `[${new Date().toISOString()}] EB ${p.eb}: NEARBY-OK ${found.map(f => f.name).join(', ')} center=(${center.lat},${center.lon})\n`); } catch {}
    } else {
      try {
        this.db.db.prepare(
          `INSERT OR IGNORE INTO geo_reresolve_queue (property_id, reason, created_at) VALUES (?, ?, ?)`
        ).run(p.id, 'no_landmark', new Date().toISOString());
      } catch {}
      try { dbgLog(
        `[${new Date().toISOString()}] EB ${p.eb}: NEARBY-EMPTY no POIs within ${FEED_LANDMARK_MAX_M}m → queue\n`); } catch {}
    }

    return found.map(f => ({ landmark: f.name, lat: f.lat, lon: f.lon, place_url: f.place_url, place_id: f.place_id }));
  }
}
