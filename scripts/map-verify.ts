#!/usr/bin/env tsx
/**
 * map-verify.ts — IS THIS THE REAL MAP? One command, one verdict.
 *
 * WHY: the map now lives in git (data/skopje-pois.db is tracked, so a coder who
 * needs it can clone and go). That only helps if "the map I have" is provable.
 * This checkout has already produced two junk copies that looked real enough to
 * be picked up by a resolver, and a third-party coder has no way to tell a
 * shipped map from a test fixture, an empty file, or a half-written WAL copy.
 *
 * The file therefore answers for itself: a `meta` table stamped at build time
 * carries the version, the row counts and the geo stamp, so a detached copy of
 * the DB — copied to a laptop, a vault, a USB stick — still says what it is.
 *
 * Usage:
 *   npx tsx scripts/map-verify.ts            # verify: structure, counts, sha, stamp
 *   npx tsx scripts/map-verify.ts --stamp    # write the meta stamp + full sha256
 *
 * Exit: 0 = this is a real, shippable map. 1 = it is not. 2 = no map resolved.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

const REPO_ROOT = path.resolve(__dirname, '..');

interface Resolved {
  file: string;
  /** How the path was decided — printed, so nobody has to guess which map. */
  rule: string;
}

/** The same two rules the geo engine uses: SKOPJE_POIS_DB, else this repo. */
function resolveMapDb(): Resolved {
  const raw = (process.env.SKOPJE_POIS_DB ?? '').trim();
  if (raw) return { file: path.resolve(raw), rule: 'SKOPJE_POIS_DB' };
  return { file: path.join(REPO_ROOT, 'data', 'skopje-pois.db'), rule: 'repo default' };
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function count(db: Database.Database, sql: string): number | null {
  try {
    return (db.prepare(sql).get() as { c: number }).c;
  } catch {
    return null; // older/newer schema — reported as n/a, never as zero
  }
}

function main(): number {
  const stamp = process.argv.includes('--stamp');
  const { file, rule } = resolveMapDb();

  if (!fs.existsSync(file)) {
    console.error(`✗ no map at ${file} (resolved by: ${rule})`);
    console.error('  Set SKOPJE_POIS_DB, or run this from the checkout that owns the map.');
    return 2;
  }

  let db: Database.Database;
  try {
    db = new Database(file);
  } catch (e) {
    console.error(`✗ cannot open ${file}: ${(e as Error).message}`);
    return 1;
  }

  const problems: string[] = [];
  const integrity = (() => {
    try { return (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check; } catch { return 'unreadable'; }
  })();

  const pois = count(db, 'SELECT COUNT(*) c FROM pois');
  const osm = count(db, "SELECT COUNT(*) c FROM pois WHERE source='osm'");
  const google = count(db, "SELECT COUNT(*) c FROM pois WHERE source='google'");
  const addresses = count(db, 'SELECT COUNT(*) c FROM addresses');
  const ledger = count(db, 'SELECT COUNT(*) c FROM tile_scans');
  const dupPlaceIds = count(db, 'SELECT COUNT(*) c FROM (SELECT place_id FROM pois WHERE place_id IS NOT NULL GROUP BY place_id HAVING COUNT(*)>1)');

  // ── the invariants of a REAL map (the same ones the run's VERIFY asserts) ──
  if (integrity !== 'ok') problems.push(`integrity_check = ${integrity}`);
  if (pois === null) problems.push('no `pois` table — this is not a map DB');
  else if (pois < 1000) problems.push(`only ${pois} POIs — the wrong-map signature (a real map has thousands)`);
  if (addresses === null) problems.push('no `addresses` table — landmark resolution needs it');
  if (dupPlaceIds !== null && dupPlaceIds > 0) problems.push(`${dupPlaceIds} duplicated place_id — the merge (B2) did not run`);

  if (stamp) {
    if (problems.length > 0) {
      console.error('✗ refusing to stamp a DB that is not a valid map:');
      for (const p of problems) console.error(`  - ${p}`);
      db.close();
      return 1;
    }
    // A WAL pair means the bytes on disk are not the whole database; checkpoint
    // first or the sha256 (and the copy someone commits) can be half a transaction.
    db.pragma('wal_checkpoint(TRUNCATE)');
    const geo = (() => {
      try {
        const txt = fs.readFileSync(path.join(REPO_ROOT, 'GEO_VERSION.txt'), 'utf8');
        const one = crypto.createHash('md5').update(txt).digest('hex');
        return one.slice(0, 12);
      } catch { return 'unstamped'; }
    })();
    const version = `map-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`;
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const put = db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    const rows: Array<[string, string]> = [
      ['map_version', version],
      ['stamped_at', new Date().toISOString()],
      ['pois', String(pois)],
      ['pois_osm', String(osm)],
      ['pois_google', String(google)],
      ['addresses', String(addresses)],
      ['tile_scans', String(ledger)],
      ['geo_version_hash', geo],
      ['source', 'maps-realestate (the authority)'],
    ];
    const tx = db.transaction(() => { for (const [k, v] of rows) put.run(k, v); });
    tx();
    db.pragma('wal_checkpoint(TRUNCATE)');
  }

  const meta = (() => {
    try {
      const rows = db.prepare('SELECT key,value FROM meta ORDER BY key').all() as Array<{ key: string; value: string }>;
      return rows.length ? Object.fromEntries(rows.map(r => [r.key, r.value])) : undefined;
    } catch {
      return undefined;
    }
  })();

  db.close();

  const bytes = fs.statSync(file).size;
  const sum = sha256(file);
  const sidecarPath = file + '.sha256';
  let sidecar: string | undefined;
  try {
    sidecar = fs.readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0];
  } catch { /* no sidecar — reported below */ }

  console.log(`map        : ${file}`);
  console.log(`resolved   : ${rule}`);
  console.log(`bytes      : ${bytes.toLocaleString('en-US')}`);
  console.log(`sha256     : ${sum}`);
  console.log(`integrity  : ${integrity}`);
  console.log(`pois       : ${pois} (osm ${osm ?? 'n/a'} · google ${google ?? 'n/a'})`);
  console.log(`addresses  : ${addresses ?? 'n/a'}`);
  console.log(`ledger     : ${ledger ?? 'n/a'} pair(s)`);
  console.log(`dup place  : ${dupPlaceIds ?? 'n/a'}`);
  if (meta) {
    console.log('stamp      :');
    for (const k of Object.keys(meta)) console.log(`  ${k} = ${meta[k]}`);
  } else {
    console.log('stamp      : none — this DB was never stamped (run: npx tsx scripts/map-verify.ts --stamp)');
  }

  if (stamp) {
    fs.writeFileSync(sidecarPath, `${sum}  ${path.basename(file)}\n`);
    console.log(`\n✓ stamped ${meta!.map_version} and wrote ${path.basename(sidecarPath)}`);
    // Re-folding the stamp changes the bytes, so the printed sha above is from
    // BEFORE the write. Print the final one so a commit message can carry it.
    console.log(`  sha256 after stamp: ${sha256(file)}`);
    return 0;
  }

  if (sidecar && sidecar !== sum) {
    problems.push(`sha256 does not match ${path.basename(sidecarPath)} (file ${sum.slice(0, 12)}… vs sidecar ${sidecar.slice(0, 12)}…) — this file was modified after it was stamped`);
  }

  if (problems.length > 0) {
    console.error('\n✗ NOT A SHIPPABLE MAP:');
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log('\n✓ this is the authoritative map');
  return 0;
}

process.exit(main());
