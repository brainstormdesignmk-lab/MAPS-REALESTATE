#!/usr/bin/env tsx
/**
 * healthcheck.ts — daily read-only state snapshot (cron: 0 5 * * *).
 *
 * Logs the health of the geo system into logs/health.log so a month of cron
 * logs can prove fire-and-forget: POI counts by source, landmark-cache tiers,
 * and the re-resolve queue. Purely local SQLite reads — NO network, no writes,
 * no SerpApi budget. Exits 1 only when a DB can't be opened (cron mail would
 * flag that); every other state is reported, not alarmed.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(os.homedir(), '.lina', 'lina.env') });

/** env var or undefined — an EMPTY value ('' as written in some lina.env
 *  files) must behave exactly like an unset var, or the data-path fallbacks
 *  below resolve to '' and every DB open fails. */
function env(k: string): string | undefined {
  const v = process.env[k];
  return v && v.trim() ? v : undefined;
}

const POIS_DB = env('SKOPJE_POIS_DB') ?? path.join(process.cwd(), 'data', 'skopje-pois.db');
const LINA_DB = env('DB_PATH') ?? path.join(process.cwd(), 'data', 'lina.db');

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function readOne(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

function open(dbPath: string, what: string): Database.Database | null {
  try {
    return new Database(dbPath, { readonly: true });
  } catch (e) {
    log(`⚠ cannot open ${what} (${dbPath}): ${(e as Error).message}`);
    return null;
  }
}

function main(): void {
  let problems = 0;

  // 1) Merged POI table (skopje-pois.db)
  const pois = open(POIS_DB, 'POI table');
  if (pois) {
    const total = readOne(pois, 'SELECT COUNT(*) as c FROM pois');
    const bySource = pois.prepare('SELECT source, COUNT(*) as c FROM pois GROUP BY source').all() as Array<{ source: string; c: number }>;
    const osm = bySource.find(s => s.source === 'osm')?.c ?? 0;
    const google = bySource.find(s => s.source === 'google')?.c ?? 0;
    log(`POIs: ${total} total (osm ${osm}, google ${google})`);
    pois.close();
  } else {
    problems++;
  }

  // 2) Runtime DB (lina.db) — landmark cache tiers + re-resolve queue.
  //    Schema-defensive: a pre-migration DB has no `tier` column (address_key
  //    era) — report what actually exists instead of crashing on a column.
  const lina = open(LINA_DB, 'runtime DB');
  if (lina) {
    const lmCols = lina.prepare('PRAGMA table_info(landmarks)').all() as Array<{ name: string }>;
    if (lmCols.some(c => c.name === 'tier')) {
      const tiers = lina.prepare(
        'SELECT tier, COUNT(*) as c FROM landmarks GROUP BY tier ORDER BY c DESC'
      ).all() as Array<{ tier: string | null; c: number }>;
      log(`Landmark cache: ${tiers.length === 0 ? 'empty' : tiers.map(t => `${t.tier ?? 'null'}=${t.c}`).join(', ')}`);
    } else {
      const sources = lina.prepare(
        'SELECT source, COUNT(*) as c FROM landmarks GROUP BY source ORDER BY c DESC'
      ).all() as Array<{ source: string; c: number }>;
      log(`Landmark cache (pre-tier schema): ${sources.length === 0 ? 'empty' : sources.map(s => `${s.source}=${s.c}`).join(', ')}`);
    }
    let queue = 0;
    try { queue = readOne(lina, 'SELECT COUNT(*) as c FROM geo_reresolve_queue'); } catch { queue = -1; }
    log(`Re-resolve queue: ${queue < 0 ? 'n/a (no queue table)' : `${queue} rows`}`);
    lina.close();
  } else {
    problems++;
  }

  if (problems > 0) {
    log('HEALTH: DEGRADED (a DB could not be opened)');
    process.exit(1);
  }
  log('HEALTH: OK');
}

main();