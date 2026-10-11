// The map DB is a BUILD ARTIFACT: any run of scripts/rebuild_map.ts regenerates
// it and, unless the overrides are re-applied, silently drops every manual fix.
// That is not theoretical — it is how the shipped map was found missing all
// five override POIs on 2026-10-11 (KAM Market, Сити Мол, Кипер Маркет,
// ТЦ Олимпико, ОУ Лазо Ангеловски). deploy_map.sh now refuses to ship such a
// map; this test is the same invariant on the CI side, so a rebuild that loses
// the fixes is caught by `npm test` instead of at production.
//
// data/address-overrides.json is the source of truth for what MUST be present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

const DB = path.join(process.cwd(), 'data', 'skopje-pois.db');
const OVERRIDES = path.join(process.cwd(), 'data', 'address-overrides.json');

interface OverrideFile {
  pois?: Array<{ name: string; type: string; lat: number; lon: number; note?: string }>;
  excluded?: Array<{ name: string; area?: string; reason: string }>;
}

/** The DB may legitimately be absent (fresh clone / CI without the artifact). */
function load(): { db: Database.Database; ov: OverrideFile } | undefined {
  if (!fs.existsSync(DB) || !fs.existsSync(OVERRIDES)) return undefined;
  return { db: new Database(DB, { readonly: true }), ov: JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')) };
}

test('every manual POI override is present in the built map', () => {
  const ctx = load();
  if (!ctx) return; // no build artifact here — nothing to assert
  const { db, ov } = ctx;
  const q = db.prepare('SELECT COUNT(*) AS n FROM pois WHERE name = ? AND lat = ? AND lon = ?');

  const missing: string[] = [];
  for (const p of ov.pois ?? []) {
    const { n } = q.get(p.name, p.lat, p.lon) as { n: number };
    if (n === 0) missing.push(`${p.name} [${p.type}] @ ${p.lat},${p.lon}`);
  }
  db.close();

  // Name the offenders, not just the count — this is the message the next
  // person reads while the map is broken.
  assert.deepEqual(
    missing,
    [],
    `manual fixes missing from ${path.relative(process.cwd(), DB)} — the DB was ` +
    `rebuilt without re-applying data/address-overrides.json.\n` +
    `  Fix: npx tsx scripts/apply_overrides.ts\n` +
    `  Missing:\n${missing.map(m => `    - ${m}`).join('\n')}`,
  );
});

test('each override is a PUBLIC, navigable place (the capture criterion)', () => {
  const ctx = load();
  if (!ctx) return;
  const { ov } = ctx;
  // A landmark fills "во близина на X" for a client being denied the address,
  // so it must be somewhere a stranger can recognise and walk to. The types
  // below are that set in practice; a bare office/company type would need a
  // deliberate decision instead of a quiet addition.
  const PUBLIC_TYPES = new Set([
    'supermarket', 'mall', 'school', 'kindergarten', 'university', 'hospital',
    'clinic', 'pharmacy', 'park', 'bank', 'hotel', 'museum', 'library',
    'stadium', 'theatre', 'cinema', 'diplomatic', 'embassy', 'government',
    'townhall', 'police', 'fire_station', 'fuel', 'bus_station', 'tram_station',
    'marketplace', 'restaurant', 'cafe', 'place_of_worship', 'church', 'mosque',
    'monument', 'artwork', 'tourist_attraction', 'post_office',
  ]);
  const nonPublic = (ov.pois ?? []).filter(p => !PUBLIC_TYPES.has(p.type)).map(p => `${p.name} [${p.type}]`);
  assert.deepEqual(
    nonPublic,
    [],
    `override entries that are not public navigable places:\n${nonPublic.map(m => `    - ${m}`).join('\n')}\n` +
    `  A landmark must be somewhere a client can find — add its type to\n` +
    `  PUBLIC_TYPES only if that is genuinely true.`,
  );
});

test('a place recorded as EXCLUDED is not silently captured', () => {
  const ctx = load();
  if (!ctx) return;
  const { db, ov } = ctx;
  // The exclusion list is a decision, not decoration: if someone later adds an
  // excluded place to `pois`, the flag on the data and the decision on file
  // must be reconciled on purpose.
  const collisions: string[] = [];
  for (const ex of ov.excluded ?? []) {
    // Exclusions are recorded by their common name (Cyrillic and/or Latin).
    const terms = ex.name.split('/').map(s => s.trim()).filter(Boolean);
    for (const t of terms) {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM pois WHERE name LIKE ?').get(`%${t}%`) as { n: number };
      if (n > 0) collisions.push(`${ex.name} — matched "${t}" (${n} row(s))`);
    }
  }
  db.close();
  assert.deepEqual(
    collisions,
    [],
    `a place listed in 'excluded' is present in the map anyway:\n${collisions.map(c => `    - ${c}`).join('\n')}\n` +
    `  Either remove it from the map, or remove it from 'excluded' and record why it is a landmark.`,
  );
});
