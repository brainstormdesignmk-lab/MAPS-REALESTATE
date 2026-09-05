// PHASE 2, TASK 2.2 — poison sweep core.
//
// The monthly cron's Phase D used to be a no-op stub ("will be re-checked on
// next request"). This module actually re-checks every CACHED landmark with a
// low-confidence tier (osm_poi / osm_low_confidence) against the property's
// TRUSTED center and the refreshed merged POI table, and downgrades the
// stale ones so canServeLandmark() can never serve them.
//
// The poison problem it closes (the "Златна вилушка" class of bug): a bad
// OSM/Nominatim resolution wrote a landmark ~1km off onto a property's cache
// entry. The cache served it forever because there was no staleness check.
// After this sweep:
//   - a cached osm_poi landmark whose POI is > POISON_MAX_DIST_M from the
//     property's trusted center → tier flipped to osm_low_confidence
//     (landmark_name UNTOUCHED — canServeLandmark now blocks serving it);
//   - a cached landmark whose center is untrusted (osm_low_confidence /
//     missing coords) → same downgrade; the claim "verified against a real
//     center" is stale;
//   - the downgraded property is enqueued with reason 'poison_sweep' so the
//     NEXT monthly drain re-resolves it for real (SerpApi geocode + offline
//     landmark re-cache, budget-guarded).
//
// Only the two low tiers are swept. feed/google/extract are trusted tiers —
// never touched. POIs that can't be found in the refreshed table are KEPT
// (a measurement failure is not grounds for rejection — same benefit of the
// doubt the feed layer applies). The sweep itself makes ZERO network calls:
// the property fetch is injected, exactly like the queue drain.

import { Db } from '../store/db';
import { OfflineMapStore } from './offlineMap';
import { centerTrusted } from './landmarks';
import { distM } from './precision';

/** A cached landmark farther than this from the trusted center is poison —
 *  the same 500m cap the client-facing "близина" claims are held to. */
export const POISON_MAX_DIST_M = 500;

/** Property row as the sweep sees it (Supabase REST in the real cron). */
export interface SweepProperty {
  propertyId: number;
  lat?: number | null;
  lon?: number | null;
  geo_source?: string | null;
}

export interface SweepDeps {
  /** Local runtime DB — landmarks cache + geo_reresolve_queue live here. */
  db: Db;
  /** Refreshed merged POI table (skopje-pois.db) — the source of truth the
   *  cached landmark is measured against. */
  offlineMap: OfflineMapStore;
  /** Fetch the property by EB number (Supabase REST in the real cron). */
  getProperty(propertyId: number): Promise<SweepProperty | undefined>;
}

export interface SweepResult {
  /** Landmark cache rows examined (tier IN osm_poi/osm_low_confidence). */
  checked: number;
  /** Rows downgraded to osm_low_confidence (stale landmark / stale center). */
  downgraded: number;
  /** Rows whose landmark survived the re-check (measured ≤ 500m, or POI not
   *  findable → benefit of the doubt). */
  verified: number;
  /** Cache rows deleted — the property no longer exists upstream. */
  orphaned: number;
  /** Properties enqueued for next drain (reason 'poison_sweep'). */
  queued: number;
  /** geo_reresolve_queue size after the sweep. */
  leftQueued: number;
}

export async function sweepPoison(deps: SweepDeps): Promise<SweepResult> {
  const { db, offlineMap, getProperty } = deps;
  const res: SweepResult = { checked: 0, downgraded: 0, verified: 0, orphaned: 0, queued: 0, leftQueued: 0 };

  const rows = db.db.prepare(
    `SELECT property_id, landmark, tier FROM landmarks WHERE tier IN ('osm_poi', 'osm_low_confidence') ORDER BY property_id`
  ).all() as Array<{ property_id: number; landmark: string; tier: string }>;
  if (rows.length === 0) return res;

  const downgrade = db.db.prepare(
    `UPDATE landmarks SET tier = 'osm_low_confidence' WHERE property_id = ? AND tier = 'osm_poi'`
  );
  const deleteRow = db.db.prepare(`DELETE FROM landmarks WHERE property_id = ?`);
  const enqueue = db.db.prepare(
    `INSERT OR IGNORE INTO geo_reresolve_queue (property_id, reason, created_at) VALUES (?, 'poison_sweep', ?)`
  );

  for (const row of rows) {
    res.checked++;
    const prop = await getProperty(row.property_id);
    if (!prop) {
      // Property gone upstream — its cache row is garbage; drop it, don't loop.
      deleteRow.run(row.property_id);
      res.orphaned++;
      continue;
    }

    // Failure = stale CENTER (claim "verified against a real center" is stale)
    // or stale LANDMARK (measured farther than the 500m client-claim cap).
    let failed = false;
    const trusted = centerTrusted(prop.geo_source) && !!prop.lat && !!prop.lon;
    if (!trusted) {
      failed = true;
    } else {
      const poi = offlineMap.findPoiByName(row.landmark);
      if (poi) {
        const d = distM(prop.lat!, prop.lon!, poi.lat, poi.lon);
        if (d > POISON_MAX_DIST_M) failed = true;
      }
      // POI not findable in the refreshed table → cannot measure → keep
      // (benefit of the doubt — absence of a match is not proof of poison).
    }

    if (failed) {
      // Only the TIER column changes. landmark_name stays untouched — the
      // privacy invariant "never leak the street" holds; canServeLandmark
      // blocks the row from ever being served again.
      if (row.tier === 'osm_poi') {
        downgrade.run(row.property_id);
        res.downgraded++;   // actual tier flip osm_poi → osm_low_confidence
      }
      // Already-low rows are enqueued too (not flipped — they're already
      // blocked) so the next drain geocodes + re-resolves them for real.
      enqueue.run(row.property_id, new Date().toISOString());
      res.queued++;
    } else {
      res.verified++;
    }
  }

  res.leftQueued = (db.db.prepare(`SELECT COUNT(*) as c FROM geo_reresolve_queue`).get() as { c: number }).c;
  return res;
}