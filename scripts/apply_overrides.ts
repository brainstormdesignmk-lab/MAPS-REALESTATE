// Apply data/address-overrides.json into skopje-pois.db.
//
// Idempotent — safe to run repeatedly (skips rows that already exist).
// Run this after EVERY weekly OSM rebuild, otherwise the manual fixes in
// the overrides file are lost when the DB is regenerated.
//
// Sections:
//   pois      — add POIs missing from OSM
//   replaces  — delete wrong POI entries and insert corrected coords
//   addresses — individual house numbers missing from OSM
//   pinfixes  — move one row's pin, keeping its place_id/rating (a capture may
//               refine a pin, never relocate the place — see captureMayMovePin)
//   deidentify — strip a Google identity the accept rule should never have
//               welded to this row (kept here so the correction survives the
//               weekly OSM rebuild, and so the rejection is recorded next to
//               the row it is about instead of living in someone's memory)
//   aliases   — feed spelling differs from OSM spelling
//
// Usage: npx tsx scripts/apply_overrides.ts

import { readFileSync, existsSync } from 'fs';
import Database from 'better-sqlite3';
import { streetKey } from '../src/geo/offlineMap';

interface OverrideFile {
  pois?: Array<{ name: string; type: string; lat: number; lon: number; note?: string }>;
  replaces?: Array<{ name: string; type: string; lat: number; lon: number; note?: string }>;
  addresses?: Array<{ street: string; housenumber: string; lat: number; lon: number; note?: string }>;
  pinfixes?: Array<{ name: string; type?: string; lat: number; lon: number; note?: string }>;
  deidentify?: Array<{ name: string; type?: string; place_id?: string; note?: string }>;
  aliases?: Array<{ street: string; osmStreet: string; note?: string }>;
}

function main() {
  const dbPath = process.env.SKOPJE_POIS_DB ?? 'data/skopje-pois.db';
  const ov: OverrideFile = JSON.parse(readFileSync('data/address-overrides.json', 'utf8'));
  const db = new Database(dbPath); // read-write
  let added = 0, skipped = 0;

  // --- POIs -------------------------------------------------------------
  for (const p of ov.pois ?? []) {
    const exists = db.prepare(
      'SELECT COUNT(*) AS n FROM pois WHERE name = ? AND lat = ? AND lon = ?'
    ).get(p.name, p.lat, p.lon) as { n: number };
    if (exists.n > 0) { skipped++; continue; }
    db.prepare('INSERT INTO pois (name, type, lat, lon) VALUES (?, ?, ?, ?)')
      .run(p.name, p.type, p.lat, p.lon);
    console.log(`+ poi   ${p.name} [${p.type}] @ ${p.lat},${p.lon}`);
    added++;
  }

  // --- Replaces (fix wrong POI coords) ------------------------------------
  for (const r of ov.replaces ?? []) {
    // Delete ALL existing entries with this name (may be multiple wrong coords)
    const del = db.prepare('DELETE FROM pois WHERE name = ?').run(r.name);
    if (del.changes > 0) {
      console.log(`~ replace ${r.name}: deleted ${del.changes} wrong entr${del.changes === 1 ? 'y' : 'ies'}`);
    }
    // Insert the corrected entry
    db.prepare('INSERT INTO pois (name, type, lat, lon) VALUES (?, ?, ?, ?)')
      .run(r.name, r.type, r.lat, r.lon);
    console.log(`+ poi   ${r.name} [${r.type}] @ ${r.lat},${r.lon} (corrected)`);
    added++;
  }

  // --- Pin fixes (correct a row's coordinates WITHOUT losing its identity) --
  // `replaces` deletes and re-inserts, which drops the Google place_id, the
  // rating and the place card — correct for a wrong row, wrong for a row that is
  // right except for where the capture put it (the «Беверли Хилс» 847 m swing: a
  // Google record pinned at the sales office instead of the building). This
  // section moves the pin only; name, type and identity stay.
  for (const f of ov.pinfixes ?? []) {
    const where = f.type
      ? db.prepare('UPDATE pois SET lat = ?, lon = ? WHERE name = ? AND type = ?').run(f.lat, f.lon, f.name, f.type)
      : db.prepare('UPDATE pois SET lat = ?, lon = ? WHERE name = ?').run(f.lat, f.lon, f.name);
    if (where.changes === 0) {
      console.warn(`! pinfix skipped (${f.name}): no such row`);
      continue;
    }
    console.log(`~ pin   ${f.name}${f.type ? ` [${f.type}]` : ''} @ ${f.lat},${f.lon} (${where.changes} row${where.changes === 1 ? '' : 's'})${f.note ? ` — ${f.note}` : ''}`);
    added++;
  }

  // --- Deidentify (remove a witness the rule now refuses) ------------------
  // The 2026-11-23 backfill gave «Св. 40. Маченици» the identity of a Google
  // card called «Orthodox Church»: the card's name identified nothing, and the
  // denomination word was not yet in the kind list. `place_id` on a row is
  // believed by the reader (rating, reviews, closed flag), so the bad weld has
  // to be removed, not merely stopped.
  for (const d of ov.deidentify ?? []) {
    const rows = (d.type
      ? db.prepare('SELECT rowid, name FROM pois WHERE name = ? AND type = ?').all(d.name, d.type)
      : db.prepare('SELECT rowid, name FROM pois WHERE name = ?').all(d.name)) as Array<{ rowid: number; name: string }>;
    if (rows.length === 0) {
      console.warn(`! deidentify skipped (${d.name}): no such row`);
      continue;
    }
    for (const r of rows) {
      const cur = db.prepare('SELECT place_id FROM pois WHERE rowid = ?').get(r.rowid) as { place_id: string | null };
      if (!cur.place_id) { skipped++; continue; }
      if (d.place_id && cur.place_id !== d.place_id) {
        console.warn(`! deidentify skipped (${d.name}): identity is ${cur.place_id}, not the recorded ${d.place_id}`);
        continue;
      }
      // `closed` is NOT NULL DEFAULT 0 — an unstamped row is open, not unknown.
      db.prepare('UPDATE pois SET place_id = NULL, review_count = NULL, rating = NULL, closed = 0 WHERE rowid = ?').run(r.rowid);
      console.log(`~ deidentify ${d.name}: removed ${cur.place_id}${d.note ? ` — ${d.note}` : ''}`);
      added++;
    }
  }

  // --- Addresses ----------------------------------------------------------
  for (const a of ov.addresses ?? []) {
    const key = streetKey(a.street);
    const exists = db.prepare(
      'SELECT COUNT(*) AS n FROM addresses WHERE key = ? AND housenumber = ?'
    ).get(key, a.housenumber) as { n: number };
    if (exists.n > 0) { skipped++; continue; }
    db.prepare('INSERT INTO addresses (street, housenumber, lat, lon, key) VALUES (?, ?, ?, ?, ?)')
      .run(a.street, a.housenumber, a.lat, a.lon, key);
    console.log(`+ addr  ${a.street} ${a.housenumber} → ${a.lat},${a.lon}`);
    added++;
  }

  // --- Aliases ------------------------------------------------------------
  for (const al of ov.aliases ?? []) {
    const srcKey = streetKey(al.osmStreet);
    const dstKey = streetKey(al.street);
    if (!srcKey || !dstKey || srcKey === dstKey) {
      console.warn(`! alias skipped (${al.street}): bad keys "${srcKey}" vs "${dstKey}"`);
      continue;
    }
    const srcRows = db.prepare(
      'SELECT street, housenumber, lat, lon FROM addresses WHERE key = ?'
    ).all(srcKey) as Array<{ street: string; housenumber: string; lat: number; lon: number }>;
    if (srcRows.length === 0) {
      console.warn(`! alias skipped (${al.street}): source street "${al.osmStreet}" not in DB`);
      continue;
    }
    let aliasAdded = 0;
    for (const r of srcRows) {
      const exists = db.prepare(
        'SELECT COUNT(*) AS n FROM addresses WHERE key = ? AND housenumber = ?'
      ).get(dstKey, r.housenumber) as { n: number };
      if (exists.n > 0) { skipped++; continue; }
      db.prepare('INSERT INTO addresses (street, housenumber, lat, lon, key) VALUES (?, ?, ?, ?, ?)')
        .run(r.street, r.housenumber, r.lat, r.lon, dstKey);
      aliasAdded++; added++;
    }
    if (aliasAdded > 0) console.log(`+ alias "${al.street}" ← ${aliasAdded} rows from "${al.osmStreet}"`);
  }

  // --- Name-variant exceptions -------------------------------------------
  // data/name-variants.json holds the pairs the place-name SOUND KEY cannot
  // see (translations and irregulars — spelling variants need no table). The
  // engine loads this table on open (OfflineMapStore → loadNameVariants), so
  // it must be rewritten after EVERY rebuild, like the overrides above.
  const variantsPath = 'data/name-variants.json';
  if (existsSync(variantsPath)) {
    const vf = JSON.parse(readFileSync(variantsPath, 'utf8')) as {
      variants?: Array<{ from: string; to: string; reviewed?: boolean }>;
    };
    db.exec('CREATE TABLE IF NOT EXISTS name_variants (word TEXT PRIMARY KEY, canonical TEXT NOT NULL)');
    db.prepare('DELETE FROM name_variants').run();
    let applied = 0;
    const ins = db.prepare('INSERT OR REPLACE INTO name_variants (word, canonical) VALUES (?, ?)');
    for (const v of vf.variants ?? []) {
      if (!v.reviewed || !v.from || !v.to) continue;
      ins.run(v.from, v.to);
      applied++;
    }
    console.log(`+ variants: ${applied} reviewed pair(s) loaded`);
  }

  console.log(`\nApplied: ${added} added, ${skipped} already present. Done.`);
  db.close();
}
main();
