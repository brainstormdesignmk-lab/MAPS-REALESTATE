#!/usr/bin/env tsx
/**
 * backfill-identity.ts — the landmark identity pass.
 *
 * The tile grid captures what Google returns for its 15 categories. A row that
 * Google never lists under one of them keeps `place_id IS NULL` for ever, and
 * those are exactly the rows a client hears: within 200 m of the live
 * properties, most landmark candidates had no identity. This script spends
 * ONE name search per such row and attaches Google's identity (place_id,
 * review_count, rating, plus_code, phone, website, closed, types) to the SAME
 * row, so:
 *   • prominence (log10 reviews) can finally rank the busiest branch;
 *   • a permanently closed pharmacy stops being served as an anchor;
 *   • the reader's twin merge (samePlacePoi) has an identity to merge on.
 *
 * WHAT IT WILL NOT DO: move a pin (that is the capture path's business, with
 * its drift guard), invent an identity, or write a candidate the shared
 * identity rule refuses. Refusals are reported with the reason.
 *
 * TARGETS
 *   --pool       landmark candidates within --radius (default 200 m) of a live
 *                property — what the feed can actually say
 *   --classes    named rows of the thin anchor classes city-wide
 *                (place_of_worship, church, cathedral, mosque, park,
 *                university, market, marketplace, police, townhall,
 *                courthouse, municipality)
 *   --all        both (the default)
 *
 * RUN IT DRY FIRST — the plan is printed, nothing is spent:
 *   npx tsx scripts/backfill-identity.ts --dry
 *   npx tsx scripts/backfill-identity.ts                 # spend
 *   npx tsx scripts/backfill-identity.ts --cap=200       # bounded run
 *   npx tsx scripts/backfill-identity.ts --name "Католичка црква"   # one row
 *
 * Rules (the same ones every paid script here follows):
 *   • 1100 ms between calls (SerpApi allows 1 req/s);
 *   • probe /account per key (free) — a key with 0 left is skipped, never
 *     hammered; stop at the BUDGET_FLOOR;
 *   • a 429 / "run out" rotates the key; five consecutive failures end the run
 *     rather than grinding;
 *   • a miss is remembered in data/identity-backfill-misses.json and skipped
 *     for the next two runs (a name Google cannot match will not start matching
 *     tomorrow, and a repeated miss spends quota for nothing).
 *
 * EXIT CODE: 0 = the run did what it planned; 1 = no key could search (or the
 * plan was non-empty and nothing was attempted) — never a silent no-op.
 */

import '../src/compat/node16';

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { resolveMapDb, REPO_ROOT } from '../src/geo/runtimeDb';
import { capturePoi, type CapturedPoi } from '../src/geo/serpCapture';
import {
  selectIdentityTargets, acceptIdentity, writeIdentity, identityCoverage, hasIdentifiedTwin,
  ANCHOR_CLASSES, POOL_RADIUS_M, type IdentityOrigin, type IdentityTarget,
} from '../src/geo/identityBackfill';

dotenv.config({ path: path.join(os.homedir(), '.lina', 'lina.env') });

// ── CLI ──────────────────────────────────────────────────────────────────────
const ARGV = process.argv.slice(2);
const has = (flag: string) => ARGV.includes(flag);
const val = (flag: string): string | undefined => {
  const hit = ARGV.find(a => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
};
const DRY = has('--dry');
const ONLY_POOL = has('--pool');
const ONLY_CLASSES = has('--classes');
const DO_POOL = !ONLY_CLASSES || ONLY_POOL;
const DO_CLASSES = !ONLY_POOL || ONLY_CLASSES;
const CAP = val('--cap') ? parseInt(val('--cap')!, 10) : Infinity;
const RADIUS = val('--radius') ? parseInt(val('--radius')!, 10) : POOL_RADIUS_M;
const LIMIT = val('--limit') ? parseInt(val('--limit')!, 10) : undefined;
const NAME = val('--name');
// SHARDING: SerpApi paces per KEY (1 req/s) and each key is its own monthly
// quota, so N workers with N distinct keys is legitimate parallelism — what is
// NOT legitimate is N workers hammering one key. `--shard=k/n` splits the
// selection by index (disjoint, deterministic) and `--key=i` pins the worker to
// one key so two workers can never rate-limit each other.
const SHARD_RAW = val('--shard');
const SHARD = SHARD_RAW ? (() => {
  const [k, n] = SHARD_RAW.split('/').map(x => parseInt(x, 10));
  return Number.isFinite(k) && Number.isFinite(n) && n > 0 ? { k, n } : null;
})() : null;
const KEY_ONLY = val('--key') !== undefined ? parseInt(val('--key')!, 10) : null;
const RETRY_MISSES = has('--retry-misses');
const BUDGET_FLOOR = 20;
const PACE_MS = 1100;
const MISS_FILE = path.join(
  REPO_ROOT, 'data',
  SHARD ? `identity-backfill-misses.shard${SHARD.k}.json` : 'identity-backfill-misses.json',
);
const MISS_MAX_ATTEMPTS = 3;

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── SerpApi keys (the same two sources every paid script reads) ──────────────
function loadSerpApiKeys(): string[] {
  const keys: string[] = [];
  if (process.env.SERPAPI_KEY) keys.push(process.env.SERPAPI_KEY);
  const gmapsFile = path.join(REPO_ROOT, 'GOOGLEMAPS_API_KEY.txt');
  const serpFile = path.join(REPO_ROOT, 'data', 'serpapi-key.txt');
  for (const file of [serpFile, gmapsFile]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || /^[A-Z]/.test(t)) continue;
      if (/^[0-9a-f]{40,}$/i.test(t) && !keys.includes(t)) keys.push(t);
    }
  }
  return keys;
}

const KEYS = loadSerpApiKeys();
const keyLeft: number[] = KEYS.map(() => -1);
let keyIdx = 0;
let totalLeft = 0;

async function probeKeys(): Promise<void> {
  totalLeft = 0;
  for (let i = 0; i < KEYS.length; i++) {
    try {
      const res = await fetch(`https://serpapi.com/account?api_key=${KEYS[i]}`);
      const data = await res.json() as { plan_searches_left?: number; error?: string };
      keyLeft[i] = typeof data.plan_searches_left === 'number' ? data.plan_searches_left : 0;
    } catch {
      keyLeft[i] = 0;
    }
    if (keyLeft[i] > 0) totalLeft += keyLeft[i];
  }
}

/** One paced Google Maps search. Returns the raw payload or null (no key or
 *  the request failed — nothing billed, nothing written). */
async function search(query: string, ll: string): Promise<any | null> {
  for (let attempt = 0; attempt < KEYS.length; attempt++) {
    if (KEY_ONLY !== null) {
      // A pinned worker never touches another key (unless its own has run out,
      // in which case it stops instead of stealing a sibling's quota).
      if (keyLeft[KEY_ONLY] === 0) return null;
      keyIdx = KEY_ONLY;
    }
    const i = keyIdx % Math.max(1, KEYS.length);
    if (keyLeft[i] === 0) { keyIdx++; continue; }
    const url = `https://serpapi.com/search?engine=google_maps&type=search&q=${encodeURIComponent(query)}&hl=en&ll=${encodeURIComponent(ll)}&api_key=${KEYS[i]}`;
    let data: any = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 429) { keyLeft[i] = 0; keyIdx++; continue; }
      data = await res.json();
    } catch (e) {
      log(`  ⚠ request failed: ${(e as Error).message}`);
      return null;
    }
    const err = String(data?.error ?? '');
    if (/run out|invalid api key|expired/i.test(err)) {
      keyLeft[i] = 0;
      keyIdx++;
      continue;
    }
    if (err) { log(`  ⚠ SerpApi: ${err}`); return null; }
    if (keyLeft[i] > 0) keyLeft[i]--;
    totalLeft = Math.max(0, totalLeft - 1);
    keyIdx++;
    return data;
  }
  return null;
}

// ── Feed origins ─────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://qkgioqotxjxffiaufgwd.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrZ2lvcW90eGp4ZmZpYXVmZ3dkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxMTU0NjUsImV4cCI6MjA3MDY5MTQ2NX0.WVno6c6_rvFqFwj1fN8UWHYmlit0C-6J_h57P8d5eOI';

async function fetchOriginProperties(): Promise<Array<IdentityOrigin & { eb: string; neighborhood?: string }>> {
  const url = `${SUPABASE_URL}/rest/v1/properties?select=property_number,neighborhood,lat,lon&lat=not.is.null&lon=not.is.null&limit=1000`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase properties: ${res.status} ${await res.text()}`);
  const rows = await res.json() as Array<{ property_number: string; neighborhood?: string; lat: number; lon: number }>;
  return rows
    .filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon))
    .map(r => ({ eb: String(r.property_number), neighborhood: r.neighborhood, lat: r.lat, lon: r.lon }));
}

// ── Miss ledger ──────────────────────────────────────────────────────────────
interface MissEntry { attempts: number; why: string; candidate?: string; last: string }
function loadMisses(): Record<string, MissEntry> {
  try {
    return JSON.parse(fs.readFileSync(MISS_FILE, 'utf8')) as Record<string, MissEntry>;
  } catch { return {}; }
}
function saveMisses(m: Record<string, MissEntry>): void {
  if (DRY) return;
  fs.writeFileSync(MISS_FILE, `${JSON.stringify(m, null, 2)}\n`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const resolved = resolveMapDb();
  if (!resolved?.file || !fs.existsSync(resolved.file)) {
    console.error('✗ map DB not found (resolveMapDb) — run from the repo that owns the map');
    process.exit(2);
  }
  const db = new Database(resolved.file);
  // Sharded workers share ONE map file: a lock waits, it never fails the run.
  db.pragma('busy_timeout = 15000');
  const origins = await fetchOriginProperties();

  let targets: IdentityTarget[] = selectIdentityTargets(db, {
    origins,
    radius: RADIUS,
    classes: DO_CLASSES ? ANCHOR_CLASSES : [],
  });
  if (!DO_POOL) targets = targets.filter(t => t.group === 'class');
  if (!DO_CLASSES) targets = targets.filter(t => t.group === 'pool');
  if (NAME) {
    const needle = NAME.trim().toLowerCase();
    targets = targets.filter(t => t.name.toLowerCase().includes(needle));
  }
  if (SHARD) targets = targets.filter((_, i) => i % SHARD.n === SHARD.k);
if (typeof LIMIT === 'number') targets = targets.slice(0, LIMIT);

  log(`map: ${resolved.file}`);
  log(`properties with a pin: ${origins.length}`);
  const cov = identityCoverage(db, { origins, radius: RADIUS, classes: ANCHOR_CLASSES });
  log(`coverage now: ${cov.withIdentity}/${cov.totalCandidates} landmark candidates within ${RADIUS} m have identity `
    + `(missing ${cov.poolMissing}); anchor classes missing identity: ${cov.classMissing}`);

  const misses = loadMisses();
  const blocked = (rowid: number) => !RETRY_MISSES && (misses[String(rowid)]?.attempts ?? 0) >= MISS_MAX_ATTEMPTS;
  const beforeBlocked = targets.filter(t => blocked(t.rowid)).length;
  targets = targets.filter(t => !blocked(t.rowid));

  const poolCount = targets.filter(t => t.group === 'pool').length;
  log(`plan: ${targets.length} search(es) — ${poolCount} landmark candidate(s), ${targets.length - poolCount} anchor-class row(s)`
    + (beforeBlocked ? `, ${beforeBlocked} skipped from the miss ledger` : ''));

  if (DRY) {
    for (const t of targets.slice(0, 40)) {
      log(`  [${t.group === 'pool' ? `${Math.round(t.nearestPropertyM)}m` : 'class'}] ${t.name} (${t.type})`);
    }
    if (targets.length > 40) log(`  … and ${targets.length - 40} more`);
    log('DRY run — nothing spent.');
    db.close();
    process.exit(0);
  }

  if (targets.length === 0) {
    log('✓ nothing to backfill — every selected row already carries an identity');
    db.close();
    process.exit(0);
  }
  if (KEYS.length === 0) {
    console.error('✗ no SerpApi keys on disk (SERPAPI_KEY, data/serpapi-key.txt, GOOGLEMAPS_API_KEY.txt)');
    process.exit(1);
  }

  await probeKeys();
  log(`keys: ${KEYS.filter((_, i) => keyLeft[i] > 0).length}/${KEYS.length} usable, ${totalLeft} search(es) left`);
  if (has('--keys')) {
    // Index + remaining only — never the key itself. This is how a sharded run
    // picks `--key=<i>` for its workers.
    log(`per-key: ${keyLeft.map((n, i) => `#${i}=${n}`).join(' ')}`);
    db.close();
    process.exit(0);
  }
  if (totalLeft < BUDGET_FLOOR) {
    console.error(`✗ budget too low (${totalLeft}) — nothing attempted`);
    process.exit(1);
  }

  const runCap = Math.min(CAP, totalLeft - BUDGET_FLOOR);
  let spent = 0;
  let written = 0;
  let already = 0;
  let refused = 0;
  let noResponse = 0;
  let twins = 0;
  const whyCount: Record<string, number> = {};
  const refusals: Array<{ name: string; why: string; candidate?: string; movedM?: number }> = [];

  for (const t of targets) {
    if (spent >= runCap) { log(`  ⚠ cap (${runCap}) reached — stopping`); break; }
    if (totalLeft <= BUDGET_FLOOR) { log(`  ⚠ budget floor reached — stopping`); break; }

    // The neighbouring row already knows this place — no search needed.
    if (hasIdentifiedTwin(db, t)) { twins++; continue; }
    const ll = `@${t.lat},${t.lon},15z`;
    const data = await search(`${t.name}, Скопје`, ll);
    spent++;
    if (data == null) {
      noResponse++;
      misses[String(t.rowid)] = {
        attempts: (misses[String(t.rowid)]?.attempts ?? 0) + 1,
        why: 'no-response', last: new Date().toISOString(),
      };
      if (noResponse >= 5) { log('  ⚠ five consecutive failed searches — stopping'); break; }
      continue;
    }
    noResponse = 0;

    const raw = data?.local_results ?? data?.place_results ?? [];
    const list: any[] = Array.isArray(raw) ? raw : (raw?.title ? [raw] : []);
    let best: { cap: CapturedPoi; verdict: ReturnType<typeof acceptIdentity> } | null = null;
    for (const r of list) {
      const cap = capturePoi(r, t.type);
      if (!cap) continue;
      const verdict = acceptIdentity(t, cap);
      if (verdict.ok) { best = { cap, verdict }; break; }
      if (!best) best = { cap, verdict };
    }

    if (best && best.verdict.ok) {
      const res = writeIdentity(db, t, best.cap);
      if (res === 'written') {
        written++;
        log(`  ✓ ${t.name} → ${best.cap.name}${best.cap.review_count != null ? ` (${best.cap.review_count} reviews, ${best.cap.rating ?? '?'}★)` : ''}`);
      } else if (res === 'already-identified') {
        already++;
      } else if (res === 'identity-taken') {
        // A twin row already holds this identity (UNIQUE place_id). The reader
        // merges the pair; stamping a copy would be a duplicate, not knowledge.
        twins++;
        misses[String(t.rowid)] = {
          attempts: (misses[String(t.rowid)]?.attempts ?? 0) + 1,
          why: 'identity-taken', last: new Date().toISOString(),
        };
      }
      delete misses[String(t.rowid)];
    } else {
      refused++;
      const why = best && !best.verdict.ok ? best.verdict.why : 'no-results';
      whyCount[why] = (whyCount[why] ?? 0) + 1;
      refusals.push({ name: t.name, why, candidate: best?.cap.name, movedM: best && !best.verdict.ok ? best.verdict.movedM : undefined });
      misses[String(t.rowid)] = {
        attempts: (misses[String(t.rowid)]?.attempts ?? 0) + 1,
        why, candidate: best?.cap.name, last: new Date().toISOString(),
      };
    }
    saveMisses(misses);
    await sleep(PACE_MS);
  }

  saveMisses(misses);
  const after = identityCoverage(db, { origins, radius: RADIUS, classes: ANCHOR_CLASSES });
  log(`wrote ${written} identity(ies) (${already} already had one, ${twins} already known by a neighbouring row, `
    + `${refused} refused, ${noResponse} unanswered) in ${spent} search(es)`);
  log(`refusals: ${Object.entries(whyCount).map(([k, n]) => `${k}=${n}`).join(', ') || 'none'}`);
  if (refusals.length > 0) {
    // THE OPERATOR'S REPORT: a refusal is either the rule being right (a
    // different branch, a translated name) or a map row that needs a human.
    // Show the ones with the most metres first — those are the rows where the
    // map's own pin and Google disagree about where the place is.
    const byMoved = [...refusals].filter(r => (r.movedM ?? 0) > 0).sort((a, b) => (b.movedM ?? 0) - (a.movedM ?? 0));
    for (const r of byMoved.slice(0, 12)) {
      log(`  ⚠ refused (${r.why}, ${r.movedM} m): «${r.name}» → «${r.candidate ?? '(no result)'}»`);
    }
    const names = refusals.filter(r => r.why === 'not-same-place').slice(0, 8);
    if (names.length > 0) {
      log(`  ⚠ name mismatch sample: ${names.map(r => `«${r.name}» ≠ «${r.candidate ?? '?'}»`).join(' · ')}`);
    }
    log(`  ⚠ ${refusals.length} refusal(s) recorded in ${path.basename(MISS_FILE)} — a human decides, nothing was written`);
  }
  log(`coverage after: ${after.withIdentity}/${after.totalCandidates} landmark candidates (missing ${after.poolMissing}); anchor classes missing: ${after.classMissing}`);
  if (DRY === false && spent === 0 && targets.length > 0) {
    console.error('✗ nothing was attempted — this run is not a success');
    process.exit(1);
  }
  db.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(2);
});
