// PHASE 2, TASK 2.1 — geo_reresolve_queue drain core.
//
// The monthly cron's Phase C (refresh-monthly.ts) used to be a stub that just
// DELETED queue rows. This module does the real re-resolution. Network lives
// nowhere in this file: the property fetch (Supabase), the property patch
// (Supabase) and the geocode (SerpApi) are INJECTED, so the core is hermetic
// and testable without keys or sockets — and the budget guard is a plain
// function call, not a header parse.
//
// Per queue row:
//   1. Fetch the property (EB number == queue.property_id).
//   2. No trusted center (lat/lon missing OR geo_source = osm_low_confidence)
//      → ONE budget-guarded geocode. Inside the Skopje bbox → the property is
//      UPGRADED to geo_source='google_cached' (never geocoded again). Outside
//      the bbox or a geocode miss → the property STAYS osm_low_confidence.
//   3. Re-resolve the landmark OFFLINE against the refreshed merged POI table
//      (trusted center only). On a hit, cacheLandmark upgrades the cache entry
//      (osm_poi → google, upgrade-only rule holds inside put()).
//   4. Delete the queue row — even when the geocode failed validation. A
//      property is never left looping in the queue; the poison-sweep / next
//      import re-queues it if the facts change.
//
// Budget: the drain stops as soon as searchesLeft() drops below BUDGET_STOP —
// remaining rows stay queued for next month's run, and the caller (the cron
// script) exits cleanly.

import { Db } from '../store/db';
import { LandmarkService, cacheLandmark, type PropertyRow } from './landmarks';
import { OfflineMapStore } from './offlineMap';

/** Stop geocoding (and thus stop draining) below this many searches left. */
export const BUDGET_STOP = 20;

/** Skopje bbox — geocodes landing outside it are rejected (not real Skopje
 *  properties; a wrong/malicious/non-Skopje result must never upgrade a row
 *  to google_cached). */
export const SKOPJE_BBOX = { latMin: 41.95, latMax: 42.05, lonMin: 21.35, lonMax: 21.50 };

export function insideBbox(lat: number, lon: number): boolean {
  return lat >= SKOPJE_BBOX.latMin && lat <= SKOPJE_BBOX.latMax
      && lon >= SKOPJE_BBOX.lonMin && lon <= SKOPJE_BBOX.lonMax;
}

/** The property row as the drain sees it — the same shape backfill-geo reads
 *  from Supabase (EB number ↔ local queue.property_id). */
export interface QueuedProperty {
  propertyId: number;
  address?: string;
  location?: string;        // neighborhood — used only for logging
  lat?: number | null;
  lon?: number | null;
  geo_source?: string | null;
}

export interface DrainDeps {
  /** Local runtime DB — geo_reresolve_queue + the landmarks cache live here. */
  db: Db;
  /** Refreshed merged POI table (skopje-pois.db) — the offline landmark layer. */
  offlineMap: OfflineMapStore;
  /** Fetch the property by EB number (Supabase REST in the real cron). */
  getProperty(propertyId: number): Promise<QueuedProperty | undefined>;
  /** Persist an upgraded center on the property row (Supabase REST in the
   *  real cron). Only called for bbox-validated google_cached upgrades. */
  updatePropertyGeo(propertyId: number, geo: {
    lat: number; lon: number; geo_source: string; geocoded_at: string;
  }): Promise<void>;
  /** ONE budget-guarded geocode (SerpApi in the real cron). Must return null
   *  when the call itself failed — a null is never treated as a coordinate. */
  geocode(address: string): Promise<{ lat: number; lon: number } | null>;
  /** Live X-SerpApi-Searches-Left — the drain stops below BUDGET_STOP. */
  searchesLeft(): number;
}

export interface DrainResult {
  /** Queue rows fully resolved and deleted. */
  processed: number;
  /** Properties upgraded to geo_source='google_cached' (bbox-validated). */
  googleUpgraded: number;
  /** Properties whose landmark was (re)cached from the refreshed POI table. */
  landmarkCached: number;
  /** Rows left queued because the budget dropped below BUDGET_STOP. */
  budgetStopped: number;
  /** Rows still in the queue after the drain. */
  leftInQueue: number;
}

export async function drainQueue(deps: DrainDeps): Promise<DrainResult> {
  const { db, offlineMap, getProperty, updatePropertyGeo, geocode, searchesLeft } = deps;
  const res: DrainResult = { processed: 0, googleUpgraded: 0, landmarkCached: 0, budgetStopped: 0, leftInQueue: 0 };

  const rows = db.db.prepare(
    `SELECT property_id, reason FROM geo_reresolve_queue ORDER BY property_id`
  ).all() as Array<{ property_id: number; reason: string }>;

  if (rows.length === 0) return res;

  const deleteRow = db.db.prepare(`DELETE FROM geo_reresolve_queue WHERE property_id = ?`);
  // One LandmarkService for the whole drain — its store + offline map refs
  // back the same local DB for every row.
  const svc = new LandmarkService(db, { offlineMap });

  for (const row of rows) {
    if (searchesLeft() < BUDGET_STOP) {
      // Budget exhausted mid-drain — leave this and every later row queued.
      // The caller logs and exits cleanly; next month's run picks them up.
      res.budgetStopped++;
      continue;
    }

    const prop = await getProperty(row.property_id);
    if (!prop) {
      // Orphan queue row (property deleted upstream) — drop it, don't loop.
      deleteRow.run(row.property_id);
      res.processed++;
      continue;
    }

    let lat: number | null = prop.lat ?? null;
    let lon: number | null = prop.lon ?? null;
    let geoSource: string | null = prop.geo_source ?? null;

    // Step 2 — no trusted center: ONE budget-guarded geocode.
    const needsGeo = lat == null || lon == null || geoSource === 'osm_low_confidence';
    const hasAddress = !!prop.address && prop.address.trim().length >= 3;
    if (needsGeo && hasAddress) {
      const geo = await geocode(prop.address!);
      if (geo && insideBbox(geo.lat, geo.lon)) {
        lat = geo.lat;
        lon = geo.lon;
        geoSource = 'google_cached';
        await updatePropertyGeo(row.property_id, {
          lat, lon,
          geo_source: 'google_cached',
          geocoded_at: new Date().toISOString(),
        });
        res.googleUpgraded++;
      }
      // Outside the bbox or a geocode miss → the row STAYS osm_low_confidence.
      // Never write an unvalidated coordinate, never claim google_cached.
    }

    // Step 3 — re-resolve the landmark OFFLINE against the refreshed merged
    // POI table, centered on whatever center we now have. Trusted center →
    // cacheLandmark upgrades the entry (osm_poi → google, upgrade-only).
    // Untrusted center → nearbyLandmarks returns [] and (best-effort) re-queues
    // with INSERT OR IGNORE — harmless while the row still exists; we delete it
    // right after, so the property is never stuck looping month after month.
    const propRow: PropertyRow = {
      id: row.property_id,
      eb: row.property_id,
      address: prop.address,
      lat,
      lon,
      geo_source: geoSource,
    };
    const nearby = svc.nearbyLandmarks(propRow);
    if (nearby.length > 0) {
      cacheLandmark(
        propRow,
        { landmark: nearby[0].landmark, type: 'poi', source: 'offline' },
        'google',
      );
      res.landmarkCached++;
    }

    deleteRow.run(row.property_id);
    res.processed++;
  }

  res.leftInQueue = (db.db.prepare(`SELECT COUNT(*) as c FROM geo_reresolve_queue`).get() as { c: number }).c;
  return res;
}
