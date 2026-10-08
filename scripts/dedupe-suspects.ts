// DEDUPE SUSPECT PAIRS — apply the conservative merge to skopje-pois.db.
//
// The report (suspect-pairs.ts) flags pairs that MIGHT be one place under two
// identities. This script decides each pair with the shared, tested rule in
// src/geo/dedupeSuspects.ts and collapses ONLY genuine duplicates. Ambiguous
// pairs (two same-named branches, a shop whose name does not derive from the
// mall's) are left untouched and printed as "for review" — nothing is silently
// dropped. Before any delete, the survivor is backfilled with the dropped
// row's capture fields so no data is lost.
//
// Usage:
//   npx tsx scripts/dedupe-suspects.ts --dry-run     # plan only, no writes
//   npx tsx scripts/dedupe-suspects.ts               # backup + apply
//   npx tsx scripts/dedupe-suspects.ts --db=path
import '../src/compat/node16';
import Database from 'better-sqlite3';
import fs from 'fs';
import {
  detectSuspects, decideMerge, mergeComponents, mergeRowFields,
  type PoiRow,
} from '../src/geo/dedupeSuspects';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const dbArg = args.find(a => a.startsWith('--db='));
const dbPath = dbArg ? dbArg.split('=')[1] : (process.env.SKOPJE_POIS_DB ?? 'data/skopje-pois.db');

if (!fs.existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath);

// Schema-tolerant select — a pre-capture DB simply has fewer columns.
const cols = (db.prepare('PRAGMA table_info(pois)').all() as Array<{ name: string }>).map(c => c.name);
const sel = [
  'rowid, name, type, lat, lon, source',
  cols.includes('place_id') ? 'place_id' : 'NULL AS place_id',
  cols.includes('phone') ? 'phone' : 'NULL AS phone',
  cols.includes('review_count') ? 'review_count' : 'NULL AS review_count',
  cols.includes('rating') ? 'rating' : 'NULL AS rating',
  cols.includes('website') ? 'website' : 'NULL AS website',
  cols.includes('plus_code') ? 'plus_code' : 'NULL AS plus_code',
  cols.includes('price_level') ? 'price_level' : 'NULL AS price_level',
  cols.includes('types') ? 'types' : 'NULL AS types',
  cols.includes('place_url') ? 'place_url' : 'NULL AS place_url',
].join(', ');
const rows = db.prepare(`SELECT ${sel} FROM pois`).all() as PoiRow[];

const pairs = detectSuspects(rows);
const components = mergeComponents(pairs);
const merged = pairs.filter(p => decideMerge(p).merge);
const review = pairs.filter(p => !decideMerge(p).merge);
const rowsToDelete = components.reduce((n, c) => n + c.dropped.length, 0);

console.log(`# Dedupe suspects — ${dbPath}`);
console.log(`Scanned ${rows.length} rows. ${pairs.length} suspect pairs.`);
console.log(`Merge: ${merged.length} pairs → ${components.length} components, ${rowsToDelete} rows to drop`);
console.log(`Leave for review: ${review.length} pairs\n`);

for (const c of components) {
  console.log(`KEEP "${c.survivor.name}" (rowid ${c.survivor.rowid}, ${c.survivor.source}, ${c.survivor.review_count ?? '—'} rev)`);
  for (const d of c.dropped) console.log(`   drop "${d.name}" (rowid ${d.rowid}, ${d.source}, ${d.review_count ?? '—'} rev)`);
  console.log(`   reason: ${c.reasons.join('; ')}`);
}

console.log(`\n--- LEFT FOR REVIEW (${review.length}) ---`);
for (const p of review) {
  console.log(`  "${p.a.name}" <> "${p.b.name}" — ${decideMerge(p).reason}`);
}

if (DRY) {
  console.log('\n--dry-run: no rows changed.');
  db.close();
  process.exit(0);
}

if (rowsToDelete === 0) {
  console.log('\nNothing to merge.');
  db.close();
  process.exit(0);
}

// Backup, then apply in one transaction.
const backupPath = `${dbPath}.pre-suspect-merge-${Date.now()}`;
fs.copyFileSync(dbPath, backupPath);
console.log(`\nBackup: ${backupPath}`);

const updateCols = ['phone', 'website', 'plus_code', 'price_level', 'types', 'place_url', 'place_id', 'review_count', 'rating']
  .filter(c => cols.includes(c));
const delStmt = db.prepare('DELETE FROM pois WHERE rowid = ?');
// Prepared per distinct set of donated columns — a statement must bind exactly
// the columns in its SET clause.
const updCache = new Map<string, ReturnType<typeof db.prepare>>();
const updFor = (present: string[]): ReturnType<typeof db.prepare> => {
  const key = present.join(',');
  let stmt = updCache.get(key);
  if (!stmt) {
    stmt = db.prepare(`UPDATE pois SET ${present.map(c => `${c} = ?`).join(', ')} WHERE rowid = ?`);
    updCache.set(key, stmt);
  }
  return stmt;
};

let backfilled = 0;
db.exec('BEGIN IMMEDIATE');
try {
  for (const c of components) {
    for (const d of c.dropped) {
      const fields = mergeRowFields(c.survivor, d);
      const present = updateCols.filter(k => k in fields);
      if (present.length > 0) {
        updFor(present).run(...present.map(k => fields[k]), c.survivor.rowid);
        backfilled++;
      }
      delStmt.run(d.rowid);
    }
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Merge failed, rolled back:', (e as Error).message);
  db.close();
  process.exit(1);
}

const after = (db.prepare('SELECT COUNT(*) as c FROM pois').get() as { c: number }).c;
console.log(`Merged: dropped ${rowsToDelete} rows, backfilled ${backfilled} survivors.`);
console.log(`POIs: ${rows.length} → ${after}`);
db.close();
console.log(`\nDone. Backup at: ${backupPath}`);
