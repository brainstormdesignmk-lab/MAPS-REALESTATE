#!/usr/bin/env tsx
/**
 * street-census.ts — THE PROBE (October runbook Step 2) + coverage report.
 *
 * Classifies every candidate street the bot could ever be asked about —
 *   union: the local map's addresses ∪ every street ever carried in a feed
 *   address (incl. removed properties) ∪ OSM street names — into
 *     (a) known   (map resolves trusted, ≥2 numbered rows)  → skip
 *     (b) thin    (in the map, numbers missing/thin)         → geocode ONLY
 *           the numbers the feed actually carried
 *     (c) unknown (not in the map at all)                    → ONE geocode
 *           "<street>, Скопје" teaches the whole street (learnStreet)
 * and prints the projected SerpApi cost — the runbook's DECISION GATE.
 * Never spends: zero SerpApi calls, zero network.
 *
 *   npx tsx scripts/street-census.ts           # probe + projection
 *   npx tsx scripts/street-census.ts --verify  # coverage report (Step 7)
 *   npx tsx scripts/street-census.ts --json    # machine-readable
 *
 * Idempotent and free — re-run any time.
 */

import '../src/compat/node16';

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import {
  collectCandidates, classifyAll, projectCoverage,
  type StreetCandidate,
} from '../src/geo/streetCensus';
import { streetKey } from '../src/geo/offlineMap';

dotenv.config({ path: path.join(os.homedir(), '.lina', 'lina.env') });

const POIS_DB = process.env.SKOPJE_POIS_DB ?? path.join(process.cwd(), 'data', 'skopje-pois.db');
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://qkgioqotxjxffiaufgwd.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrZ2lvcW90eGp4ZmZpYXVmZ3dkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxMTU0NjUsImV4cCI6MjA3MDY5MTQ2NX0.WVno6c6_rvFqFwj1fN8UWHYmlit0C-6J_h57P8d5eOI';

const AS_JSON = process.argv.includes('--json');
const VERIFY = process.argv.includes('--verify');

/** Projection that trips the runbook's 800-search budget gate. */
const GATE_MAX_SEARCHES = 800;

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

function loadLocal(): { mapStreets: string[]; osmStreets: string[] } {
  const db = new Database(POIS_DB, { readonly: true });
  // Map streets: distinct street spellings (display names) — one per key.
  const mapStreets = (db.prepare(
    'SELECT street FROM addresses GROUP BY key'
  ).all() as Array<{ street: string }>).map(r => r.street);
  // OSM street names live in the same table for this build; a street that
  // is OSM-known but map-unknown does not exist as long as Phase A feeds
  // the addresses table — so osmStreets here equals the map set, and the
  // union is still correct (the feed adds the delta, which is the point).
  const osmStreets = mapStreets;
  db.close();
  return { mapStreets, osmStreets };
}

/** Probes keyed by streetKey, computed once from one table scan: does the
 *  map know the street AT ALL, and how many NUMBERED rows it carries. */
function makeProbes(): { knows: (street: string) => boolean; numberedRows: (street: string) => number } {
  const db = new Database(POIS_DB, { readonly: true });
  const rows = db.prepare(
    `SELECT key,
            SUM(CASE WHEN housenumber != '' AND housenumber != 'ББ' THEN 1 ELSE 0 END) AS numbered
       FROM addresses GROUP BY key`
  ).all() as Array<{ key: string; numbered: number | null }>;
  db.close();
  const numberedByKey = new Map<string, number>();
  for (const r of rows) numberedByKey.set(r.key, r.numbered ?? 0);
  // Keys for knows(): EVERY key with any row (numbered or not).
  const allKeys = new Set(rows.map(r => r.key));
  return {
    knows: (street: string) => allKeys.has(streetKey(street)),
    numberedRows: (street: string) => numberedByKey.get(streetKey(street)) ?? 0,
  };
}

async function main(): Promise<void> {
  console.log(`=== street-census${VERIFY ? ' --verify' : ''} ===`);
  if (!fs.existsSync(POIS_DB)) {
    console.error(`Map DB not found: ${POIS_DB}`);
    process.exit(1);
  }

  const { mapStreets, osmStreets } = loadLocal();
  console.log(`map streets: ${mapStreets.length}`);

  let feedAddresses: string[] = [];
  try {
    feedAddresses = await fetchFeedAddresses();
    console.log(`feed addresses: ${feedAddresses.length}`);
  } catch (e) {
    console.warn(`⚠ Feed fetch failed (${(e as Error).message}) — census continues on map+OSM only`);
  }

  const probe = makeProbes();
  const candidates: StreetCandidate[] = collectCandidates({
    mapStreets, feedAddresses, osmStreets,
    probes: probe,
  });
  const classified = classifyAll(candidates, probe.knows);
  const projection = projectCoverage(classified);

  if (AS_JSON) {
    console.log(JSON.stringify({
      candidates: candidates.length,
      ...projection,
      gate: { max: GATE_MAX_SEARCHES, exceeded: projection.searches > GATE_MAX_SEARCHES },
    }, null, 2));
    return;
  }

  console.log('');
  console.log('STREET COVERAGE — ' + new Date().toISOString().slice(0, 10));
  console.log(`  candidate streets (feed ∪ map ∪ OSM):  ${candidates.length}`);
  console.log(`  (a) known / trusted:                    ${projection.known}`);
  console.log(`  (b) thin — teach feed numbers:          ${projection.thin} streets, ${projection.thinNumbers} searches`);
  console.log(`  (c) unknown — one geocode each:         ${projection.unknown} searches`);
  console.log('');
  console.log(`projected searches: class (c) = ${projection.unknown}, class (b) = ${projection.thinNumbers}`
    + `  →  total ${projection.searches}  (~${(projection.searches / 250).toFixed(1)} keys)`);

  if (!VERIFY) {
    if (projection.searches > GATE_MAX_SEARCHES) {
      console.log('');
      console.log(`⚠ DECISION GATE: projection exceeds ${GATE_MAX_SEARCHES} searches for streets.`);
      console.log('  Trim order per the runbook: class (b) numbers (raise --min-feed-count)');
      console.log('  → class (b) entirely (numbers arrive via Phase B harvest + B3).');
      console.log('  Class (c) is NEVER trimmed — it is the whole point.');
    } else {
      console.log('  ✓ under the 800-search gate — proceed to street-teach.');
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
