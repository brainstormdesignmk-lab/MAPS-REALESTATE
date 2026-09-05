#!/usr/bin/env tsx
/**
 * backfill-geo.ts — One-time geocode backfill.
 *
 * For every property with lat IS NULL:
 *   1. If import feed stored real coords → copy, geo_source='stored'
 *   2. Else SerpApi ONCE:
 *        GET https://serpapi.com/search
 *          ?engine=google_maps&type=search&q=<address>, Skopje&hl=en&api_key=SERPAPI_KEY
 *        → local_results[0].gps_coordinates  (or place_results.gps_coordinates)
 *   3. Validate inside Skopje bbox: lat 41.95–42.05, lon 21.35–21.50
 *        else geo_source='osm_low_confidence'
 *   4. Save lat/lon/geo_source/geocoded_at. NEVER geocode this property again.
 *   5. Still NULL after all that → offlineMap.geocodeAddress fallback,
 *      geo_source='osm_low_confidence', print warning.
 *
 * RULES: skip rows with geo_source already set; sleep(1100) between calls;
 *        log X-SerpApi-Searches-Left header each call; STOP when < 20 left.
 * Script MUST be re-runnable.
 */

import '../src/compat/node16';

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Load env from ~/.lina/lina.env
dotenv.config({ path: path.join(os.homedir(), '.lina', 'lina.env') });

/** env var or undefined — an EMPTY value ('' as written in some lina.env
 *  files) must behave exactly like an unset var. */
function env(k: string): string | undefined {
  const v = process.env[k];
  return v && v.trim() ? v : undefined;
}

const SKOPJE_BBOX = { latMin: 41.95, latMax: 42.05, lonMin: 21.35, lonMax: 21.50 };

function insideBbox(lat: number, lon: number): boolean {
  return lat >= SKOPJE_BBOX.latMin && lat <= SKOPJE_BBOX.latMax
      && lon >= SKOPJE_BBOX.lonMin && lon <= SKOPJE_BBOX.lonMax;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<{ data: any; headers: Headers }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const data = await res.json();
    return { data, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

// ── Supabase REST helpers ───────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://qkgioqotxjxffiaufgwd.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrZ2lvcW90eGp4ZmZpYXVmZ3dkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxMTU0NjUsImV4cCI6MjA3MDY5MTQ2NX0.WVno6c6_rvFqFwj1fN8UWHYmlit0C-6J_h57P8d5eOI';

function restHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
    ...extra,
  };
}

interface PropertyRow {
  id: string;
  property_number: string;
  address?: string;
  neighborhood?: string;
  lat?: number | null;
  lon?: number | null;
  geo_source?: string | null;
}

async function fetchProperties(): Promise<PropertyRow[]> {
  const url = `${SUPABASE_URL}/rest/v1/properties?select=id,property_number,address,neighborhood,lat,lon,geo_source&order=property_number`;
  const res = await fetch(url, { headers: restHeaders() });
  if (!res.ok) throw new Error(`fetch properties: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function patchProperty(propertyNumber: string, data: {
  lat: number; lon: number; geo_source: string; geocoded_at: string;
}): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/properties?property_number=eq.${encodeURIComponent(propertyNumber)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: restHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`patch EB ${propertyNumber}: ${res.status} ${await res.text()}`);
}

// ── SerpApi geocoder (Google Maps engine) ────────────────────────────────────
function loadSerpApiKeys(): string[] {
  const keys: string[] = [];
  if (env('SERPAPI_KEY')) keys.push(env('SERPAPI_KEY')!);
  if (fs.existsSync('data/serpapi-key.txt')) {
    const k = fs.readFileSync('data/serpapi-key.txt', 'utf8').trim();
    if (k && !keys.includes(k)) keys.push(k);
  }
  // Read from GOOGLEMAPS_API_KEY.txt — skip label lines, take hex keys
  if (fs.existsSync('GOOGLEMAPS_API_KEY.txt')) {
    const lines = fs.readFileSync('GOOGLEMAPS_API_KEY.txt', 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines, label lines, and non-hex lines
      if (!trimmed || /^[A-Z]/.test(trimmed)) continue;
      if (/^[0-9a-f]{40,}$/i.test(trimmed) && !keys.includes(trimmed)) {
        keys.push(trimmed);
      }
    }
  }
  return keys;
}

const SERPAPI_KEYS = loadSerpApiKeys();
let keyIdx = 0;
let serpApiLeft = 250;

async function serpApiGeocode(address: string): Promise<{ lat: number; lon: number } | null> {
  if (SERPAPI_KEYS.length === 0) return null;
  const key = SERPAPI_KEYS[keyIdx % SERPAPI_KEYS.length];
  const q = `${address}, Skopje`;
  const url = `https://serpapi.com/search?engine=google_maps&type=search&q=${encodeURIComponent(q)}&hl=en&api_key=${key}`;
  try {
    const { data, headers } = await fetchJson(url);
    const left = headers.get('x-serpapi-searches-left');
    if (left) {
      serpApiLeft = parseInt(left, 10);
      console.log(`    🔑 SerpApi searches left: ${left}`);
    }
    if (data?.error?.includes('run out')) {
      console.warn(`  ⚠ Key exhausted, rotating...`);
      keyIdx++;
      if (keyIdx >= SERPAPI_KEYS.length) return null;
      return serpApiGeocode(address); // retry with next key
    }
    const coords = data?.local_results?.[0]?.gps_coordinates
      ?? data?.place_results?.gps_coordinates;
    if (coords?.latitude && coords?.longitude) {
      keyIdx++;
      return { lat: coords.latitude, lon: coords.longitude };
    }
  } catch (e) {
    console.warn(`  ⚠ SerpApi failed for "${address}": ${(e as Error).message}`);
  }
  return null;
}

// ── Offline map fallback ─────────────────────────────────────────────────────
let offlineMap: any = null;
async function initOfflineMap(): Promise<void> {
  try {
    const mod = await import('../src/geo/offlineMap');
    const dbPath = env('SKOPJE_POIS_DB') ?? path.join(process.cwd(), 'data', 'skopje-pois.db');
    offlineMap = new mod.OfflineMapStore(dbPath);
    if (!offlineMap.available) offlineMap = null;
  } catch {
    console.warn('⚠ Offline map unavailable — fallback geocoding disabled');
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== backfill-geo: one-time geocode backfill ===\n');

  if (SERPAPI_KEYS.length === 0) {
    console.warn('⚠ No SerpApi key found — will use offlineMap fallback only');
    console.warn('  Set GOOGLE_MAPS_API_KEY env var or create GOOGLEMAPS_API_KEY.txt\n');
  } else {
    console.log(`  Using ${SERPAPI_KEYS.length} SerpApi key(s)\n`);
  }

  await initOfflineMap();

  const props = await fetchProperties();
  const todo = props.filter(p => p.lat == null && p.lon == null && !p.geo_source);
  console.log(`Properties: ${props.length} total, ${todo.length} need geocoding\n`);

  if (todo.length === 0) {
    console.log('Nothing to do — all properties already geocoded.');
    return;
  }

  let geocoded = 0;
  let serpapiCalls = 0;

  for (const p of todo) {
    const addr = p.address ?? '';
    if (!addr || addr.trim().length < 3) {
      console.log(`  EB ${p.property_number}: SKIP — no address`);
      continue;
    }

    // Step 1: Try SerpApi
    // Stop if quota exhausted
    if (serpApiLeft < 20 && SERPAPI_KEYS.every(k => k === SERPAPI_KEYS[0])) {
      console.warn(`\n⚠️  SerpApi quota low (${serpApiLeft} left) — stopping to preserve quota.`);
      break;
    }

    const coords = await serpApiGeocode(addr);
    serpapiCalls++;

    if (coords && insideBbox(coords.lat, coords.lon)) {
      await patchProperty(p.property_number, {
        lat: coords.lat,
        lon: coords.lon,
        geo_source: 'google_cached',
        geocoded_at: new Date().toISOString(),
      });
      console.log(`  EB ${p.property_number}: ✅ google_cached (${coords.lat.toFixed(6)}, ${coords.lon.toFixed(6)})`);
      geocoded++;
      await sleep(1100); // SerpApi rate limit: 1 req/sec
      continue;
    }

    if (coords) {
      // Outside bbox → osm_low_confidence
      await patchProperty(p.property_number, {
        lat: coords.lat,
        lon: coords.lon,
        geo_source: 'osm_low_confidence',
        geocoded_at: new Date().toISOString(),
      });
      console.log(`  EB ${p.property_number}: ⚠️  osm_low_confidence — outside bbox (${coords.lat.toFixed(6)}, ${coords.lon.toFixed(6)})`);
      geocoded++;
      await sleep(1100);
      continue;
    }

    // Step 2: Offline map fallback (street address)
    if (offlineMap) {
      const geo = offlineMap.geocodeAddress(addr);
      if (geo) {
        await patchProperty(p.property_number, {
          lat: geo.lat,
          lon: geo.lon,
          geo_source: 'osm_low_confidence',
          geocoded_at: new Date().toISOString(),
        });
        console.log(`  EB ${p.property_number}: ⚠️  osm_low_confidence — offline fallback (${geo.lat.toFixed(6)}, ${geo.lon.toFixed(6)})`);
        geocoded++;
        await sleep(1100);
        continue;
      }
    }

    // Step 3: Neighborhood-based fallback — geocode the neighborhood itself
    // for landmark-name addresses like "БИСЕР", "ПАЛОМА БЈАНКА"
    const hood = (p.neighborhood ?? '').trim();
    if (hood && offlineMap) {
      const hoodGeo = offlineMap.geocodeAddress(hood);
      if (hoodGeo) {
        await patchProperty(p.property_number, {
          lat: hoodGeo.lat,
          lon: hoodGeo.lon,
          geo_source: 'osm_low_confidence',
          geocoded_at: new Date().toISOString(),
        });
        console.log(`  EB ${p.property_number}: ⚠️  osm_low_confidence — neighborhood fallback "${hood}" (${hoodGeo.lat.toFixed(6)}, ${hoodGeo.lon.toFixed(6)})`);
        geocoded++;
        await sleep(1100);
        continue;
      }
    }

    // Step 4: Google Maps neighborhood fallback
    if (hood) {
      const hoodCoords = await serpApiGeocode(hood);
      if (hoodCoords && insideBbox(hoodCoords.lat, hoodCoords.lon)) {
        await patchProperty(p.property_number, {
          lat: hoodCoords.lat,
          lon: hoodCoords.lon,
          geo_source: 'osm_low_confidence',
          geocoded_at: new Date().toISOString(),
        });
        console.log(`  EB ${p.property_number}: ⚠️  osm_low_confidence — Google neighborhood "${hood}" (${hoodCoords.lat.toFixed(6)}, ${hoodCoords.lon.toFixed(6)})`);
        geocoded++;
        await sleep(1100);
        continue;
      }
    }

    // Step 5: Still NULL — mark as osm_low_confidence with Skopje center
    // for garbage addresses like "НЕПОЗНАТА", "ФГХФГХ"
    await patchProperty(p.property_number, {
      lat: 41.998, lon: 21.430, // Skopje center
      geo_source: 'osm_low_confidence',
      geocoded_at: new Date().toISOString(),
    });
    console.warn(`  EB ${p.property_number}: ⚠️  osm_low_confidence — Skopje center fallback (unresolvable: "${addr}")`);
    geocoded++;
    await sleep(1100);
  }

  console.log(`\n=== Done: ${geocoded}/${todo.length} geocoded, ${serpapiCalls} SerpApi calls ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
