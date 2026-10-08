#!/usr/bin/env tsx
/**
 * street-teach.ts — THE TEACHER (October runbook Steps 3–4).
 *
 * One SerpApi geocode per gap → insideSkopjeBbox validation → the map
 * learns → the street resolves trusted offline FOREVER:
 *   --unknowns  class (c): one geocode per street, learned via
 *               learnStreet (a Google-verified street ANCHOR — the whole
 *               street serves trusted, any house number);
 *   --thin      class (b): one geocode per FEED-CARRIED number on thin
 *               streets, learned via learnAddress (number-level rows);
 *   --cap=N     search budget (class (c) first — never trimmed);
 *   --dry       print the plan, spend nothing.
 *
 * Budget/pacing rules (the runbook, made code):
 *   - 1100 ms between calls (SerpApi 1 req/s);
 *   - stop when the session spend crosses --cap or the engine's shared
 *     X-SerpApi-Searches-Left hits the BUDGET_STOP floor (20);
 *   - a 429 (or "run out") storm ABORTS the run: keep the residue, resume
 *     tomorrow — never a tight retry loop (the Sep 3 NIM lesson);
 *   - rejected (outside bbox / miss) streets stay in the census residue
 *     and are re-attempted by the standing monthly loop, never in-run.
 *
 * Re-runnable: already-taught streets classify as known and are skipped.
 */

import '../src/compat/node16';

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { insideSkopjeBbox } from '../src/geo/serpCapture';
import {
  collectCandidates, classifyAll, buildTeachPlan, type TeachTask,
} from '../src/geo/streetCensus';

dotenv.config({ path: path.join(os.homedir(), '.lina', 'lina.env') });

const POIS_DB = process.env.SKOPJE_POIS_DB ?? path.join(process.cwd(), 'data', 'skopje-pois.db');
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://qkgioqotxjxffiaufgwd.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrZ2lvcW90eGp4ZmZpYXVmZ3dkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxMTU0NjUsImV4cCI6MjA3MDY5MTQ2NX0.WVno6c6_rvFqFwj1fN8UWHYmlit0C-6J_h57P8d5eOI';

const BUDGET_STOP = 20;          // same floor the queue drain honors
const PACING_MS = 1100;          // SerpApi 1 req/s
const MAX_CONSECUTIVE_429 = 3;   // storm detector

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const hasFlag = (name: string): boolean => process.argv.includes(name);

// ── SerpApi keys (same loader contract as refresh-monthly / backfill-geo) ────
function loadSerpApiKeys(): string[] {
  const keys: string[] = [];
  if (process.env.SERPAPI_KEY) keys.push(process.env.SERPAPI_KEY);
  if (fs.existsSync('data/serpapi-key.txt')) {
    const k = fs.readFileSync('data/serpapi-key.txt', 'utf8').trim();
    if (k && !keys.includes(k)) keys.push(k);
  }
  if (fs.existsSync('GOOGLEMAPS_API_KEY.txt')) {
    for (const line of fs.readFileSync('GOOGLEMAPS_API_KEY.txt', 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || /^[A-Z]/.test(t)) continue;
      if (/^[0-9a-f]{40,}$/i.test(t) && !keys.includes(t)) keys.push(t);
    }
  }
  return keys;
}
const SERPAPI_KEYS = loadSerpApiKeys();
let keyIdx = 0;
let serpApiLeft = 250;
let sessionSpend = 0;

type GeocodeResult = { lat: number; lon: number } | null | 'RATE_LIMITED';

async function serpApiGeocode(query: string): Promise<GeocodeResult> {
  if (SERPAPI_KEYS.length === 0) return null;
  const key = SERPAPI_KEYS[keyIdx % SERPAPI_KEYS.length];
  const url = `https://serpapi.com/search?engine=google_maps&type=search&q=${encodeURIComponent(query)}&hl=en&api_key=${key}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const left = res.headers.get('x-serpapi-searches-left');
    if (left) serpApiLeft = parseInt(left, 10);
    const data = await res.json();
    // SerpApi returns HTTP 429 for BOTH a genuine rate storm AND an exhausted
    // key ("Your account has run out of searches."). Parse the body first:
    // a spent key rotates to the next one; only a real 429 aborts the run.
    // (Before this, the three exhausted keys at the head of the file made
    // every teach run stop instantly as a false "429 storm".)
    if (typeof data?.error === 'string' && data.error.includes('run out')) {
      keyIdx++;
      if (keyIdx >= SERPAPI_KEYS.length) return null;
      return serpApiGeocode(query);
    }
    if (res.status === 429) return 'RATE_LIMITED';
    const coords = data?.local_results?.[0]?.gps_coordinates
      ?? data?.place_results?.gps_coordinates;
    sessionSpend++;
    if (coords?.latitude && coords?.longitude) return { lat: coords.latitude, lon: coords.longitude };
    return null;
  } catch (e) {
    console.warn(`  ⚠ geocode "${query}": ${(e as Error).message}`);
    return null;
  }
}

// ── Census (free) ────────────────────────────────────────────────────────────
async function fetchFeedAddresses(): Promise<string[]> {
  const out: string[] = [];
  for (let from = 0; ; from += 1000) {
    const url = `${SUPABASE_URL}/rest/v1/properties?select=address&limit=1000&offset=${from}`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status}`);
    const page = await res.json() as Array<{ address?: string | null }>;
    for (const r of page) if (r.address) out.push(r.address);
    if (page.length < 1000) break;
  }
  return out;
}

function makeProbes(db: Database.Database): { knows: (s: string) => boolean; numberedRows: (s: string) => number } {
  const rows = db.prepare(
    `SELECT key,
            SUM(CASE WHEN housenumber != '' AND housenumber != 'ББ' THEN 1 ELSE 0 END) AS numbered
       FROM addresses GROUP BY key`
  ).all() as Array<{ key: string; numbered: number | null }>;
  const numberedByKey = new Map<string, number>();
  for (const r of rows) numberedByKey.set(r.key, r.numbered ?? 0);
  const allKeys = new Set(rows.map(r => r.key));
  return {
    knows: (street: string) => allKeys.has(streetKey(street)),
    numberedRows: (street: string) => numberedByKey.get(streetKey(street)) ?? 0,
  };
}

import { streetKey } from '../src/geo/offlineMap';

// ── Teaching ─────────────────────────────────────────────────────────────────
async function teach(task: TeachTask, map: OfflineMapStore): Promise<'taught' | 'miss' | 'outside' | 'limited'> {
  if (task.cls === 'unknown') {
    const q = `${task.street}, Скопје, Северна Македонија`;
    const geo = await serpApiGeocode(q);
    if (geo === 'RATE_LIMITED') return 'limited';
    if (!geo) return 'miss';
    if (!insideSkopjeBbox(geo.lat, geo.lon)) return 'outside';
    // THE WHOLE STREET, ONE CALL: Google confirmed the street at that pin.
    if (!map.learnStreet(task.street, geo.lat, geo.lon)) return 'miss';
    return 'taught';
  }
  // Class (b): one geocode per number, number-level learning.
  let any = false;
  for (const num of task.numbers) {
    const q = `${task.street} ${num}, Скопје, Северна Македонија`;
    const geo = await serpApiGeocode(q);
    if (geo === 'RATE_LIMITED') return 'limited';
    if (geo && insideSkopjeBbox(geo.lat, geo.lon) && map.learnAddress(`${task.street} ${num}`, geo.lat, geo.lon)) {
      any = true;
    }
    await sleep(PACING_MS);
  }
  return any ? 'taught' : 'miss';
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const MODE: 'unknown' | 'thin' | 'all'
    = hasFlag('--unknowns') ? 'unknown'
    : hasFlag('--thin') ? 'thin' : 'all';
  const DRY = hasFlag('--dry');
  const capArg = arg('--cap');
  const CAP = capArg ? parseInt(capArg, 10) : undefined;
  const minFeedCount = parseInt(arg('--min-feed-count') ?? '1', 10) || 1;

  console.log(`=== street-teach (${MODE}${DRY ? ', DRY' : ''}${CAP ? `, cap ${CAP}` : ''}) ===`);
  if (!fs.existsSync(POIS_DB)) { console.error(`Map DB not found: ${POIS_DB}`); process.exit(1); }
  if (!DRY && SERPAPI_KEYS.length === 0) {
    console.error('No SerpApi keys — nothing to teach with. (Use --dry to inspect the plan.)');
    process.exit(1);
  }

  const censusDb = new Database(POIS_DB, { readonly: true });
  const { mapStreets } = (() => {
    const mapStreets = (censusDb.prepare('SELECT street FROM addresses GROUP BY key').all() as Array<{ street: string }>).map(r => r.street);
    return { mapStreets };
  })();
  const probe = makeProbes(censusDb);
  censusDb.close();

  console.log('Fetching feed addresses...');
  const feedAddresses = await fetchFeedAddresses();
  console.log(`feed addresses: ${feedAddresses.length}`);

  const candidates = collectCandidates({
    mapStreets, feedAddresses, osmStreets: mapStreets, probes: probe,
  });
  const classified = classifyAll(candidates, probe.knows);
  const plan = buildTeachPlan(classified, { mode: MODE, cap: CAP, minFeedCount });
  const projected = plan.reduce((n, t) => n + (t.cls === 'unknown' ? 1 : t.numbers.length), 0);

  console.log(`plan: ${plan.filter(t => t.cls === 'unknown').length} unknown streets`
    + ` + ${plan.reduce((n, t) => n + (t.cls === 'thin' ? t.numbers.length : 0), 0)} thin numbers`
    + ` = ${projected} searches`);

  if (DRY) {
    for (const t of plan.slice(0, 60)) {
      console.log(`  [${t.cls === 'unknown' ? 'C' : 'B'}] ${t.street}${t.cls === 'thin' ? ` → ${t.numbers.join(', ')}` : ''}`);
    }
    if (plan.length > 60) console.log(`  … +${plan.length - 60} more`);
    console.log('DRY run — nothing spent.');
    return;
  }

  const map = new OfflineMapStore(POIS_DB);
  if (!map.available) { console.error('Map unavailable'); process.exit(1); }

  let taught = 0, misses = 0, outside = 0;
  let stop: 'cap' | 'budget' | 'rate' | null = null;

  for (const t of plan) {
    const cost = t.cls === 'unknown' ? 1 : t.numbers.length;
    if (CAP !== undefined && sessionSpend + cost > CAP) { stop = 'cap'; break; }
    if (serpApiLeft < BUDGET_STOP) { stop = 'budget'; break; }

    const r = await teach(t, map);
    if (r === 'limited') { stop = 'rate'; break; }
    if (r === 'taught') {
      taught++;
      console.log(`  ✓ [${t.cls === 'unknown' ? 'C' : 'B'}] ${t.street}  (spend ${sessionSpend}, left ${serpApiLeft})`);
    } else if (r === 'outside') {
      outside++;
      console.log(`  ✗ outside bbox: ${t.street} — stays in the census residue (monthly loop owns it)`);
    } else {
      misses++;
      console.log(`  ✗ miss: ${t.street}`);
    }
    if (t.cls === 'unknown') await sleep(PACING_MS);
  }

  map.close();
  console.log('');
  console.log(`taught: ${taught}, misses: ${misses}, outside-bbox: ${outside}, spend: ${sessionSpend} searches`
    + (stop ? `, STOPPED (${stop === 'cap' ? '--cap reached' : stop === 'budget' ? `engine budget floor ${BUDGET_STOP}` : '429 storm — resume tomorrow, keep the residue'})` : ''));
  console.log('Re-run any time: taught streets now classify known and are skipped.');
  if (stop === 'rate') process.exit(2); // caller-visible abort signal, residue kept
}

main().catch(e => { console.error(e); process.exit(1); });
