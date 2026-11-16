// HARVEST SPELLING VARIANT EXCEPTIONS — and measure the coverage of the sound
// key over the whole map.
//
// The general reconciler is `soundKey()` (src/geo/offlineMap.ts): it folds
// „City“/„Siti“/„сити“ and „mall“/„mol“/„мол“ onto one skeleton without any
// dictionary. Some pairs are not spelling variants at all but TRANSLATIONS
// („ТЦ Бисер“ / „Biser Shopping Center“, „Општина“ / „Municipality“), and those
// the skeleton cannot see. This script finds exactly those, and writes only the
// well-evidenced ones:
//
//   • two rows ≤ 60 m apart, one Cyrillic-only, one Latin-only, same category;
//   • their word sets must NOT already unify under the sound key;
//   • the two names must otherwise agree word-for-word (all but ONE word on
//     each side matches), OR the same word pair must repeat across ≥2 such
//     pairs — so a random neighbour on the corner is never mistaken for a
//     translation of the other;
//   • reviewed:true is written only for the "everything else agrees" case;
//     repeated-but-unexplained pairs stay suggestions for a human.
//
// Output: data/name-variants.json → applied by scripts/apply_overrides.ts into
// the name_variants table → loaded by OfflineMapStore.
//
// Usage: npx tsx scripts/harvest-name-variants.ts [--write]

import { readFileSync, writeFileSync, existsSync } from 'fs';
import Database from 'better-sqlite3';
import { canonicalWordKey, LANDMARK_RANKING_POLICY_VERSION } from '../src/geo/offlineMap';
import { distM } from '../src/geo/precision';
import { typeRank } from '../src/geo/types';

const DB = process.env.SKOPJE_POIS_DB ?? 'data/skopje-pois.db';
const OUT = 'data/name-variants.json';
const MAX_M = 60;
const CYR = /[\u0400-\u04FF]/;

interface Row { name: string; type: string; lat: number; lon: number }
interface Variant { from: string; to: string; reviewed: boolean; support?: number; evidence?: string[] }
interface VariantFile { _readme?: string[]; policy_version?: number; variants: Variant[] }

const words = (name: string): string[] =>
  [...new Set(name.split(/[^0-9\p{L}]+/u).filter(w => w.length >= 3))];

function categoryClass(name: string): string {
  const k = name.toLowerCase();
  if (/болниц|bolnic|клиник|klinik|амбулант|ambulant/.test(k)) return 'medical';
  if (/цркв|crkv|манастир|manastir|џамиј|dzamij|катедрал|katedral/.test(k)) return 'worship';
  if (/училишт|ucilist|гимназиј|gimnazij|факултет|fakultet|универзит|univerz/.test(k)) return 'education';
  if (/мол\b|mall|пазар|pazar|маркет|market|тргов|trgov/.test(k)) return 'retail';
  if (/парк|park/.test(k)) return 'park';
  return 'other';
}

function main(): void {
  const write = process.argv.includes('--write');
  const db = new Database(DB, { readonly: true });
  const rows = db.prepare('SELECT name, type, lat, lon FROM pois').all() as Row[];
  db.close();

  const cyr = rows.filter(r => CYR.test(r.name) && !/[A-Za-z]/.test(r.name) && typeRank(r.type) > 0);
  const lat = rows.filter(r => /[A-Za-z]/.test(r.name) && !CYR.test(r.name) && typeRank(r.type) > 0);

  let compared = 0, unified = 0;
  const strong: Variant[] = [];
  const repeated = new Map<string, Variant>();

  for (const c of cyr) {
    for (const l of lat) {
      if (distM(c.lat, c.lon, l.lat, l.lon) > MAX_M) continue;
      if (categoryClass(c.name) !== categoryClass(l.name)) continue;
      compared++;
      const cw = words(c.name);
      const lw = words(l.name);
      const ck = cw.map(canonicalWordKey);
      const lk = lw.map(canonicalWordKey);
      if (ck.some(k => lk.includes(k))) { unified++; continue; }
      // Unmatched words on each side. A pair only QUALIFIES when the two names
      // are multiword, MOSTLY the same words, and differ in exactly one word on
      // each side — that is a translation of one element („Општина Кисела
      // Вода“ / „Kisela Voda Municipality“). Two one-word names that share
      // nothing are two different businesses on the same corner („Хотел 7“ /
      // „Betty“), which is exactly the mistake a careless harvest makes.
      const cRest = ck.filter(k => !lk.includes(k));
      const lRest = lk.filter(k => !ck.includes(k));
      const matched = ck.filter(k => lk.includes(k)).length;
      const evidence = `${c.name} / ${l.name}`;
      const qualifies = matched >= 1 && cRest.length === 1 && lRest.length === 1
        && ck.length >= 2 && lk.length >= 2
        && matched >= Math.min(ck.length, lk.length) - 1;
      if (!qualifies) continue;
      if (matched >= Math.min(ck.length, lk.length)) {
        strong.push({ from: cRest[0], to: lRest[0], reviewed: true, support: 1, evidence: [evidence] });
      } else {
        const key = `${cRest[0]}→${lRest[0]}`;
        const e = repeated.get(key) ?? { from: cRest[0], to: lRest[0], reviewed: false, support: 0, evidence: [] };
        e.support = (e.support ?? 0) + 1;
        if (e.evidence!.length < 3) e.evidence!.push(evidence);
        repeated.set(key, e);
      }
    }
  }

  const existing: VariantFile = existsSync(OUT)
    ? JSON.parse(readFileSync(OUT, 'utf8')) as VariantFile
    : { variants: [] };
  const known = new Set(existing.variants.map(v => `${v.from}→${v.to}`));
  const fresh = [
    ...strong,
    ...[...repeated.values()].filter(v => (v.support ?? 0) >= 2 && !known.has(`${v.from}→${v.to}`)),
  ].filter(v => !known.has(`${v.from}→${v.to}`));

  const out: VariantFile = {
    _readme: [
      'EXCEPTION pairs for the place-name sound key (src/geo/offlineMap.ts →',
      'soundKey / canonicalWordKey / loadNameVariants).',
      'The sound key already unifies SPELLING variants (city/siti/сити,',
      'mall/mol/мол, Kipper/Kiper) without any table. Only TRANSLATIONS and',
      'irregulars belong here.',
      'Generated by scripts/harvest-name-variants.ts from the map itself;',
      'reviewed:true pairs are applied at build via scripts/apply_overrides.ts,',
      'reviewed:false are suggestions. Never put a whole PLACE alias here —',
      'that is data/address-overrides.json.',
    ],
    policy_version: LANDMARK_RANKING_POLICY_VERSION,
    variants: [...existing.variants.filter(v => v.reviewed), ...fresh],
  };

  const reviewed = out.variants.filter(v => v.reviewed).length;
  console.log(`cyrillic rows ${cyr.length} · latin rows ${lat.length}`);
  console.log(`co-located pairs compared ${compared} · already unified by the sound key ${unified} (${compared ? Math.round(unified / compared * 100) : 0}%)`);
  console.log(`exceptions: reviewed ${reviewed}, suggestions ${out.variants.length - reviewed}`);
  for (const v of fresh.slice(0, 20)) console.log(`  ${v.reviewed ? '✓' : '?'} ${v.from} → ${v.to} (${v.support})  ${v.evidence?.[0] ?? ''}`);
  if (write) {
    writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
    console.log(`written ${OUT}`);
  }
}

main();
