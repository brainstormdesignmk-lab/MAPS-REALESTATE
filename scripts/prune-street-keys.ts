/**
 * PRUNE THE LEARNED STREET ANCHORS THAT ARE NOT STREETS.
 *
 * The address layer trusts a `source='google_street'` row as proof that a street
 * exists at that point. Old street-teach runs (before the write guard) planted
 * anchors from LANDMARK-form feed addresses — «ШАМПИОНЧЕ КАК КИПЕР МАРКЕТ»,
 * «ЦРНОГОРСКА АМБАСАДА», «КАЈ СИТИ МОЛ ' РУСКИТЕ ЗГРАДИ», «оу Лазо
 * Ангеловски» — and a bare «Boulevard». Each one lets the resolver answer a
 * street question with a shop, an embassy or a school.
 *
 * THE PREDICATE IS THE WRITER'S (`assessStreetKey`), not a second opinion: the
 * same call that now refuses to WRITE such a row decides which rows to remove,
 * so the map can never disagree with its own gate.
 *
 * What it does NOT touch: learned anchors named after a QUARTER («Буњаковец»,
 * «Козле», «Чаир», «Визбегово») — «Буњаковец 5» is a real Skopje address form
 * and that anchor is what resolves it offline.
 *
 *   npx tsx scripts/prune-street-keys.ts --dry     # report only (default too)
 *   npx tsx scripts/prune-street-keys.ts --apply   # delete, then SHA-stamp
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assessStreetKey } from '../src/geo/offlineMap';

const POIS_DB = path.resolve(__dirname, '..', 'data', 'skopje-pois.db');
const APPLY = process.argv.includes('--apply');

interface Learned {
  street: string;
  key: string;
  rows: number;
  numbered: number;
  lat: number;
  lon: number;
}

function main(): void {
  if (!fs.existsSync(POIS_DB)) {
    console.error(`Map DB not found: ${POIS_DB}`);
    process.exit(1);
  }
  const db = new Database(POIS_DB, { readonly: !APPLY });
  const learned = db.prepare(
    `SELECT street, key, COUNT(*) AS rows,
            SUM(CASE WHEN housenumber != '' AND housenumber != 'ББ' THEN 1 ELSE 0 END) AS numbered,
            AVG(lat) AS lat, AVG(lon) AS lon
       FROM addresses WHERE source = 'google_street'
      GROUP BY key ORDER BY street`
  ).all() as Learned[];

  const refused = learned
    .map(l => ({ ...l, verdict: assessStreetKey(l.street) }))
    .filter(l => !l.verdict.streetLike);

  console.log(`=== prune-street-keys${APPLY ? '' : ' (DRY — nothing deleted)'} ===`);
  console.log(`learned street anchors: ${learned.length}, not a street: ${refused.length}`);
  for (const r of refused) {
    console.log(`  ✗ ${r.street}  [${r.verdict.reason}]  ${r.rows} row(s)`
      + `  ${r.lat.toFixed(5)}/${r.lon.toFixed(5)}`);
  }
  const kept = learned.filter(l => assessStreetKey(l.street).streetLike);
  const keptWithNumbers = kept.filter(l => l.numbered > 0);
  console.log(`kept: ${kept.length} (${keptWithNumbers.length} carry a house number)`);
  for (const k of kept) console.log(`  · ${k.street}${k.numbered ? `  (${k.numbered} numbered)` : ''}`);

  if (!APPLY) {
    console.log('\nDRY run — re-run with --apply to delete the rows above.');
    db.close();
    return;
  }
  if (!refused.length) {
    console.log('nothing to delete.');
    db.close();
    return;
  }
  const del = db.prepare('DELETE FROM addresses WHERE key = ? AND source = ?');
  const tx = db.transaction((keys: string[]) => {
    let n = 0;
    for (const k of keys) n += del.run(k, 'google_street').changes;
    return n;
  });
  const removed = tx(refused.map(r => r.key));
  db.close();

  // The stamped map is an artifact with a SHA sidecar — keep them in step.
  const sha = crypto.createHash('sha256').update(fs.readFileSync(POIS_DB)).digest('hex');
  const sidecar = `${POIS_DB}.sha256`;
  if (fs.existsSync(sidecar)) {
    const prev = fs.readFileSync(sidecar, 'utf8').trim();
    fs.writeFileSync(sidecar, `${sha}\n`);
    console.log(`sha256 ${prev} → ${sha}`);
  }
  console.log(`deleted ${removed} address row(s).`);
}

main();
