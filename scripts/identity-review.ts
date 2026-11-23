/**
 * REVIEW THE IDENTITY BACKFILL'S REFUSALS — for free.
 *
 * Every refusal the backfill recorded is a row the map still serves WITHOUT a
 * Google identity: no reviews, no rating, no closed flag, and a second copy can
 * never be merged into it. The strict rule refuses for good reasons, but the
 * two reasons need different operators:
 *
 *   not-same-place   the names do not agree — a branch, a translation, or a
 *                    genuinely different place. NOTHING to do automatically;
 *                    a wrong accept here would staple a stranger's reviews to
 *                    a landmark.
 *   too-far          the NAMES AGREE and the distance refused. That is either
 *                    pin drift on one side (the map's row sits 250 m from the
 *                    building Google knows) or two branches of one chain. Only
 *                    a human can tell them apart — so this script lists exactly
 *                    those rows, with the candidate, and spends NOTHING.
 *
 *   npx tsx scripts/identity-review.ts            # summary + the drift list
 *   npx tsx scripts/identity-review.ts --write    # …and data/identity-class-review.md
 *
 * No network, no writes to the map. The report is the input to the December
 * targeted pass (one search per row a human marks).
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { samePlaceName } from '../src/geo/offlineMap';

const DATA = path.resolve(__dirname, '..', 'data');
const POIS_DB = path.join(DATA, 'skopje-pois.db');
const WRITE = process.argv.includes('--write');

interface Miss { attempts: number; why: string; candidate: string; last: string }
interface Row { rowid: number; name: string; type: string; lat: number; lon: number }

function readLedger(): Map<number, Miss> {
  const merged = new Map<number, Miss>();
  for (const f of fs.readdirSync(DATA)) {
    if (!/^identity-backfill-misses.*\.json$/.test(f)) continue;
    let parsed: Record<string, Miss>;
    try { parsed = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')) as Record<string, Miss>; } catch { continue; }
    for (const [id, miss] of Object.entries(parsed)) {
      const rowid = Number(id);
      if (!Number.isFinite(rowid) || !miss?.why) continue;
      const prev = merged.get(rowid);
      // The latest attempt wins, so a row that failed differently later is
      // reported by its newest reason.
      if (!prev || String(miss.last ?? '') >= String(prev.last ?? '')) merged.set(rowid, miss);
    }
  }
  return merged;
}

function main(): void {
  if (!fs.existsSync(POIS_DB)) { console.error(`Map DB not found: ${POIS_DB}`); process.exit(1); }
  const ledger = readLedger();
  const db = new Database(POIS_DB, { readonly: true });
  const byId = new Map<number, Row>();
  const stmt = db.prepare('SELECT rowid, name, type, lat, lon FROM pois WHERE rowid = ?');
  for (const rowid of ledger.keys()) {
    const r = stmt.get(rowid) as Row | undefined;
    if (r) byId.set(rowid, r);
  }
  db.close();

  const byWhy = new Map<string, number>();
  /** too-far whose NAMES agree — the pin-drift candidates a human must rule on. */
  const drift: Array<{ row: Row; miss: Miss }> = [];
  /** too-far whose names DON'T agree — a different branch; nothing to accept. */
  const farButDifferent: Array<{ row: Row; miss: Miss }> = [];
  let gone = 0;
  for (const [rowid, miss] of ledger) {
    byWhy.set(miss.why, (byWhy.get(miss.why) ?? 0) + 1);
    const row = byId.get(rowid);
    if (!row) { gone++; continue; } // merged or healed since the refusal
    if (miss.why !== 'too-far') continue;
    // Distance 0 asks the ONLY question that matters here: do the two names
    // describe one place, ignoring where each side's pin landed? The candidate
    // side carries Google's identity — it is a real place by construction — so
    // the containment tier (which needs exactly one identified side) is
    // available, and «Шпаркасе» ⊂ «Sparkasse Bank» counts as the same name.
    if (samePlaceName(row.name, miss.candidate, 0, false, true).same) drift.push({ row, miss });
    else farButDifferent.push({ row, miss });
  }

  console.log('=== identity backfill — refusal review (free) ===');
  console.log(`refusals on record: ${ledger.size}` + (gone ? ` (${gone} rows since merged/healed — nothing to review)` : ''));
  for (const [why, n] of [...byWhy].sort((a, b) => b[1] - a[1])) console.log(`  ${why}: ${n}`);
  console.log('');
  console.log(`to-far with the SAME name (pin-drift candidates, one search each to confirm): ${drift.length}`);
  for (const d of drift.sort((a, b) => a.row.name.localeCompare(b.row.name))) {
    console.log(`  · ${d.row.name}  (${d.row.type}, ${d.row.lat.toFixed(4)}/${d.row.lon.toFixed(4)})  ⇄  «${d.miss.candidate}»  [${d.miss.attempts} try]`);
  }
  console.log('');
  console.log(`too-far with a DIFFERENT name (do not accept — another branch): ${farButDifferent.length}`);
  for (const d of farButDifferent.slice(0, 15)) {
    console.log(`  · ${d.row.name}  ⇄  «${d.miss.candidate}»`);
  }
  if (farButDifferent.length > 15) console.log(`  … +${farButDifferent.length - 15} more`);

  if (WRITE) {
    const out = path.join(DATA, 'identity-class-review.md');
    const lines = [
      '# Identity backfill — refusal review',
      '',
      `Generated ${new Date().toISOString()} from the refusal ledger. Nothing here spends a search.`,
      '',
      `- refusals on record: **${ledger.size}**` + (gone ? ` (${gone} rows merged/healed since — ignore)` : ''),
      ...([...byWhy].sort((a, b) => b[1] - a[1]).map(([why, n]) => `- ${why}: **${n}**`)),
      '',
      `## Pin-drift candidates — names agree, distance refused (${drift.length})`,
      '',
      'One targeted search each confirms whether the map row or Google holds the wrong point.',
      '',
      '| row | type | map point | Google candidate | tries |',
      '| --- | --- | --- | --- | --- |',
      ...drift.map(d => `| ${d.row.name} | ${d.row.type} | ${d.row.lat.toFixed(5)}/${d.row.lon.toFixed(5)} | ${d.miss.candidate} | ${d.miss.attempts} |`),
      '',
      `## Do not accept — different name (${farButDifferent.length})`,
      '',
      '| row | Google candidate |',
      '| --- | --- |',
      ...farButDifferent.map(d => `| ${d.row.name} | ${d.miss.candidate} |`),
      '',
    ];
    fs.writeFileSync(out, lines.join('\n'));
    console.log(`\nreport: ${out}`);
  }
}

main();
