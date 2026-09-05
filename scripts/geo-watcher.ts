#!/usr/bin/env tsx
/**
 * geo-watcher.ts — instant offline geo resolution for NEW properties.
 *
 * WHY: ANA (outbound_final) and manual entries (realestate_app_lovable's
 * PropertyDetailView → direct Supabase insert) both save properties with an
 * address but NO lat/lon/geo_source. Without stored coords, Lina's trust gate
 * blocks landmark answers until the MONTHLY refresh drains the queue — up to a
 * month of "во населба X" for a brand-new listing.
 *
 * This watcher closes that window: it polls Supabase for rows that have never
 * been geo-resolved (geo_source IS NULL), runs the SAME offline resolver ANA
 * would run (importPropertyGeo → resolvePropertyOffline against the local
 * skopje-pois.db, exact building → interpolation → centroid), and PATCHes the
 * result back. A property saved at 09:00 is answered with a correct landmark
 * at ~09:01 — zero SerpApi/Google/network per property.
 *
 * Trust split (same contract as importPropertyGeo):
 *   trusted  (osm_building / osm_interpolated) → lat/lon + geo_source stored,
 *            top landmark cached locally (lina.db). Client sees full answer.
 *   untrusted (osm_low_confidence — street centroid, or name-fail like "БИСЕР")
 *            → geo_source='osm_low_confidence' stored so the poll never
 *            re-fetches it; row is enqueued in the LOCAL queue (lina.db) for
 *            the monthly refresh's Phase C SerpApi upgrade to google_cached.
 *            NEVER a fabricated precise point, never a served landmark.
 *
 * Usage:
 *   npx tsx scripts/geo-watcher.ts            # loop forever, poll every 60s
 *   npx tsx scripts/geo-watcher.ts --once     # one poll pass, then exit (cron-friendly)
 *   npx tsx scripts/geo-watcher.ts --interval 30
 *
 * Credentials: SUPABASE_URL / SUPABASE_ANON_KEY from ~/.lina/lina.env (falls
 * back to the live qkgio project defaults, same as refresh-monthly.ts).
 * DB paths: DB_PATH / SKOPJE_POIS_DB from env (defaults: data/lina.db,
 * data/skopje-pois.db). Runs on THIS machine (the box that owns the offline
 * map) — never on T60.
 */

import '../src/compat/node16';

import * as dotenv from 'dotenv';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.join(os.homedir(), '.lina', 'lina.env') });

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://qkgioqotxjxffiaufgwd.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrZ2lvcW90eGp4ZmZpYXVmZ3dkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxMTU0NjUsImV4cCI6MjA3MDY5MTQ2NX0.WVno6c6_rvFqFwj1fN8UWHYmlit0C-6J_h57P8d5eOI';

const LINA_DB = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'lina.db');
const POIS_DB = process.env.SKOPJE_POIS_DB ?? path.join(process.cwd(), 'data', 'skopje-pois.db');

const once = process.argv.includes('--once');
const intervalArg = process.argv.find(a => a.startsWith('--interval='));
const POLL_INTERVAL_MS = (intervalArg ? Number(intervalArg.split('=')[1]) : 60) * 1000;
const MAX_PER_POLL = Number(process.argv.find(a => a.startsWith('--max='))?.split('=')[1] ?? 25);

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function restHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };
}

interface UnresolvedRow {
  property_number: string;
  address?: string | null;
  neighborhood?: string | null;
  lat?: number | null;
  lon?: number | null;
  geo_source?: string | null;
}

async function fetchUnresolved(limit: number): Promise<UnresolvedRow[]> {
  const url = `${SUPABASE_URL}/rest/v1/properties?select=property_number,address,neighborhood,lat,lon,geo_source&geo_source=is.null&limit=${limit}`;
  const res = await fetch(url, { headers: restHeaders() });
  if (!res.ok) throw new Error(`fetch unresolved: ${res.status} ${await res.text()}`);
  return res.json();
}

async function patchGeo(propertyNumber: string, data: Record<string, unknown>): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/properties?property_number=eq.${encodeURIComponent(propertyNumber)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...restHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`patch EB ${propertyNumber}: ${res.status} ${await res.text()}`);
}

async function pollOnce(): Promise<number> {
  const { Db } = await import('../src/store/db');
  const { OfflineMapStore } = await import('../src/geo/offlineMap');
  const { importPropertyGeo } = await import('../src/geo/importGeo');

  const db = new Db(LINA_DB);
  let offlineMap: OfflineMapStore | null = null;
  try {
    offlineMap = new OfflineMapStore(POIS_DB);
    if (!offlineMap.available) offlineMap = null;
  } catch (e) {
    log(`⚠ offline map unavailable (${POIS_DB}): ${(e as Error).message}`);
  }
  if (!offlineMap) {
    log('⚠ no offline map — nothing to do. Exiting pass.');
    db.close();
    return 0;
  }

  const rows = await fetchUnresolved(MAX_PER_POLL);
  if (rows.length === 0) {
    log(`poll: 0 unresolved properties (all geo-resolved)`);
    db.close();
    return 0;
  }
  log(`poll: ${rows.length} unresolved properties`);

  let patched = 0;
  for (const row of rows) {
    const eb = Number(row.property_number);
    if (!Number.isFinite(eb) || eb <= 0) {
      log(`  skip EB "${row.property_number}" — not a numeric property_number`);
      continue;
    }
    const address = row.address ?? undefined;
    const result = importPropertyGeo(
      { id: eb, eb, address, location: row.neighborhood ?? undefined },
      { db, offlineMap },
    );
    const geo = result.lat != null && result.lon != null
      ? { lat: result.lat, lon: result.lon, geo_source: result.geo_source, geocoded_at: result.geocoded_at }
      : { geo_source: result.geo_source }; // untrusted, coords unknown → mark done, monthly Phase C upgrades
    try {
      await patchGeo(String(eb), geo);
      patched++;
      log(`  EB ${eb} "${address ?? ''}" → ${result.geo_source} lat=${result.lat ?? '—'} lon=${result.lon ?? '—'} landmarkCached=${result.landmarkCached} queue=${result.queueReason ?? '—'}`);
    } catch (e) {
      log(`  ⚠ EB ${eb} PATCH failed: ${(e as Error).message}`);
    }
  }
  db.close();
  return patched;
}

async function main(): Promise<void> {
  log(`geo-watcher start (map=${POIS_DB}, db=${LINA_DB}, ${once ? 'single pass' : `loop ${POLL_INTERVAL_MS / 1000}s`})`);
  let pass = 0;
  for (;;) {
    try {
      const done = await pollOnce();
      pass++;
      log(`pass ${pass}: patched ${done}`);
    } catch (e) {
      log(`⚠ poll failed: ${(e as Error).message}`);
    }
    if (once) break;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  log('geo-watcher done');
  process.exit(0);
}

main().catch(e => { console.error('[geo-watcher] fatal:', e); process.exit(1); });
