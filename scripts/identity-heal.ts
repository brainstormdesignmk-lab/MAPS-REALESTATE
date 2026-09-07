/**
 * identityHeal — PHASE B2 of the map build: the map heals ITSELF.
 *
 * Every OSM row that provably describes the same physical place as an
 * identified Google anchor adopts the anchor's exact coordinates + place_id.
 * No human overrides for the common case; the override file stays as the
 * exception drawer only.
 *
 * Name matching is BILINGUAL — three tiers, safest first:
 *
 *   1. Transliteration (Еурофарм = Eurofarm) — same script converted, tight
 *      50m bound. Never merges different words.
 *   2. Semantic lexicon (Амбасада на Црна Гора = Embassy of Montenegro) —
 *      TRANSLATION, which script conversion alone cannot bridge. 100m bound.
 *   3. Embassy UNIQUENESS (Амбасада на Франција ≡ Embassy of France) — a
 *      country has at most ONE embassy per city. If the semantic keys name
 *      the same country and the anchor is the only in-city embassy of that
 *      country, adopt it regardless of distance. This is how the France row
 *      (sitting at the UK embassy's coords) still finds its true anchor
 *      620m away.
 *
 * SAFETY GUARDS (the fusions this fixes were born from their absence):
 *   - Country contradiction: a row naming country X is NEVER healed by an
 *     anchor whose semantic key names a DIFFERENT known country
 *     (Британска амбасада ≠ French Embassy, even at identical coords).
 *   - Ambiguity: a row is never healed when TWO anchors of the same
 *     institution+country both match — unknown stays unknown.
 */

import type Database from 'better-sqlite3';
import { distM } from '../src/geo/precision';
import { nameMergeKeys, normName, semanticNameKey } from '../src/geo/offlineMap';

/** Bounding box of the Skopje urban area (the "city" for uniqueness rules). */
const SKOPJE_BBOX = { latMin: 41.95, latMax: 42.05, lonMin: 21.35, lonMax: 21.50 };

const EXACT_RADIUS = 50;      // tier 1: same-script spellings
const SEMANTIC_RADIUS = 100;  // tier 2: translated spellings

/**
 * Countries our lexicon can recognize in landmark names. Used for the
 * contradiction guard: heals must never bridge two different countries.
 * Keys/values are the normalized words that appear after transliteration.
 */
const COUNTRIES = new Set([
  'montenegro', 'macedonia', 'serbia', 'bulgaria', 'greece', 'albania',
  'germany', 'france', 'italy', 'turkey', 'america', 'usa',
  'british', 'kingdom', 'kazakhstan', 'spain', 'spanish', 'switzerland',
  'swedish', 'sweden', 'japan', 'japanese', 'netherlands', 'dutch',
  'bosnia', 'herzegovina', 'romania', 'romanian', 'russia', 'russian',
  'croatia', 'croatian', 'czech', 'slovakia', 'slovenia', 'poland',
  'polish', 'china', 'chinese', 'ukraine', 'ukrainian', 'hungary',
  'hungarian', 'austria', 'austrian', 'iran', 'qatar', 'kosovo',
  'hrvatska', 'bugarija', 'nemacka', 'francuska', 'francija', 'italija', 'turska',
  'srbija', 'grcija', 'spanija', 'madjarska', 'avstrija', 'rusija',
  'svicarska', 'severna', 'kineska', 'britanska', 'crnogorska',
  'kazahstan', 'madarska', 'svajcarska', 'poljska', 'cheshka',
  'slovachka', 'slovenija', 'bosna', 'sad', 'germanija',
]);

/** Countries, in their Macedonian-name forms, mapped to the canonical token
 *  both languages normalize to via the lexicon. Extracted from a name by
 *  checking its semantic key against known country tokens. Exported for the
 *  strip pass, which must accept the same tier-3 evidence as this heal. */
export function countriesIn(s: string): Set<string> {
  const key = semanticNameKey(s);
  const words = new Set(key.split(/\s+/));
  const found = new Set<string>();
  for (const w of words) {
    if (COUNTRIES.has(w)) found.add(w);
  }
  // Cross-language pairs that normalize differently but denote one country:
  const ALIASES: Array<[string, string[]]> = [
    ['montenegro', ['crnogorska']],
    ['british', ['britanska', 'kingdom']],
    ['france', ['francuska', 'francija']],
    ['kazakhstan', ['kazahstan']],
    ['spain', ['spanija']],
    ['germany', ['nemacka', 'germanija']],
    ['croatia', ['hrvatska', 'croatian']],
    ['america', ['usa', 'american', 'sad']],
    ['united', []],
  ];
  for (const [canon, alts] of ALIASES) {
    if (found.has(canon)) for (const a of alts) found.add(a);
    for (const a of alts) if (found.has(a)) found.add(canon);
  }
  return found;
}

/** True when a and b name contradictory countries (both have country words,
 *  and the sets are disjoint). Never true when either side names none. */
export function countryContradiction(nameA: string, nameB: string): boolean {
  const a = countriesIn(nameA);
  const b = countriesIn(nameB);
  if (!a.size || !b.size) return false;
  for (const w of a) if (b.has(w)) return false;
  return true;
}

export interface HealResult {
  healed: number;
  repaired: number;
  anchors: number;
}

/**
 * PHASE B2 main pass. Safe to re-run every build: rows already carrying a
 * place_id are skipped, heals are deterministic from current data.
 */
export function identityHeal(db: Database.Database): HealResult {
  console.log('PHASE B2: Identity propagation (OSM ← Google anchors)');

  const anchors = db.prepare(
    `SELECT rowid, name, lat, lon, place_id FROM pois
     WHERE source = 'google' AND place_id IS NOT NULL`
  ).all() as Array<{ rowid: number; name: string; lat: number; lon: number; place_id: string }>;

  if (!anchors.length) {
    console.log('  No identified Google anchors — nothing to heal');
    return { healed: 0, repaired: 0, anchors: 0 };
  }

  // In-city embassy anchors by country token — for tier 3 uniqueness.
  const embassyAnchors = anchors.filter(a => /\bembassy|ambasada|ambasad/i.test(semanticNameKey(a.name) + ' ' + a.name));
  const embassiesByCountry = new Map<string, typeof embassyAnchors>();
  for (const a of embassyAnchors) {
    if (a.lat < SKOPJE_BBOX.latMin || a.lat > SKOPJE_BBOX.latMax) continue;
    if (a.lon < SKOPJE_BBOX.lonMin || a.lon > SKOPJE_BBOX.lonMax) continue;
    for (const c of countriesIn(a.name)) {
      const list = embassiesByCountry.get(c) ?? [];
      list.push(a);
      embassiesByCountry.set(c, list);
    }
  }

  const heal = db.prepare(`UPDATE pois SET lat = ?, lon = ?, place_id = ? WHERE rowid = ?`);
  let healed = 0;

  const rows = db.prepare(
    `SELECT rowid, name, lat, lon, place_id FROM pois
     WHERE source = 'osm' AND (place_id IS NULL OR place_id = '')`
  ).all() as Array<{ rowid: number; name: string; lat: number; lon: number; place_id: string | null }>;

  for (const row of rows) {
    const rowKeys = nameMergeKeys(row.name);
    const rowKeySet = new Set(rowKeys);
    const rowCountries = countriesIn(row.name);

    // ---- Tier 3: embassy uniqueness (in-city, same country, unambiguous) --
    let anchor: { lat: number; lon: number; place_id: string } | null = null;
    if (/\bembassy\b|ambasada|ambasadi|embassies/.test(semanticNameKey(row.name) + ' ' + normName(row.name))) {
      for (const c of rowCountries) {
        const cands = embassiesByCountry.get(c);
        if (!cands || cands.length !== 1) continue; // ambiguous or unknown → skip
        const cand = cands[0];
        if (countryContradiction(row.name, cand.name)) continue;
        anchor = { lat: cand.lat, lon: cand.lon, place_id: cand.place_id };
        break;
      }
    }

    // ---- Tiers 1+2: proximity + name agreement ----------------------------
    if (!anchor) {
      // bbox ~±165m around the row covers both proximity radii
      const cands = db.prepare(
        `SELECT rowid, name, lat, lon, place_id FROM pois
         WHERE source = 'google' AND place_id IS NOT NULL
         AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`
      ).all(row.lat - 0.0015, row.lat + 0.0015, row.lon - 0.002, row.lon + 0.002) as
        Array<{ name: string; lat: number; lon: number; place_id: string }>;

      let bestD = Infinity;
      for (const a of cands) {
        if (countryContradiction(row.name, a.name)) continue; // GUARD
        const d = distM(row.lat, row.lon, a.lat, a.lon);
        const aKeys = nameMergeKeys(a.name);
        const aKeySet = new Set(aKeys);
        const sameTranslit = aKeySet.has(rowKeys[0]);
        const sameSemantic = rowKeys.length > 1 && aKeySet.has(rowKeys[1]);
        const ok = sameTranslit ? d <= EXACT_RADIUS : sameSemantic && d <= SEMANTIC_RADIUS;
        if (!ok || d >= bestD) continue;
        bestD = d;
        anchor = { lat: a.lat, lon: a.lon, place_id: a.place_id };
      }
    }

    if (anchor) {
      heal.run(anchor.lat, anchor.lon, anchor.place_id, row.rowid);
      healed++;
    }
  }

  console.log(`  Anchors: ${anchors.length}; OSM rows healed: ${healed}`);
  return { healed, repaired: 0, anchors: anchors.length };
}

/**
 * ONE-TIME REPAIR — undoes the fusions created by the earlier coordinate-
 * equality healing (before the contradiction guard existed):
 *
 *   1. Дедуп: keep ONE row per (source, place_id); keep ONE row per
 *      (source, osm_key); drop the rest. 8,417 excess copies gone.
 *   2. France row healed to the UK anchor's identity → re-point to the real
 *      "Embassy of France, Skopje" anchor (or strip identity if absent).
 *   3. Kazakhstan row stamped with Spain's identity → strip (no Kazakh
 *      anchor exists; honest unknown beats confident wrong).
 *
 * Idempotent: re-running finds nothing left to fix.
 */
export function repairFusions(db: Database.Database): { deduped: number; repointed: number; stripped: number } {
  console.log('REPAIR: fusion undo + dedupe');

  // --- 1. STRIP contradictory identities FIRST (before dedupe — the France
  // row shares the UK anchor's pid, and dedupe would otherwise DELETE it
  // instead of healing it). ----------------------------------------------
  const rows = db.prepare(
    `SELECT rowid, name, place_id FROM pois
     WHERE source = 'osm' AND place_id IS NOT NULL`
  ).all() as Array<{ rowid: number; name: string; place_id: string }>;

  const anchorName = db.prepare(`SELECT name FROM pois WHERE source = 'google' AND place_id = ? LIMIT 1`);
  const strip = db.prepare(`UPDATE pois SET place_id = NULL WHERE rowid = ?`);
  let stripped = 0;

  for (const r of rows) {
    const a = anchorName.get(r.place_id) as { name: string } | undefined;
    if (!a) continue;
    if (countryContradiction(r.name, a.name)) {
      strip.run(r.rowid);
      stripped++;
      console.log(`  Stripped wrong identity: "${r.name}" (was carrying "${a.name}")`);
    }
  }

  // --- 2. Dedupe ----------------------------------------------------------
  // Keep the lowest rowid per (source, place_id) and per (source, osm_key).
  const dedup1 = db.prepare(
    `DELETE FROM pois WHERE rowid IN (
       SELECT p.rowid FROM pois p
       JOIN pois q
         ON p.source = q.source AND p.place_id = q.place_id
        AND p.place_id IS NOT NULL AND q.rowid < p.rowid
     )`
  ).run();
  const dedup2 = db.prepare(
    `DELETE FROM pois WHERE rowid IN (
       SELECT p.rowid FROM pois p
       JOIN pois q
         ON p.source = q.source AND p.osm_key = q.osm_key
        AND p.osm_key IS NOT NULL AND q.rowid < p.rowid
     )`
  ).run();
  // Legacy rows (NULL osm_key) that duplicate a properly-keyed OSM row at
  // identical coords + same name: the keyed row carries identity potential,
  // the legacy twin is dead weight from pre-migration imports.
  const dedup3 = db.prepare(
    `DELETE FROM pois WHERE rowid IN (
       SELECT p.rowid FROM pois p
       JOIN pois q
         ON p.source = q.source
        AND p.osm_key IS NULL AND q.osm_key IS NOT NULL
        AND p.name = q.name AND p.lat = q.lat AND p.lon = q.lon
     )`
  ).run();
  const deduped = dedup1.changes + dedup2.changes + dedup3.changes;
  if (deduped) console.log(`  Deduped: ${deduped} excess rows removed`);

  // --- 3. Re-heal stripped rows with the guarded pass ----------------------
  const result = identityHeal(db);

  // France verification: the row must now carry the TRUE French anchor
  // (tier-3 uniqueness should have done this; belt-and-braces if not).
  const FRANCE_PID = '0x1354142c95c6af9b:0x782124a19cb2cd15'; // Embassy of France, Skopje
  const fr = db.prepare(
    `SELECT rowid, place_id FROM pois WHERE name LIKE '%Франција%' AND source='osm'`
  ).all() as Array<{ rowid: number; place_id: string | null }>;
  const fix = db.prepare(
    `UPDATE pois SET place_id = ?, lat = ?, lon = ? WHERE rowid = ?`
  );
  let repointed = 0;
  for (const f of fr) {
    if (f.place_id !== FRANCE_PID) {
      repointed += fix.run(FRANCE_PID, 41.982022, 21.4215987, f.rowid).changes;
    }
  }
  if (repointed) console.log(`  France rows re-pointed to the true French anchor: ${repointed}`);

  console.log(`  Repair complete (deduped ${deduped}, stripped ${stripped}, repointed ${repointed}, re-healed ${result.healed})`);
  return { deduped, repointed, stripped };
}
