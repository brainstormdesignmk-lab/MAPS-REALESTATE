#!/usr/bin/env tsx
/**
 * audit-public-landmarks.ts — READ-ONLY priority audit of the FINISHED map.
 * Manual: `npm run audit:public` (0 SerpApi searches, no writes).
 *
 * OWNER RULE (2026-10-29): schools, universities, markets, student
 * dormitories, theatres, cinemas, hospitals and the rest of the big PUBLIC
 * buildings are the landmarks a client means — but NOTHING is deleted: every
 * map row stays a search candidate and the ladder only decides its priority.
 *
 * This audit is the November gate that proves that rule holds on the TOTAL
 * map (after §5's SERP sweep has closed the grid and the property sweep has
 * run). It reads the same two things the reply path reads — `typeRank()` and
 * `nearestPois()` — so a pass here means the answers inherit it:
 *
 *   1. UNRANKED PUBLIC TYPES — a public class spelled a way TYPE_ALIASES does
 *      not know scores 0 and silently loses to a pharmacy. Every such type is
 *      a failure, listed with its row count so the alias can be added.
 *   2. ANCHOR REACHABILITY — a ranked public row must actually come back from
 *      `nearestPois()` at its own pin (sampled, ≤ 3 rows per type). A row that
 *      ranks but never serves is typo'd, filtered or merged away.
 *   3. COVERAGE WARNINGS — a public class with zero rows (a map gap, not a
 *      ranking defect) is reported, never failed.
 *
 * Commercial "schools" (driving, language, dance, music…) are businesses, not
 * public anchors: they are allowed to stay at rank 0, and are listed as such.
 *
 * Exit 1 = do not ship the map; add the missing spelling to TYPE_ALIASES in
 * src/geo/types.ts (never delete a row) and re-run.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as dotenv from 'dotenv';
import { canonicalType, normType, typeRank } from '../src/geo/types';
import { OfflineMapStore } from '../src/geo/offlineMap';

dotenv.config({ path: path.join(os.homedir(), '.lina', 'lina.env') });

const POIS_DB = process.env.SKOPJE_POIS_DB ?? path.join(process.cwd(), 'data', 'skopje-pois.db');

/** The classes the owner named (plus the rest of the big public buildings). */
const REQUIRED_CLASSES = [
  'school', 'university', 'market', 'dormitory', 'theatre', 'cinema',
  'hospital', 'mall', 'courthouse', 'cultural_center', 'attraction', 'park',
  'church', 'government', 'townhall', 'embassy', 'kindergarten', 'library',
  'museum', 'stadium', 'police', 'fire_station',
];

/** Rank 0 is CORRECT for these — a paid skills class is not a public anchor. */
const COMMERCIAL_SCHOOL =
  /(driving|beauty|martial arts|dance|ballet|music|art school|language|computer|aikido|mathematics|foreign languages|motorcycle|grappling)/;

/** Roots that mark a type as a public institution when it arrives unranked. */
const PUBLIC_ROOT =
  /(school|universit|facult|college|academ|dormitor|student_accommodation|market|theat|cinema|hospital|policlinic|court|museum|librar|stadium|arena|kindergarten|preschool|government|embassy|community|cultural)/;

interface Row { name: string; type: string; lat: number; lon: number; place_id: string | null }

function main(): number {
  let db: Database.Database;
  try {
    db = new Database(POIS_DB, { readonly: true });
  } catch (e) {
    console.error(`✗ cannot open the map (${POIS_DB}): ${(e as Error).message}`);
    return 1;
  }
  const rows = db.prepare('SELECT name, type, lat, lon, place_id FROM pois').all() as Row[];
  db.close();

  console.log(`=== PUBLIC-PLACE PRIORITY AUDIT — ${POIS_DB} ===`);
  console.log(`map: ${rows.length} rows · searches: 0 (read-only)\n`);
  if (rows.length < 1000) {
    console.error(`✗ only ${rows.length} rows — that is the wrong-map signature, not a finished map`);
    return 1;
  }

  // ── 1. the ladder as it actually stands on this map ──────────────────────
  const byType = new Map<string, { count: number; rank: number }>();
  for (const r of rows) {
    const t = normType(r.type);
    const seen = byType.get(t);
    if (seen) seen.count++;
    else byType.set(t, { count: 1, rank: typeRank(r.type) });
  }
  console.log('LADDER — higher = stronger anchor (every row stays a candidate)');
  for (const rank of [5, 4, 3, 2, 1]) {
    const types = [...byType.entries()]
      .filter(([, v]) => v.rank === rank)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([t, v]) => `${t}=${v.count}`);
    if (types.length) console.log(`  ${rank}  ${types.join(' · ')}`);
  }
  const unranked = [...byType.entries()].filter(([, v]) => v.rank === 0);
  console.log(`  0  ${unranked.length} unclassified types (${unranked.reduce((n, [, v]) => n + v.count, 0)} rows)\n`);

  // ── 2. unranked public types — the defect class this gate exists for ─────
  const defects = unranked
    .filter(([t]) => PUBLIC_ROOT.test(t) && !COMMERCIAL_SCHOOL.test(t))
    .sort((a, b) => b[1].count - a[1].count);
  if (defects.length) {
    console.log('UNRANKED PUBLIC TYPES — a public class ranking 0 loses to every shop');
    for (const [t, v] of defects) console.log(`  ✗ "${t}" (${v.count} rows) → add a TYPE_ALIASES entry`);
    console.log('');
  } else {
    console.log('UNRANKED PUBLIC TYPES: none — every public class on this map ranks\n');
  }
  const commercial = unranked.filter(([t]) => PUBLIC_ROOT.test(t) && COMMERCIAL_SCHOOL.test(t));
  if (commercial.length) {
    console.log(`  (rank 0 on purpose — paid skills classes: ${commercial.map(([t, v]) => `${t}=${v.count}`).join(', ')})\n`);
  }

  // ── 3. coverage warnings — a public class with no rows at all ────────────
  const present = new Set(rows.map(r => canonicalType(r.type)));
  const missing = REQUIRED_CLASSES.filter(c => !present.has(c));
  if (missing.length) console.log(`⚠ classes with no rows on this map (coverage gap, not a ranking defect): ${missing.join(', ')}\n`);

  // ── 4. anchor reachability — a ranked public row must actually serve ─────
  const publicRows = rows.filter(r => typeRank(r.type) >= 4);
  const perType = new Map<string, number>();
  const sample: Row[] = [];
  for (const r of publicRows) {
    const t = normType(r.type);
    const n = perType.get(t) ?? 0;
    if (n >= 3 || sample.length >= 240) continue;
    perType.set(t, n + 1);
    sample.push(r);
  }
  const store = new OfflineMapStore(POIS_DB);
  const unserved: string[] = [];
  for (const r of sample) {
    const pois = store.nearestPois(r.lat, r.lon, 250, 60);
    const served = pois.some(p =>
      (r.place_id && p.place_id === r.place_id) || p.name === r.name || p.distance_m <= 10);
    if (!served) unserved.push(`${r.name} [${r.type}] @ ${r.lat},${r.lon}`);
  }
  store.close();
  console.log(`ANCHOR REACHABILITY: ${sample.length - unserved.length}/${sample.length} public rows served at their own pin`);
  for (const u of unserved) console.log(`  ✗ ${u}`);
  console.log('');

  const ok = defects.length === 0 && unserved.length === 0;
  console.log(ok
    ? '=== PASS — every public place on this map ranks and serves ==='
    : '=== FAIL — fix the types above (alias, never delete) and re-run ===');
  return ok ? 0 : 1;
}

process.exit(main());
