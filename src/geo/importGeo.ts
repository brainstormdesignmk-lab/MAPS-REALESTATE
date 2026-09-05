// Phase-1 import hook: instant OFFLINE geo resolution at property-import time.
//
// Replaces any import-time geocode idea (SerpApi/OSM/LLM at import). Pure
// SQLite + local map — this module never touches the network:
//
//   1. resolvePropertyOffline(address) — exact building → interpolated →
//      street centroid → honest fail (never a fabricated precise point).
//   2. Trusted result (osm_building / osm_interpolated):
//        • nearby POIs computed OFFLINE right now from the merged POI table,
//          centered on the resolved building — not on a re-geocode of the
//          address text.
//        • the top landmark is cached (property_id keyed, tier osm_poi) so the
//          FIRST client ask is served from cache with zero work.
//   3. Untrusted result (osm_low_confidence — centroid, endpoint clamp,
//      name-fail like "БИСЕР"): NEVER cached as a landmark; the property is
//      enqueued for the monthly cron Google-geocode upgrade. No client ever
//      sees a wrong claim, and the row still gets the honest low-trust tag.
//
// The property row itself lives in Supabase (this repo is the runtime). The
// caller (ANA / feed sync) persists the returned { lat, lon, geo_source,
// geocoded_at } onto the property row; everything else here is local state.

import { Db } from '../store/db';
import { LandmarkService, type PropertyRow } from './landmarks';
import { OfflineMapStore, type OfflineResolveSource } from './offlineMap';

export interface ImportFeedRow {
  /** property id (EB alias) — the landmarks-cache + queue key */
  id: number;
  eb?: number;
  address?: string;
  location?: string;
}

export interface ImportGeoDeps {
  db: Db;
  offlineMap?: OfflineMapStore;
}

export interface ImportGeoResult {
  /** Geo fields for the caller to persist on the property row (Supabase). */
  lat: number | null;
  lon: number | null;
  geo_source: OfflineResolveSource;
  geocoded_at: string | null;
  /** True when a nearby landmark was found OFFLINE and cached at import. */
  landmarkCached: boolean;
  /** 'no_trusted_center' | 'no_landmark' when the property was queued for the
   *  monthly cron upgrade; null when fully resolved at import. */
  queueReason: 'no_trusted_center' | 'no_landmark' | null;
}

/** Enqueue a property for re-resolution (local SQLite, best-effort). */
function enqueue(db: Db, propertyId: number, reason: string): void {
  try {
    db.db.prepare(
      `INSERT OR IGNORE INTO geo_reresolve_queue (property_id, reason, created_at) VALUES (?, ?, ?)`
    ).run(propertyId, reason, new Date().toISOString());
  } catch { /* queue is best-effort — never blocks an import */ }
}

/** Resolve + cache a NEW property's location at import time. Pure local —
 *  zero fetch calls, zero SerpApi/OSM/LLM. Blocking-test contract:
 *    • real street+number → lat/lon + trusted geo_source + a cached landmark
 *    • "БИСЕР" → lat/lon null (or untrusted coords), geo_source
 *      osm_low_confidence, geo_reresolve_queue row reason 'no_trusted_center'
 */
export function importPropertyGeo(feedRow: ImportFeedRow, deps: ImportGeoDeps): ImportGeoResult {
  const { db, offlineMap } = deps;
  const propertyId = feedRow.id;

  // No local map / no address → honest low-trust, queue for the cron.
  if (!offlineMap?.available || !feedRow.address) {
    enqueue(db, propertyId, 'no_trusted_center');
    return {
      lat: null, lon: null,
      geo_source: 'osm_low_confidence',
      geocoded_at: null,
      landmarkCached: false,
      queueReason: 'no_trusted_center',
    };
  }

  const resolved = offlineMap.resolvePropertyOffline(feedRow.address);

  if (!resolved.trusted) {
    // Untrusted (street centroid / endpoint clamp / name-fail). Coords may be
    // present (centroid — honest "населба" fallback material) or null (БИСЕР).
    // NEVER cached as a landmark. Cron Google-geocode upgrades it later.
    enqueue(db, propertyId, 'no_trusted_center');
    return {
      lat: resolved.lat, lon: resolved.lon,
      geo_source: 'osm_low_confidence',
      geocoded_at: null,
      landmarkCached: false,
      queueReason: 'no_trusted_center',
    };
  }

  // Trusted exact/interpolated center → nearby POIs computed OFFLINE right now,
  // centered on the RESOLVED BUILDING. LandmarkService.nearbyLandmarks caches
  // the top landmark (tier osm_poi) + the rotation list keyed by property_id;
  // client-facing claims stay capped at 500m.
  const svc = new LandmarkService(db, { offlineMap });
  const row: PropertyRow = {
    id: propertyId,
    eb: feedRow.eb ?? propertyId,
    address: feedRow.address,
    lat: resolved.lat,
    lon: resolved.lon,
    geo_source: resolved.source,
  };
  const nearby = svc.nearbyLandmarks(row);
  const landmarkCached = nearby.length > 0;

  return {
    lat: resolved.lat,
    lon: resolved.lon,
    geo_source: resolved.source,
    geocoded_at: new Date().toISOString(),
    landmarkCached,
    queueReason: landmarkCached ? null : 'no_landmark',
  };
}
