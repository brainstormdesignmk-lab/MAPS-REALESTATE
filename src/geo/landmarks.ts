
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
import { OfflineMapStore, type Center } from './offlineMap';
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
}

export function centerTrusted(geoSource: string | null | undefined): boolean {
  // Trusted: real geocodes (stored / google_cached) AND the Phase-1 offline
  // import resolutions (osm_building exact / osm_interpolated between two
  // neighbours). Untrusted: osm_low_confidence (street centroid, endpoint
  // clamp, name-fail) — never anchors a landmark claim.
  return geoSource === 'stored' || geoSource === 'google_cached'
    || geoSource === 'osm_building' || geoSource === 'osm_interpolated';
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
import { distM as _distM, propertyAreaLink, fullCoordsLink, landmarkLink } from './precision';
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

// Search center: property row ONLY. geocodeAddress is called NOWHERE in the request path.
export function resolveSearchCenter(p: PropertyRow): { lat: number; lon: number; trusted: boolean } {
  if (p.lat && p.lon && p.geo_source !== 'osm_low_confidence') {
    return { lat: p.lat, lon: p.lon, trusted: true };
  }
  const osm = _offlineMapRef?.geocodeAddress(p.address ?? '');
  if (osm) return { lat: osm.lat, lon: osm.lon, trusted: false };
  return { lat: 0, lon: 0, trusted: false };
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

export function extractDetailsLandmark(
  details: string | undefined,
  center?: Center,
  offlineMap?: OfflineMapStore,
): DetailsLandmark | null {
  if (!details || details.length < 10) return null;
  const m = details.match(NEAR_RE);
  if (!m) return null;
  let name = m[1].trim().replace(/[.,]$/, '');
  // Strip trailing junk: quotes, parens
  name = name.replace(/[{}`\[\]()"„‟«»'']+$/g, '').trim();
  // Remove leading articles: "на" etc.
  name = name.replace(/^на\s+/i, '').trim();
  if (name.length < 3 || name.length > 60) return null;
  // Reject time expressions
  if (/пред\s+\d|\bмесец|\bден|\bгодин|\bнедел|januar|februar|mart|april|maj|juni|juli|avgust|septembar|oktombar|noembar|deke(mbar|c)/iu.test(name)) return null;

  // Validate against merged POI table — local, free, fuzzy
  if (center && offlineMap?.available) {
    const pois = offlineMap.findPoisLike(name, center);
    if (pois.length > 0) {
      return { name: pois[0].name, lat: pois[0].lat, lon: pois[0].lon, place_url: pois[0].place_url ?? undefined };
    }
  }
  // Text-only hit: may SAY "спроти X", never generates a coordinate link
  return { name, lat: null, lon: null };
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

export function sanitizeLandmarkAnswer(raw: string, street?: string): string | undefined {
  let s = raw.trim().split(/\n/)[0].trim(); // the LLM's first line only
  s = s
    .replace(/^\d+[.)]\s*/, '')        // "1. Кафе бар" / "2) …"
    .replace(/^[„“”«»"'`\[\]()\-*_]+/, '') // leading decoration
    .replace(/[„“”«»"'`\[\]()\-*_]+$/, '') // trailing decoration
    .replace(/\s+/g, ' ')
    .trim();
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
   *  nothing matches. */
  findPlace(name: string): { name: string; lat: number; lon: number; place_url?: string; place_id?: string } | undefined {
    if (!this.opts.offlineMap?.available) return undefined;
    return this.opts.offlineMap.findPoiByName(name);
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
      const FEED_MAX_DISTANCE_M = 800;
      const guarded = p.landmarks.map(l => ({ l, hit: publicPlace({ landmark: l.landmark, type: l.type ?? 'place', mapsUrl: l.maps_url, source: 'feed' as const }) }))
        .filter((x): x is { l: FeedLandmark; hit: Landmark } => !!x.hit)
        .filter(x => {
          if ((x.l.distance_m ?? 0) > FEED_MAX_DISTANCE_M) return false;
          if (!propGeo || !this.opts.offlineMap) return true;
          try {
            const poi = this.opts.offlineMap.findPoiByName(x.l.landmark);
            if (!poi) return true; // cannot measure — give it the benefit of the doubt
            const d = _distM(propGeo.lat, propGeo.lon, poi.lat, poi.lon);
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
        const top = ranked.slice(0, 3);
        const _r = top[Math.abs(p.eb * 2654435761) % top.length].hit; dbgLog(
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
   *  Client-facing claims are capped at 500m. */
  nearbyLandmarks(p: PropertyRow): Array<{ landmark: string; lat: number; lon: number; place_url?: string; place_id?: string }> {
    const center = resolveSearchCenter(p);

    if (!center.trusted) {
      try {
        this.db.db.prepare(
          `INSERT OR IGNORE INTO geo_reresolve_queue (property_id, reason, created_at) VALUES (?, ?, ?)`
        ).run(p.id, 'low_confidence_center', new Date().toISOString());
      } catch {}
      try { dbgLog(
        `[${new Date().toISOString()}] EB ${p.eb}: NEARBY-BLOCKED center untrusted (lat=${center.lat}, lon=${center.lon}) → queue\n`); } catch {}
      return [];
    }

    // Adaptive widening — POI search; client-facing claims capped at 500m
    let found: Array<{ name: string; distance_m: number; lat: number; lon: number; place_url?: string; place_id?: string }> = [];
    if (this.opts.offlineMap?.available) {
      for (const radius of [150, 300, 600, 900]) {
        const pois = this.opts.offlineMap.nearestPois(center.lat, center.lon, radius, 50);
        if (pois.length >= 3 || radius === 900) {
          found = pois
            .filter(poi => poi.distance_m <= 500 && poi.lat != null && poi.lon != null)
            .slice(0, 3)
            .map(poi => ({ name: poi.name, distance_m: poi.distance_m, lat: poi.lat!, lon: poi.lon!, place_url: poi.place_url ?? undefined, place_id: poi.place_id ?? undefined }));
          break;
        }
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
        `[${new Date().toISOString()}] EB ${p.eb}: NEARBY-EMPTY no POIs within 500m → queue\n`); } catch {}
    }

    return found.map(f => ({ landmark: f.name, lat: f.lat, lon: f.lon, place_url: f.place_url, place_id: f.place_id }));
  }
}
