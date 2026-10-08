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
//   aliases   — feed spelling differs from OSM spelling
//
// Usage: npx tsx scripts/apply_overrides.ts

import { readFileSync } from 'fs';
import Database from 'better-sqlite3';
import { streetKey } from '../src/geo/offlineMap';

interface OverrideFile {
  pois?: Array<{ name: string; type: string; lat: number; lon: number; note?: string }>;
  replaces?: Array<{ name: string; type: string; lat: number; lon: number; note?: string }>;
  addresses?: Array<{ street: string; housenumber: string; lat: number; lon: number; note?: string }>;
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

  console.log(`\nApplied: ${added} added, ${skipped} already present. Done.`);
  db.close();
}
main();
