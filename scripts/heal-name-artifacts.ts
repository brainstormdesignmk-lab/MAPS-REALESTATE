/**
 * heal-name-artifacts — repair half-Cyrillic POI names in the offline map.
 *
 * OSM/Google rows sometimes carry one script's letter where the other belongs:
 *   "Aмбасада на Република Хрватска"   (Latin A in a Cyrillic word)
 *   "Блок Градски Sид"                 (Latin S in a Cyrillic word)
 *   "Post Officе"                      (Cyrillic е in a Latin name)
 *   "Trgovski           centar „Kapištec“" (padded whitespace, Latin-only name)
 * They render as broken script to the client AND break matching: a client who
 * types the honest Cyrillic "Амбасада…" never equals the stored Latin "Aм…".
 *
 * The build now runs cleanPoiName() on every inserted row, so a rebuild is
 * clean. This script heals the DB already on disk (the runtime map), UPDATE
 * only — coordinates, place_ids and row counts are untouched.
 *
 *   npx tsx scripts/heal-name-artifacts.ts            # dry run, prints rows
 *   npx tsx scripts/heal-name-artifacts.ts --apply    # writes (keeps a .bak)
 *
 * Idempotent: a second --apply pass reports 0 changes.
 */
import '../src/compat/node16';

import Database from 'better-sqlite3';
import { copyFileSync, existsSync } from 'fs';
import path from 'path';
import { cleanPoiName, cleanStreetName, streetKey } from '../src/geo/offlineMap';

const DB_PATH = process.env.SKOPJE_POIS_DB ?? path.join(process.cwd(), 'data', 'skopje-pois.db');
const APPLY = process.argv.includes('--apply');

function main(): void {
  if (!existsSync(DB_PATH)) {
    console.error(`[heal-names] map not found: ${DB_PATH}`);
    process.exit(1);
  }
  if (APPLY) {
    const bak = `${DB_PATH}.pre-name-heal.bak`;
    if (!existsSync(bak)) copyFileSync(DB_PATH, bak);
    console.log(`[heal-names] backup: ${bak}`);
  } else {
    console.log('[heal-names] DRY RUN — pass --apply to write');
  }

  const db = new Database(DB_PATH);
  const rows = db.prepare('SELECT rowid, name FROM pois').all() as Array<{ rowid: number; name: string }>;
  const upd = db.prepare('UPDATE pois SET name = ? WHERE rowid = ?');

  const changes: Array<{ rowid: number; from: string; to: string }> = [];
  const write = db.transaction(() => {
    for (const r of rows) {
      const to = cleanPoiName(r.name);
      if (to === r.name) continue;
      changes.push({ rowid: r.rowid, from: r.name, to });
      if (APPLY) upd.run(to, r.rowid);
    }
  });
  write();

  console.log(`[heal-names] ${rows.length} rows scanned, ${changes.length} artifact(s)${APPLY ? ' healed' : ' found'}`);
  for (const c of changes) console.log(`  ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);

  // STREETS — the geocoder keys on the addresses table, so an artifact street
  // ("Kоце Mеталец") is both unmatchable and shown in resolved addresses.
  const streets = db.prepare('SELECT rowid, street FROM addresses').all() as Array<{ rowid: number; street: string }>;
  const updStreet = db.prepare('UPDATE addresses SET street = ?, key = ? WHERE rowid = ?');
  let streetChanges = 0;
  const writeStreets = db.transaction(() => {
    for (const r of streets) {
      const to = cleanStreetName(r.street);
      if (to === r.street) continue;
      streetChanges++;
      console.log(`  street ${JSON.stringify(r.street)} -> ${JSON.stringify(to)}`);
      if (APPLY) updStreet.run(to, streetKey(to), r.rowid);
    }
  });
  writeStreets();
  console.log(`[heal-names] ${streets.length} street rows scanned, ${streetChanges} artifact(s)${APPLY ? ' healed' : ' found'}`);

  // Post-conditions: no stored name mixes scripts inside a word any more.
  const left = (db.prepare('SELECT name FROM pois').all() as Array<{ name: string }>)
    .map(r => r.name)
    .filter(n => cleanPoiName(n) !== n);
  const leftStreets = (db.prepare('SELECT street FROM addresses').all() as Array<{ street: string }>)
    .map(r => r.street)
    .filter(n => cleanStreetName(n) !== n);
  db.close();
  if (APPLY && leftStreets.length > 0) {
    console.error(`[heal-names] FAILED: ${leftStreets.length} street(s) still unclean`);
    process.exit(1);
  }

  if (APPLY && left.length > 0) {
    console.error(`[heal-names] FAILED: ${left.length} name(s) still unclean`);
    process.exit(1);
  }
  console.log(APPLY ? `OK: 0 artifacts remain in ${DB_PATH}` : `Dry run complete (${changes.length} would change).`);
}

main();
