/**
 * strip-blind-fusions — PHASE B2b of the map build (runs after identityHeal).
 *
 * The EARLY healing pass (before any name agreement existed) stamped Google
 * place_ids onto OSM rows by identical coordinates alone. That fused
 * different physical places sharing one building footprint:
 *   Беверли Хилс (mall)  ← TTK Banka's identity   (bank inside the complex)
 *   Зебра (shop)         ← Tinex's identity
 *   DM (shop)            ← KAM Market's identity
 *   Жито / Хотел 7       ← Hotel „7“ / Viola Vodno's identities
 * 361 rows total. Runtime dedupe then treats "same place_id = same place"
 * and DELETES the OSM row in favor of the Google anchor — Beverly Hills
 * could never appear in the rotation again.
 *
 * THE RULE (pure data, no overrides): an OSM row may carry a Google
 * place_id only when the anchor's name AGREES with the row's name
 * (transliteration tier within 60m, or semantic/translation tier within
 * 120m — same thresholds as the guarded heal). Rows whose anchor name
 * disagrees lose the identity (place_id → NULL) and re-enter the normal
 * guarded heal, which can still find their TRUE anchor by name.
 *
 * Idempotent: after a clean pass, zero rows disagree.
 */
import type Database from 'better-sqlite3';
import { distM } from '../src/geo/precision';
import { nameMergeKeys, semanticNameKey } from '../src/geo/offlineMap';
import { countriesIn, countryContradiction } from './identity-heal';

const EXACT_RADIUS = 60;      // same translit key
const SEMANTIC_RADIUS = 120;  // same semantic (translated) key

export function stripBlindFusions(db: Database.Database): { stripped: number; kept: number } {
  console.log('PHASE B2b: strip blind coordinate fusions (name must agree)');

  const anchorByPid = new Map<string, { name: string; lat: number; lon: number }>();
  for (const a of db.prepare(
    `SELECT name, lat, lon, place_id FROM pois WHERE source='google' AND place_id IS NOT NULL AND place_id != ''`
  ).all() as Array<{ name: string; lat: number; lon: number; place_id: string }>) {
    if (!anchorByPid.has(a.place_id)) anchorByPid.set(a.place_id, a);
  }

  const rows = db.prepare(
    `SELECT rowid, name, lat, lon, place_id FROM pois
     WHERE source='osm' AND place_id IS NOT NULL AND place_id != ''`
  ).all() as Array<{ rowid: number; name: string; lat: number; lon: number; place_id: string }>;

  const strip = db.prepare(`UPDATE pois SET place_id = NULL WHERE rowid = ?`);
  let stripped = 0, kept = 0;

  for (const r of rows) {
    const a = anchorByPid.get(r.place_id);
    if (!a) { kept++; continue; } // anchor row gone; identity unverifiable → keep
    const d = distM(r.lat, r.lon, a.lat, a.lon);
    const rKeys = nameMergeKeys(r.name);
    const aKeys = nameMergeKeys(a.name);
    const sameTranslit = aKeys.includes(rKeys[0]);
    const sameSemantic = rKeys.length > 1 && aKeys.includes(rKeys[1]);
    if ((sameTranslit && d <= EXACT_RADIUS) || (sameSemantic && d <= SEMANTIC_RADIUS)) {
      kept++;
      continue;
    }
    // Tier-3 evidence, same as the guarded heal: an EMBASSY row and an
    // anchor embassy naming the SAME country at any distance are one
    // institution ("Амбасада на Германија" ↔ "Embassy of the Federal
    // Republic of Germany", d=0 but different adjective forms). Contradiction
    // still rejects (Британска амбасада ≠ French Embassy).
    const rIsEmbassy = /\bembassy\b|ambasada|ambasadi/.test(semanticNameKey(r.name) + ' ' + r.name);
    const aIsEmbassy = /\bembassy\b|ambasada|ambasadi/.test(semanticNameKey(a.name) + ' ' + a.name);
    if (rIsEmbassy && aIsEmbassy && !countryContradiction(r.name, a.name)
        && countriesIn(r.name).size > 0) {
      kept++;
      continue;
    }
    strip.run(r.rowid);
    stripped++;
  }

  console.log(`  Kept ${kept} name-agreed identities; stripped ${stripped} blind fusions`);
  return { stripped, kept };
}
