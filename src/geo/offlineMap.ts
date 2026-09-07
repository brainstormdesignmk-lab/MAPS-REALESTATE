// OfflineMapStore — the local OSM engine for the Hermes machine (T60 plan).
//
// The resolver used to hit live Nominatim + Overpass per property (rate limits,
// 429s, uptime). Instead we download Skopje's NAMED POIs + address rows ONCE
// (and refresh weekly, Sunday 03:17) into a small SQLite DB:
//   data/skopje-pois.db   (~3-8 MB — a few tens of thousands of rows)
//
//   - nearestPois(lat, lon)   — bbox prefilter + haversine, ms-fast, the
//                               100m…1000m rings are just the distances.
//   - geocodeAddress(street)  — local address→coordinates (Latin↔Cyrillic
//                               street matching); live Nominatim only as fallback.
//
// The DB is opened READ-ONLY by consumers; the weekly build writes a temp file
// and atomically renames it, so a failed pull never leaves a half-written map.
// No map file yet → `available` is false and callers fall back to live APIs.

import '../compat/node16';

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from 'fs';
import { distM } from './precision';
import { normType, typeRank } from './types';

/** Skopje metro bbox (south, west, north, east) — Центар, Карпош, Аеродром,
 *  Кисела Вода, Влае, Ѓорче Петров, Чаир, Бутел, Гази Баба. */
export const SKOPJE_BBOX: [number, number, number, number] = [41.95, 21.25, 42.10, 21.55];

/** Public Overpass mirrors — the build tries them in order (they are flaky —
 *  that is exactly why we go offline). */
const OVERPASS_MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export interface LocalPoi {
  name: string;
  type: string;
  distance_m: number;
  lat?: number;
  lon?: number;
  /** Short canonical Google Maps place URL (captured + shortened by
   *  scripts/capture-place-urls.ts). When present, links should use it so the
   *  client's map opens the EXACT place card, not a bare coordinate view. */
  place_url?: string;
  /** Google place_id (hex pair "0x…:0x…"). When present, landmarkLink emits
   *  maps.google.com/?cid=<decimal> — the EXACT place card, immune to name
   *  ambiguity. Populated from overrides and the monthly SerpApi top-up. */
  place_id?: string;
}

export interface Center {
  lat: number;
  lon: number;
  trusted: boolean;
}

export interface GeocodeHit {
  lat: number;
  lon: number;
  street: string;
}

export type OfflineResolveSource = 'osm_building' | 'osm_interpolated' | 'osm_low_confidence';

/** Result of the instant offline property resolver, tagged with an explicit
 *  trust level. Trusted coords (osm_building / osm_interpolated) may anchor
 *  POI searches and client links. Untrusted results (osm_low_confidence)
 *  must never anchor a landmark claim — they go to the honest "населба"
 *  fallback and the async re-resolution queue geocodes them later. */
export type OfflineResolve =
  | { lat: number; lon: number; trusted: true; source: 'osm_building' | 'osm_interpolated' }
  | { lat: number | null; lon: number | null; trusted: false; source: 'osm_low_confidence' };

export interface MapStats {
  pois: number;
  addresses: number;
  bytes: number;
}

// --- Latin ↔ Cyrillic street matching ----------------------------------------
// Feed addresses are Cyrillic ("ул. Борис Трајковски"), OSM addr:street can be
// Latin ("Boris Trajkovski") or Cyrillic. Match on a canonical LATIN key.

const CYR2LAT: Array<[string, string]> = [
  ['ѓ', 'gj'], ['ќ', 'kj'], ['љ', 'lj'], ['њ', 'nj'], ['ѕ', 'dz'], ['џ', 'dz'],
  ['а', 'a'], ['б', 'b'], ['в', 'v'], ['г', 'g'], ['д', 'd'], ['е', 'e'],
  ['ж', 'z'], ['з', 'z'], ['и', 'i'], ['ј', 'j'], ['к', 'k'], ['л', 'l'],
  ['м', 'm'], ['н', 'n'], ['о', 'o'], ['п', 'p'], ['р', 'r'], ['с', 's'],
  ['т', 't'], ['у', 'u'], ['ф', 'f'], ['х', 'h'], ['ц', 'c'], ['ч', 'c'],
  ['ш', 's'],
];

// Longest-match first: lj/nj/dz before single letters.
const LAT2CYR: Array<[string, string]> = [
  ['dzh', 'џ'], ['lj', 'љ'], ['nj', 'њ'], ['gj', 'ѓ'], ['kj', 'ќ'], ['dz', 'ѕ'],
  ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'],
  ['z', 'з'], ['i', 'и'], ['j', 'ј'], ['k', 'к'], ['l', 'л'], ['m', 'м'],
  ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'],
  ['u', 'у'], ['f', 'ф'], ['h', 'х'], ['c', 'ц'], ['y', 'ј'], ['zh', 'ж'],
  ['ch', 'ч'], ['sh', 'ш'],
];

export function toLatin(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) {
    const hit = CYR2LAT.find(([k]) => k === ch);
    out += hit ? hit[1] : ch;
  }
  return out;
}

export function toCyrillic(s: string): string {
  const low = s.toLowerCase();
  let out = '';
  let i = 0;
  while (i < low.length) {
    const two = LAT2CYR.find(([k]) => k === low.slice(i, i + 2));
    if (two) { out += two[1]; i += 2; continue; }
    const one = LAT2CYR.find(([k]) => k === low[i]);
    out += one ? one[1] : low[i];
    i += 1;
  }
  return out;
}

/** Canonical key for a street: strip the ул./бул./street prefixes and the house
 *  number, collapse spaces, fold to Latin lowercase. "ул. Борис Трајковски 12"
 *  and "Boris Trajkovski" both → "boris trajkovski".
 *
 *  Handles: Бул. АСНОМ Бр.134 → asnom, Јане Сандански 25 - 17 → jane sandanski,
 *  Кузман Јосифовски Питу 19/5 → kuzman josifovski pitu, Рузвелтова 51 2-10
 *  → ruzveltova, Тоне Томшиќ Бр.25 → tone tomsikj. */
export function normalizeStreet(s: string): string {
  return s.toLowerCase()
    // Street-type prefixes
    .replace(/^(?:ул\.?|улица|бул\.?|булевар|пат|street|st\.?|boulevard|blvd|ave\.?|avenue)\s+/i, '')
    // "Бр." / "Бр" (Број = number) prefix before house number
    // Note: \b doesn't work with Cyrillic in Node 18, so match after space/start
    .replace(/(?:^|\s)бр\.?\s*/i, ' ')
    // Trailing house number: ranges (25 - 17, 86 - 1, 51 2-10, 26-2),
    // slash fractions (19/5), compound numbers (51 2-10), and simple numbers.
    // Strategy: strip everything from the FIRST trailing number pattern onward,
    // but only if it's preceded by a space (so street names with numbers like
    // "11 Октомври" aren't touched).
    .replace(/\s+\d+(?:[\s.\-/]*(?:\d+|[а-яa-z]+))*\s*$/i, '')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function streetKey(s: string): string {
  return toLatin(normalizeStreet(s));
}

/** Cyrillic → Latin transliteration, for tolerant name comparison. */
export function translitToLatin(s: string): string {
  const map: Record<string, string> = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'ѓ': 'gj', 'е': 'e', 'ж': 'zh', 'з': 'z',
    'ѕ': 'dz', 'и': 'i', 'ј': 'j', 'к': 'k', 'л': 'l', 'љ': 'lj', 'м': 'm', 'н': 'n', 'њ': 'nj',
    'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'ќ': 'kj', 'у': 'u', 'ф': 'f', 'х': 'h',
    'ц': 'c', 'ч': 'ch', 'џ': 'dzh', 'ш': 'sh',
  };
  return s.toLowerCase().split('').map(c => map[c] ?? c).join('');
}

/** Tolerant name key: transliterate + lowercase + strip punctuation/spaces.
 *  Deliberately does NOT strip meaningful words — "Kipper" vs
 *  "Kipper Market - Butel" are different branches and must stay distinct. */
export function normName(s: string): string {
  return translitToLatin(s).replace(/[^a-z0-9]/g, '');
}

/**
 * SEMANTIC name key — bridges TRANSLATED landmark names (Cyrillic ↔ English),
 * which transliteration alone can never match:
 *   "Амбасада на Црна Гора" → "embassy montenegro"
 *   "Embassy of Montenegro" → "embassy montenegro"   ✅ SAME KEY
 * Built from a small lexicon of institution words + Balkan geographic names
 * (the vocabulary Skopje landmarks actually use). Stopwords (на/of) stripped.
 * Deliberately conservative: words NOT in the lexicon pass through untouched,
 * so ordinary brand names ("Kipper", "Tinex") are never mangled.
 */
const LEXICON_PHRASES: Array<[string, string]> = [
  ['crna gora', 'montenegro'],
  ['sjeverna makedonija', 'macedonia'],
  ['makedonija', 'macedonia'],
];
const LEXICON_WORDS: Record<string, string> = {
  ambasada: 'embassy', ambasadi: 'embassy', ambasy: 'embassy',
  banka: 'bank', banki: 'bank',
  uciliste: 'school', ucilista: 'school', gimnazija: 'school', gimnazii: 'school',
  bolnica: 'hospital', bolnici: 'hospital', klinika: 'clinic',
  park: 'park', parkot: 'park', gradina: 'garden',
  crkva: 'church', crkvi: 'church', manastir: 'monastery', dzamija: 'mosque',
  katedrala: 'cathedral', crkven: 'church',
  muzej: 'museum', muzei: 'museum', teatar: 'theatre', pozoriste: 'theatre',
  stadion: 'stadium', arena: 'stadium',
  mol: 'mall', trgovski: 'shopping', market: 'market', pazara: 'market', pazar: 'market',
  apoteka: 'pharmacy', apoteki: 'pharmacy',
  hotel: 'hotel', hoteli: 'hotel', motel: 'motel',
  univerzitet: 'university', fakultet: 'university',
  opstina: 'municipality', policija: 'police', posta: 'post',
  sobranie: 'assembly', skopski: 'skopje',
  srbija: 'serbia', bugarija: 'bulgaria', grcija: 'greece', albaniia: 'albania',
  albanija: 'albania', germanija: 'germany', francija: 'france', italija: 'italy',
  turcija: 'turkey', amerika: 'america',
  // Country names, Macedonian → English canonical (embassies, hotels, banks):
  // without these, 'Чешка' vs 'Czech' looks like DIFFERENT countries and the
  // identity guard wrongly separates one place into two.
  rusija: 'russia', spanija: 'spain', cheshka: 'czech', slovenija: 'slovenia',
  avstrija: 'austria', madjarska: 'hungary', madarska: 'hungary',
  svicarska: 'switzerland', svajcarska: 'switzerland', kazahstan: 'kazakhstan',
  bosna: 'bosnia', hercegovina: 'herzegovina', poljska: 'poland',
  ukrajina: 'ukraine', kina: 'china', katar: 'qatar', iran: 'iran',
  britanska: 'british', crnogorska: 'montenegro', slovachka: 'slovakia',
  holandija: 'netherlands', romania: 'romania', ungary: 'hungary',
  // Adjective forms → same canonical country ("Dutch Embassy" =
  // "Амбасада на Холандија" — without these the identity guard sees
  // two different countries and wrongly separates one place in two).
  dutch: 'netherlands', swedish: 'sweden', japanese: 'japan',
  hungarian: 'hungary', austrian: 'austria', chinese: 'china',
  ukrainian: 'ukraine', polish: 'poland', romanian: 'romania',
  russian: 'russia', croatian: 'croatia', german: 'germany',
  spanish: 'spain', turkish: 'turkey', italian: 'italy', greek: 'greece',
  bulgarian: 'bulgaria', serbian: 'serbia', slovak: 'slovakia',
  kingdom: 'british',
  // Common transliteration drift (Cyrillic ИЛИ→ILI, etc.)
  beverli: 'beverly', hils: 'hills',
};
const STOPWORDS = new Set(['na', 'vo', 'od', 'do', 'kaj', 'sproti', 'of', 'the', 'in', 'at', 'de']);
export function semanticNameKey(s: string): string {
  let t = translitToLatin(s)
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  for (const [from, to] of LEXICON_PHRASES) t = t.split(from).join(to);
  const out = t.split(' ').map(w => LEXICON_WORDS[w] ?? w).filter(w => w && !STOPWORDS.has(w));
  return out.join(' ');
}
/** Merge keys for a landmark name: exact translit + semantic. Two names are
 *  the same place for merge purposes when ANY key matches. */
export function nameMergeKeys(s: string): string[] {
  const sem = semanticNameKey(s);
  const keys = [normName(s)];
  // Only add the semantic key when it differs AND is substantial — a bare
  // "embassy" or "park" must not merge every embassy/park in the city.
  if (sem.length >= 8 && sem !== keys[0]) keys.push(sem.replace(/\s+/g, ' ').trim());
  return keys;
}

/** First house-number token in a raw address line.
 *  "Јане Сандански 25 - 17" → "25", "Бр.134" → "134", "ул. Македонија" → "".
 *  Shared by geocodeAddress() and resolvePropertyOffline(). */
export function extractHouseNum(address: string): string {
  const m = address.match(/\b(\d+[а-яa-z]?)\b/i);
  return m ? m[1] : '';
}

/** Numeric value of a stored house number, for neighbour ordering.
 *  "19A" → 19.5, "29/3" → 29, "16/134" → 16, "70b" → 70.5.
 *  Shared by geocodeAddress() and resolvePropertyOffline(). */
export function houseNumValue(h: string): number | null {
  const m = h.match(/^(\d+)/);
  if (!m) return null;
  const base = parseInt(m[1], 10);
  // Letter suffix (19A, 5B, 70b) → +0.5 — sits between 19 and 20.
  if (/^\d+[a-zа-я]$/i.test(h)) return base + 0.5;
  return base;
}

/** True when a and b differ by at most one edit (insert/delete/substitute).
 *  Used for the typo-tolerant geocoder: feed writes "Ефтим", OSM has "Евтим". */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (la < lb) j++;
    else { i++; j++; }
  }
  if (i < la || j < lb) edits++;
  return edits <= 1;
}

/** Distance in meters (haversine). */
function meters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// --- The read store -----------------------------------------------------------

/** POI type priority for landmark selection. Lower = better landmark.
 *  Institutional places (hospitals, schools, government) are universally
 *  recognized navigation anchors. Shops and cafes are only useful when
 *  very close. People say "кај болницата", never "кај фурната". */
const POI_PRIORITY: Record<string, number> = {
  // place types — squares are the BEST Skopje landmarks
  square: 0, plaza: 0,
  // neighbourhood/locality/suburb are geographic LABELS, not landmarks.
  // 'во близина на Центар' is meaningless when you ARE in Центар.
  // Never use as landmarks — excluded from nearestPois entirely.
  neighbourhood: 100, locality: 100, suburb: 100,
  // institutional
  hospital: 1, clinic: 1, healthcare: 1,
  school: 2, university: 2, college: 2, dormitory: 2,
  government: 3, townhall: 3, embassy: 3, diplomatic: 3, political_party: 3,
  stadium: 4, sports_centre: 4, swimming_pool: 4,
  place_of_worship: 5, church: 5, mosque: 5, synagogue: 5,
  museum: 6, gallery: 6, theatre: 6, cinema: 6, library: 6,
  hotel: 7, motel: 7, hostel: 7,
  mall: 8, shopping_mall: 8, department_store: 8,
  bank: 9, atm: 9, bureau_de_change: 9,
  pharmacy: 10, chemist: 10,
  police: 11, fire_station: 11, ambulance_station: 11,
  park: 12, garden: 12, playground: 12, nature_reserve: 12,
  supermarket: 15, convenience: 15,
  restaurant: 20, cafe: 20, fast_food: 20, bar: 20, pub: 20,
  bakery: 25, clothes: 25, jewelry: 25, books: 25,
  fuel: 30, parking: 30,
  parking_landmark: 7, // named garages ("Катна гаража Беко") — hotel-level landmark
};

/** Named parking garages ("Катна гаража Беко") are Skopje landmarks — boost
 *  them from parking (30) to hotel level (7). Generic "Parking" stays at 30. */
function boostNamedLandmark(type: string, name: string): string {
  if (type === 'parking' && /каража|гараж|garage/i.test(name)) return 'parking_landmark';
  return type;
}

/** Big chain supermarkets in Skopje — recognized as landmarks when close.
 *  "кај КАМ", "кај Веро", "кај Рамstor" are real navigation phrases. */
const BIG_CHAIN_RE = /kam|kam\s+market|vero|stokomak|tinex|reptil|kipper|ramstor/i;
function isBigChain(name: string): boolean {
  return BIG_CHAIN_RE.test(name);
}

/** Distance-based priority: malls and big chains nearby are excellent
 *  landmarks — "кај Беверли Хилс" or "кај КАМ Маркет" are what people
 *  actually say. Closer = better priority, with a floor for distant POIs. */
function effectivePriority(type: string, name: string, distanceM: number): number {
  const isMall = type === 'mall' || type === 'shopping_mall';
  // Tier 1-4: malls and big chains (proximity matters most for these)
  if (isMall && distanceM <= 150) return 1;
  if (isBigChain(name) && distanceM <= 150) return 2;
  if (isMall) return 3;
  if (isBigChain(name)) return 4;
  // Tier 5+: everything else — shift POI_PRIORITY up so malls/chains always win
  const base = POI_PRIORITY[type] ?? 50;
  return base + 10; // squares go from 0→10, hospitals from 1→11, etc.
}

/** Permanence multiplier: permanent landmarks (parks, churches, schools,
 *  monuments) should beat temporary ones (shops, cafes) even when farther,
 *  because the street reference "кај паркот" will be valid in 10 years;
 *  "кај Алка-У" might not. Multiplier < 1 = lower score = better pick.
 *  A park at ~180m (score ≈ 275) beats a supermarket at 117m (score ≈ 293).
 *  A shop at ≤65m still wins over any permanent landmark (score ≤ 163). */
const PERMANENCE: Record<string, number> = {
  // Permanent — never relocate, decades-long
  park: 0.55, garden: 0.55, playground: 0.55, nature_reserve: 0.55,
  place_of_worship: 0.55, church: 0.55, mosque: 0.55, synagogue: 0.55,
  school: 0.55, university: 0.55, college: 0.55,
  hospital: 0.55, clinic: 0.55, healthcare: 0.55,
  government: 0.55, townhall: 0.55, embassy: 0.55, diplomatic: 0.55, political_party: 0.55,
  stadium: 0.55, sports_centre: 0.55, swimming_pool: 0.55,
  museum: 0.55, gallery: 0.55, theatre: 0.55, cinema: 0.55, library: 0.55,
  police: 0.55, fire_station: 0.55, ambulance_station: 0.55,
  square: 0.55, plaza: 0.55,
  parking_landmark: 0.55, // named garages are permanent landmarks
  // Semi-permanent — usually stable but can change
  hotel: 0.75, motel: 0.75, hostel: 0.75,
  mall: 0.75, shopping_mall: 0.75, department_store: 0.75,
  bank: 0.75, atm: 0.75, bureau_de_change: 0.75,
  pharmacy: 0.75, chemist: 0.75,
  fuel: 0.75,
  // Temporary — can open/close within months
  supermarket: 1.0, convenience: 1.0,
  restaurant: 1.0, cafe: 1.0, fast_food: 1.0, bar: 1.0, pub: 1.0,
  bakery: 1.0, clothes: 1.0, jewelry: 1.0, books: 1.0,
  parking: 1.0, // generic parking, not a named garage
};

export class OfflineMapStore {
  private db: Database.Database | null = null;
  /** Lazy cache of all distinct address keys for the fuzzy matcher. */
  private keyCache: string[] | null = null;

  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath, { readonly: true });
      // Schema self-upgrade: DBs built before the place_id column (Google
      // place-card links) must still open — new column reads as NULL and the
      // overrides fill it on the next apply/build. readonly connections can
      // still PRAGMA table_info; only the ALTER would fail, and a NULL
      // place_id is handled gracefully everywhere (link falls to next tier).
      const cols = (this.db.prepare("PRAGMA table_info(pois)").all() as Array<{ name: string }>)
        .map(c => c.name);
      if (!cols.includes('place_id')) {
        try {
          this.db.close();
          const rw = new Database(dbPath); // read-write for the migration
          rw.exec('ALTER TABLE pois ADD COLUMN place_id TEXT');
          rw.close();
          this.db = new Database(dbPath, { readonly: true });
        } catch { /* read-only FS or concurrent writer — place_id stays absent */ }
      }
      // Validate the schema — an empty/foreign file must not masquerade as a map.
      this.db.prepare('SELECT COUNT(*) FROM pois').get();
    } catch {
      if (this.db) { try { this.db.close(); } catch { /* ignore */ } }
      this.db = null; // no map built yet — callers fall back to live APIs
    }
  }

  get available(): boolean {
    return this.db !== null;
  }

  close(): void {
    if (this.db) { this.db.close(); this.db = null; }
  }

  stats(): MapStats | null {
    if (!this.db) return null;
    const pois = (this.db.prepare('SELECT COUNT(*) as c FROM pois').get() as { c: number }).c;
    const addresses = (this.db.prepare('SELECT COUNT(*) as c FROM addresses').get() as { c: number }).c;
    return { pois, addresses, bytes: 0 };
  }

  /** The named POIs within radiusM of a point, preference-ranked first.
   *  Google-sourced POIs win on a Cyrillic/Latin-tolerant same-place
   *  collision within 30m (the Google entry has verified coordinates). */
  nearestPois(lat: number, lon: number, radiusM = 2000, limit = 10, opts?: { distanceOnly?: boolean }): LocalPoi[] {
    if (!this.db) return [];
    const rows = this.db.prepare(`
      SELECT * FROM pois
      WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
    `).all(lat - radiusM / 111000, lat + radiusM / 111000,
           lon - radiusM / 82000,  lon + radiusM / 82000) as Array<{
      name: string; type: string; lat: number; lon: number; source?: string; place_url?: string; place_id?: string;
    }>;

    const inCircle = rows
      .map(r => ({ ...r, dist: distM(lat, lon, r.lat, r.lon) }))
      .filter(r => r.dist <= radiusM);

    // Junk types (taxonomy dirt from the Overpass/Google merge) are never
    // usable as landmarks — filter BEFORE ranking so a "yes" building can't
    // outrank a real anchor.
    const JUNK_TYPES = new Set(['yes', 'place', 'residential', 'company', '',
      'house', 'building', 'address', 'unknown']);
    const clean = inCircle.filter(r => !JUNK_TYPES.has(normType(r.type)));

    // Institutional landmark first, then distance. This replaces the
    // pure-distance sort: a mall at 200m outranks a cafe at 50m — people say
    // "кај Рамстор", never "кај кафето".
    const ranked = clean.sort((a, b) =>
      (typeRank(b.type) - typeRank(a.type)) || (a.dist - b.dist));

    // Dedupe pass — Cyrillic/Latin + case/punctuation tolerant (NOT name
    // variants: "Kipper" vs "Kipper Market - Butel" are different branches
    // and must never merge). For a same-place pair within 30m, Google wins
    // the anchor (verified coordinates); the OSM row is dropped.
    // Identity tier 1: same non-null place_id = THE SAME physical place no
    // matter how the name is spelled (official vs feed alias) or how far the
    // coordinates disagree — this is what keeps two spellings of one embassy
    // from occupying two of the three rotation slots. No distance bound:
    // place_id equality is stronger evidence than any coordinate.
    const merged: Array<{ name: string; type: string; lat: number; lon: number; dist: number; source?: string; place_url?: string; place_id?: string }> = [];
    for (const poi of ranked) {
      const dup = merged.find(g =>
        (!!poi.place_id && !!g.place_id && poi.place_id === g.place_id) ||
        (Math.abs(g.dist - poi.dist) < 30 && normName(g.name) === normName(poi.name)));
      if (dup) {
        if (poi.source === 'google' && dup.source !== 'google') {
          // Google wins the anchor; replace the dup in place
          merged[merged.indexOf(dup)] = poi;
        }
        continue; // else keep existing (same-source or google already present)
      }
      merged.push(poi);
    }
    return merged.slice(0, limit).map(p => ({
      name: p.name,
      type: p.type,
      distance_m: Math.round(p.dist),
      lat: p.lat,
      lon: p.lon,
      place_url: p.place_url,
      place_id: p.place_id,
    }));
  }

  /** Fuzzy POI name search — LIKE %name% against the pois table, sorted by
   *  real haversine distance from center. Returns candidates within 900m. */
  findPoisLike(name: string, center: Center): Array<{ name: string; lat: number; lon: number; dist: number; place_url?: string; place_id?: string }> {
    if (!this.db || !name) return [];
    const rows = this.db.prepare(
      `SELECT name, lat, lon, place_url, place_id FROM pois WHERE name LIKE ? COLLATE NOCASE`
    ).all(`%${name}%`) as Array<{ name: string; lat: number; lon: number; place_url?: string; place_id?: string }>;
    return rows
      .map(r => ({ ...r, dist: distM(center.lat, center.lon, r.lat, r.lon) }))
      .filter(r => r.dist <= 900)
      .sort((a, b) => a.dist - b.dist);
  }

  /** Local address → coordinates. When the address includes a house number
   *  ("Јане Сандански 25"), we prefer the EXACT building at that number so
   *  the POI radius is centred on the right spot (not the whole boulevard).
   *  Falls back to any building on the street when the number isn't in the DB. */
  /** All distinct street keys (loaded once per process). */
  private allKeys(): string[] {
    if (!this.keyCache) {
      this.keyCache = this.db
        ? (this.db.prepare('SELECT DISTINCT key FROM addresses').all() as Array<{ key: string }>).map(r => r.key)
        : [];
    }
    return this.keyCache;
  }

  /** Unambiguous 1-edit match for a missing street key, if any.
   *  Conservative: only accepts when exactly ONE known key is within one
   *  edit — ambiguous matches fail rather than guess. Keys shorter than
   *  6 chars are never fuzzy-matched (too risky). */
  private fuzzyKey(key: string): string | undefined {
    if (key.length < 6) return undefined;
    let match: string | undefined;
    for (const k of this.allKeys()) {
      if (withinOneEdit(key, k)) {
        if (match !== undefined) return undefined; // ambiguous → no guess
        match = k;
      }
    }
    return match;
  }

  geocodeAddress(street: string): GeocodeHit | undefined {
    if (!this.db || !street) return undefined;
    const key = this.resolveKey(street);
    if (!key) return undefined;
    const hit = this.resolveAddress(street, key);
    return hit ? { lat: hit.lat, lon: hit.lon, street: hit.street } : undefined;
  }

  /** Canonical street key lookup with the FUZZY FALLBACK: feed addresses
   *  sometimes misspell the OSM street name by one letter ("Ефтим
   *  Спространов" feed vs "Евтим Спространов" OSM). When the exact key has
   *  no rows at all, try an unambiguous 1-edit match before giving up — this
   *  makes typo'd future properties just work. Returns undefined for a
   *  completely unknown street. */
  private resolveKey(street: string): string | undefined {
    if (!this.db || !street) return undefined;
    const rawKey = streetKey(street);
    if (!rawKey) return undefined;
    const exactRows = this.db.prepare('SELECT COUNT(*) AS n FROM addresses WHERE key = ?').get(rawKey) as { n: number };
    return exactRows.n > 0 ? rawKey : (this.fuzzyKey(rawKey) ?? rawKey);
  }

  /** Stage A — exact house-number row, then compound match ("Бр.134" →
   *  "16/134", where the /134 part is the door number). Returns the stored
   *  building coordinates when found (trusted — a real mapped building). */
  private exactBuilding(key: string, houseNum: string): { lat: number; lon: number; street: string } | undefined {
    if (!this.db) return undefined;
    const exact = this.db.prepare(
      `SELECT street, lat, lon FROM addresses WHERE key = ? AND housenumber = ?
       OR (key = ? AND housenumber = ? COLLATE NOCASE) LIMIT 1`
    ).get(key, houseNum, key, houseNum) as { street: string; lat: number; lon: number } | undefined;
    if (exact) return exact;
    const compound = this.db.prepare(
      `SELECT street, lat, lon FROM addresses
       WHERE key = ? AND housenumber LIKE '%' || ? || '%'
       ORDER BY LENGTH(housenumber) ASC LIMIT 1`
    ).get(key, houseNum) as { street: string; lat: number; lon: number } | undefined;
    if (compound) return compound;
    return undefined;
  }

  /** Stage B — linear interpolation between the two adjacent numbered
   *  buildings when the exact number is missing. More accurate than the ББ
   *  centroid (which can be 100m+ off on long streets).
   *  E.g. Народен Фронт 23 → between #19A (41.9937, 21.4163) and #25
   *  (41.9940, 21.4146) → interpolated near Beverly Hills Center.
   *  Returns { interp: true } only when BOTH neighbours exist (a real
   *  estimate); otherwise the nearest endpoint is returned with
   *  { interp: false } — still a rough guess, never a trusted point. */
  private interpolateBuilding(key: string, houseNum: string):
    { lat: number; lon: number; street: string; interp: boolean } | undefined {
    if (!this.db) return undefined;
    const allBuildings = this.db.prepare(
      `SELECT street, housenumber, lat, lon FROM addresses
       WHERE key = ? AND housenumber != '' AND housenumber != 'ББ'
       ORDER BY housenumber`
    ).all(key) as Array<{ street: string; housenumber: string; lat: number; lon: number }>;
    if (allBuildings.length < 2) return undefined;
    const target = houseNumValue(houseNum);
    if (target === null) return undefined;
    const parsed = allBuildings
      .map(b => ({ ...b, num: houseNumValue(b.housenumber) }))
      .filter(b => b.num !== null) as Array<{ street: string; housenumber: string; lat: number; lon: number; num: number }>;
    parsed.sort((a, b) => a.num - b.num);
    // Find the two neighbors: largest <= target and smallest > target
    let lo: typeof parsed[0] | null = null;
    let hi: typeof parsed[0] | null = null;
    for (const b of parsed) {
      if (b.num <= target) lo = b;
    }
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].num > target) { hi = parsed[i]; break; }
    }
    if (lo && hi && lo.num !== hi.num) {
      const t = (target - lo.num) / (hi.num - lo.num);
      return {
        lat: lo.lat + t * (hi.lat - lo.lat),
        lon: lo.lon + t * (hi.lon - lo.lon),
        street: lo.street,
        interp: true,
      };
    }
    // Target is outside the range — use the nearest endpoint (rough guess)
    if (lo) return { lat: lo.lat, lon: lo.lon, street: lo.street, interp: false };
    if (hi) return { lat: hi.lat, lon: hi.lon, street: hi.street, interp: false };
    return undefined;
  }

  /** Stage C — "ББ" (без број / no number) row: the street centroid. Only
   *  used when no numbered building or interpolation exists. A street-level
   *  point, never building-accurate. */
  private streetCentroid(key: string): { lat: number; lon: number; street: string } | undefined {
    if (!this.db) return undefined;
    return this.db.prepare(
      `SELECT street, lat, lon FROM addresses WHERE key = ?
       AND (housenumber = 'ББ' OR housenumber = '') LIMIT 1`
    ).get(key) as { street: string; lat: number; lon: number } | undefined;
  }

  /** Stage D — absolute last resort: the first building on the street. Used
   *  only when even a centroid row is missing. Rough. */
  private firstBuilding(key: string): { lat: number; lon: number; street: string } | undefined {
    if (!this.db) return undefined;
    return this.db.prepare(
      `SELECT street, lat, lon FROM addresses WHERE key = ?
       ORDER BY housenumber ASC LIMIT 1`
    ).get(key) as { street: string; lat: number; lon: number } | undefined;
  }

  /** Shared address→coordinate chain used by BOTH geocodeAddress() (which
   *  collapses trust) and resolvePropertyOffline() (which keeps it). Exact +
   *  interpolated results are trusted; street-level guesses are not. */
  private resolveAddress(street: string, key: string):
    { lat: number; lon: number; street: string; trusted: boolean; source: OfflineResolveSource } | undefined {
    // Extract the house number: the first number after the street name
    // ("Јане Сандански 25 - 17" → "25", "Бр.134" → "134").
    const houseNum = extractHouseNum(street);

    // Stage A: exact/compound building
    if (houseNum) {
      const exact = this.exactBuilding(key, houseNum);
      if (exact) return { ...exact, trusted: true, source: 'osm_building' };
    }

    // Stage B: linear interpolation between neighbours
    if (houseNum) {
      const interp = this.interpolateBuilding(key, houseNum);
      if (interp) {
        if (interp.interp) {
          return { lat: interp.lat, lon: interp.lon, street: interp.street, trusted: true, source: 'osm_interpolated' };
        }
        // Endpoint clamp — a rough guess, never trusted
        return { lat: interp.lat, lon: interp.lon, street: interp.street, trusted: false, source: 'osm_low_confidence' };
      }
    }

    // Stage C: street centroid ("ББ" / no number)
    const centroid = this.streetCentroid(key);
    if (centroid) return { ...centroid, trusted: false, source: 'osm_low_confidence' };

    // Stage D: first building on the street — street-level guess
    const first = this.firstBuilding(key);
    if (first) return { ...first, trusted: false, source: 'osm_low_confidence' };

    return undefined;
  }

  /** Resolve a property's own address to coordinates WITHOUT any network,
   *  tagged with an explicit trust level — the Phase-1 instant offline
   *  import resolver. Conservative on purpose: exact + interpolated results
   *  are trusted; street-centroid / endpoint guesses are never trusted and
   *  may be omitted entirely (null lat/lon) when the street itself is
   *  unknown or the address is a landmark/complex name ("БИСЕР"). */
  resolvePropertyOffline(address: string): OfflineResolve {
    if (!this.db || !address) return { lat: null, lon: null, trusted: false, source: 'osm_low_confidence' };
    const key = this.resolveKey(address);
    if (!key) return { lat: null, lon: null, trusted: false, source: 'osm_low_confidence' };
    const hit = this.resolveAddress(address, key);
    if (!hit) return { lat: null, lon: null, trusted: false, source: 'osm_low_confidence' };
    if (hit.trusted) {
      return { lat: hit.lat, lon: hit.lon, trusted: true as const, source: hit.source as 'osm_building' | 'osm_interpolated' };
    }
    return { lat: hit.lat, lon: hit.lon, trusted: false as const, source: 'osm_low_confidence' as const };
  }

  /** Search POIs by name — for landmark-style addresses like "Кај Бранка"
   *  or "Палома Бјанка" where the address IS the landmark, not a street.
   *  Returns the best match (exact > starts-with > contains). */
  findPoiByName(name: string): { lat: number; lon: number; name: string; place_url?: string; place_id?: string } | undefined {
    if (!this.db || !name) return undefined;
    // Strip location prepositions AND feed typos of them ("как" for "кај").
    const clean = name.replace(/^(?:кај|спроти|как|кај штипски|кај скопски)\s+/i, '').trim();
    if (!clean || clean.length < 2) return undefined;
    // Prefer SHORTER names ("ТЦ Бисер" > "Бисер Травел") — the shorter name
    // is the more precise landmark reference.
    // NOTE: SQL LIKE ... COLLATE NOCASE does NOT fold non-ASCII case, so
    // "тц олимпико" would never match "ТЦ Олимпико". Do the contains-test in
    // JS where toLowerCase() is Unicode-aware. Table is ~4k rows — trivial.
    const needle = clean.toLowerCase();
    let rows = (this.db.prepare(
      'SELECT name, type, lat, lon, place_url, place_id FROM pois'
    ).all() as Array<{ name: string; type: string; lat: number; lon: number; place_url?: string; place_id?: string }>)
      .filter(r => r.name.toLowerCase().includes(needle));
    // Progressive shortening: "Сити Мол ' Руските Згради" → "Сити Мол"
    // (head) and "Шампионче Как Кипер Маркет" → "кипер маркет" (tail).
    // Never fall to a SINGLE word — "народен" would match
    // "Македонски народен театар" for an unrelated address.
    const words = clean.split(/\s+/);
    if (rows.length === 0 && words.length > 2) {
      const candidates = [words.slice(0, 2).join(' '), words.slice(-2).join(' ')]
        .map(w => w.toLowerCase())
        .filter(w => w.length >= 3);
      for (const short of candidates) {
        rows = (this.db.prepare(
          'SELECT name, type, lat, lon, place_url FROM pois'
        ).all() as Array<{ name: string; type: string; lat: number; lon: number; place_url?: string }>)
          .filter(r => r.name.toLowerCase().includes(short));
        if (rows.length > 0) break;
      }
    }
    if (rows.length > 0) {
      rows.sort((a, b) => a.name.length - b.name.length);
      const best = rows[0];
      try { fs.appendFileSync('/tmp/landmark-debug.log',
        `[${new Date().toISOString()}] findPoiByName(${clean}): ${rows.length} matches → ${best.name} (${best.name.length} chars)\n`); } catch {}
      return { lat: best.lat, lon: best.lon, name: best.name, place_url: best.place_url ?? undefined, place_id: best.place_id ?? undefined };
    }
    return undefined;
  }
}

// --- The build (pull + rebuild) ------------------------------------------------

interface RawElem {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function coordsOf(e: RawElem): { lat: number; lon: number } | undefined {
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (lat === undefined || lon === undefined) return undefined;
  return { lat: Number(lat), lon: Number(lon) };
}

async function overpass(data: string): Promise<{ elements: RawElem[] }> {
  let lastErr: Error | undefined;
  const MAX_RETRIES = 2;
  for (const mirror of OVERPASS_MIRRORS) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 120_000);
        try {
          const res = await fetch(mirror, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'metropolis-hermes/1.0' },
            body: `data=${encodeURIComponent(data)}`,
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = await res.json() as { remarks?: string; elements?: RawElem[] };
          if (j.remarks && /error/i.test(j.remarks)) throw new Error(j.remarks);
          return { elements: j.elements ?? [] };
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        lastErr = e as Error;
        if (attempt < MAX_RETRIES) {
          const delay = attempt * 15_000; // 15s, 30s backoff
          console.warn(`[skopje-map] mirror ${mirror} attempt ${attempt} failed: ${lastErr.message} — retrying in ${delay / 1000}s`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          console.warn(`[skopje-map] mirror ${mirror} failed (${MAX_RETRIES}x): ${lastErr.message}`);
        }
      }
    }
  }
  throw lastErr ?? new Error('all Overpass mirrors failed');
}

/** The metro bbox split into 2×2 tiles — each Overpass request stays light, so
 *  the pull survives the public servers' load spikes (they 504 on big scans). */
function tiles(): Array<[number, number, number, number]> {
  const [s, w, n, e] = SKOPJE_BBOX;
  const midLat = (s + n) / 2;
  const midLon = (w + e) / 2;
  return [
    [s, w, midLat, midLon],
    [s, midLon, midLat, e],
    [midLat, w, n, midLon],
    [midLat, midLon, n, e],
  ];
}

/** Named POIs (amenity/shop/leisure/tourism/office/healthcare/historic/building) in the Skopje bbox. */
async function fetchPois(): Promise<Array<{ name: string; type: string; lat: number; lon: number }>> {
  const out: Array<{ name: string; type: string; lat: number; lon: number }> = [];
  const seen = new Set<string>();
  for (const bbox of tiles()) {
    // Comprehensive query: pulls ALL named POIs that could be landmarks.
    // place = squares, neighborhoods, localities (Плоштад ВМРО, etc.)
    const q = `[out:json][timeout:90];(
      nwr["name"]["amenity"](${bbox.join(',')});
      nwr["name"]["shop"](${bbox.join(',')});
      nwr["name"]["leisure"](${bbox.join(',')});
      nwr["name"]["tourism"](${bbox.join(',')});
      nwr["name"]["office"](${bbox.join(',')});
      nwr["name"]["healthcare"](${bbox.join(',')});
      nwr["name"]["historic"](${bbox.join(',')});
      nwr["name"]["building"]["building"!="yes"](${bbox.join(',')});
      nwr["name"]["man_made"](${bbox.join(',')});
      nwr["name"]["place"](${bbox.join(',')});
    );out center tags;`;
    const { elements } = await overpass(q);
    for (const e of elements) {
      const name = (e.tags?.name ?? '').trim();
      const c = coordsOf(e);
      if (!name || !c) continue;
      const type = e.tags?.amenity ?? e.tags?.shop ?? e.tags?.leisure ?? e.tags?.tourism ?? e.tags?.office ?? e.tags?.healthcare ?? e.tags?.historic ?? e.tags?.building ?? e.tags?.man_made ?? e.tags?.place ?? 'other';
      const k = `${name}|${c.lat.toFixed(5)}|${c.lon.toFixed(5)}`;
      if (seen.has(k)) continue; // tile borders can double-return a POI
      seen.add(k);
      out.push({ name, type, lat: c.lat, lon: c.lon });
    }
    console.log(`[skopje-map] POI tile ${bbox.join(',')} → ${elements.length} raw elements`);
  }
  return out;
}

/** Address rows (addr:street) — the local geocoding layer. Also expands
 *  addr:interpolation ways ("numbers 15-21 along this segment") into
 *  individual house-number rows, and captures addr:place addressing used in
 *  villages/settlements without street names ("Визбегово 12"). */
async function fetchAddresses(): Promise<Array<{ street: string; housenumber: string; lat: number; lon: number }>> {
  const out: Array<{ street: string; housenumber: string; lat: number; lon: number }> = [];
  const seen = new Set<string>();
  for (const bbox of tiles()) {
    const q = `[out:json][timeout:60];nwr["addr:street"](${bbox.join(',')});out center tags;`;
    const { elements } = await overpass(q);
    for (const e of elements) {
      const street = (e.tags?.['addr:street'] ?? '').trim();
      const c = coordsOf(e);
      if (!street || !c) continue;
      const k = `${street.toLowerCase()}|${c.lat.toFixed(5)}|${c.lon.toFixed(5)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ street, housenumber: (e.tags?.['addr:housenumber'] ?? '').trim(), lat: c.lat, lon: c.lon });
    }
    console.log(`[skopje-map] address tile ${bbox.join(',')} → ${elements.length} raw elements`);
  }

  // --- addr:interpolation ways → individual numbered houses --------------
  // A way tagged addr:interpolation=odd/even/all carries a number range in
  // addr:housenumber ("15-21" or "15;19") and geometry covering exactly those
  // plots. Expanding gives us house numbers OSM never maps as separate
  // buildings — the main source of NUMBER_GAP failures.
  for (const bbox of tiles()) {
    try {
      const q = `[out:json][timeout:90];way["addr:interpolation"]["addr:housenumber"](${bbox.join(',')});out geom tags;`;
      const { elements } = await overpass(q);
      let expanded = 0;
      for (const e of elements) {
        const street = (e.tags?.['addr:street'] ?? '').trim();
        const geom = (e as unknown as { geometry?: Array<{ lat: number; lon: number }> }).geometry;
        if (!street || !geom || geom.length < 2) continue;
        for (const pt of expandInterpolation(e.tags ?? {}, geom)) {
          const k = `${street.toLowerCase()}|${pt.lat.toFixed(6)}|${pt.lon.toFixed(6)}|${pt.housenumber}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ street, housenumber: pt.housenumber, lat: pt.lat, lon: pt.lon });
          expanded++;
        }
      }
      console.log(`[skopje-map] interpolation tile ${bbox.join(',')} → +${expanded} house numbers`);
    } catch (err) {
      console.warn(`[skopje-map] interpolation tile failed (continuing): ${(err as Error).message}`);
    }
  }

  // --- addr:place — settlements addressed by place name, not street -------
  for (const bbox of tiles()) {
    try {
      const q = `[out:json][timeout:60];nwr["addr:place"]["addr:housenumber"](${bbox.join(',')});out center tags;`;
      const { elements } = await overpass(q);
      let added = 0;
      for (const e of elements) {
        const place = (e.tags?.['addr:place'] ?? '').trim();
        const hn = (e.tags?.['addr:housenumber'] ?? '').trim();
        const c = coordsOf(e);
        if (!place || !hn || !c) continue;
        const k = `${place.toLowerCase()}|${c.lat.toFixed(5)}|${c.lon.toFixed(5)}|${hn}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ street: place, housenumber: hn, lat: c.lat, lon: c.lon });
        added++;
      }
      console.log(`[skopje-map] place-address tile ${bbox.join(',')} → +${added}`);
    } catch (err) {
      console.warn(`[skopje-map] place-address tile failed (continuing): ${(err as Error).message}`);
    }
  }
  return out;
}

/** Expand an addr:interpolation way's tags into individual positioned house
 *  numbers along its geometry. Supports explicit lists ("15;19"), ranges
 *  ("15-21"), and parity from the interpolation value (odd/even/all/alternate). */
function expandInterpolation(
  tags: Record<string, string>,
  geom: Array<{ lat: number; lon: number }>,
): Array<{ housenumber: string; lat: number; lon: number }> {
  const mode = (tags['addr:interpolation'] ?? 'all').toLowerCase();
  const raw = (tags['addr:housenumber'] ?? '').replace(/\s+/g, '');
  // Collect the numbers this way covers.
  let numbers: number[];
  const list = raw.split(';').map(Number).filter(n => Number.isFinite(n) && n >= 0);
  if (list.length > 1 && !raw.includes('-')) {
    numbers = list; // explicit enumeration "15;17;19"
  } else {
    const m = raw.match(/^(\d+)-(\d+)$/);
    if (!m) return [];
    let lo = parseInt(m[1], 10);
    const hi = parseInt(m[2], 10);
    const step = mode === 'even' || mode === 'odd' ? 2 : 1;
    if (mode !== 'even' && lo % 2 === 0 && hi % 2 === 1 && step === 2) lo += 1;
    numbers = [];
    for (let n = lo; n <= hi; n += step) numbers.push(n);
  }
  if (numbers.length === 0 || numbers.length > 200) return []; // sanity cap
  // Cumulative segment lengths for position-along-way interpolation.
  const cum: number[] = [0];
  for (let i = 1; i < geom.length; i++) {
    const dLat = geom[i].lat - geom[i - 1].lat;
    const dLon = geom[i].lon - geom[i - 1].lon;
    cum.push(cum[i - 1] + Math.hypot(dLat, dLon));
  }
  const total = cum[cum.length - 1] || 1;
  return numbers.map((n, idx) => {
    // Evenly distribute the numbers between way start and end.
    const t = numbers.length === 1 ? 0.5 : idx / (numbers.length - 1);
    const target = t * total;
    let seg = 1;
    while (seg < cum.length - 1 && cum[seg] < target) seg++;
    const segLen = cum[seg] - cum[seg - 1] || 1;
    const f = (target - cum[seg - 1]) / segLen;
    return {
      housenumber: String(n),
      lat: geom[seg - 1].lat + f * (geom[seg].lat - geom[seg - 1].lat),
      lon: geom[seg - 1].lon + f * (geom[seg].lon - geom[seg - 1].lon),
    };
  });
}

/** Write the map tables from given data (atomic: temp file + rename). Exported
 *  so tests can build a map without the network; the CLI uses it via
 *  buildSkopjeDb (which fetches first). */
interface OverrideRow {
  name?: string;
  type?: string;
  lat?: number;
  place_id?: string;
  lon?: number;
  street?: string;
  housenumber?: string;
  osmStreet?: string;
}

/** Apply manual corrections from an overrides JSON file onto a freshly built
 *  map DB. Same semantics as scripts/apply_overrides.ts, but folded INTO the
 *  build so a weekly OSM rebuild can never wipe them:
 *    pois      — insert POI if name+coords absent
 *    replaces  — delete ALL rows with the name, insert the corrected coords
 *    addresses — insert a specific house number if street+number absent
 *    aliases   — duplicate an OSM street's rows under the feed's spelling key
 *  Returns the number of rows added/fixed. Missing file / empty file → 0. */
function applyOverrides(db: Database.Database, file: string): number {
  if (!file || !existsSync(file)) return 0;
  let ov: { pois?: OverrideRow[]; replaces?: OverrideRow[]; addresses?: OverrideRow[]; aliases?: OverrideRow[] };
  try {
    ov = JSON.parse(readFileSync(file, 'utf8'));
  } catch { return 0; }
  let added = 0;

  // --- POIs (insert-if-absent) ---
  for (const p of ov.pois ?? []) {
    if (!p.name || !p.type || !Number.isFinite(p.lat ?? NaN) || !Number.isFinite(p.lon ?? NaN)) continue;
    const n = (db.prepare('SELECT COUNT(*) AS n FROM pois WHERE name = ? AND lat = ? AND lon = ?')
      .get(p.name, p.lat, p.lon) as { n: number }).n;
    if (n > 0) continue;
    db.prepare('INSERT INTO pois (name, type, lat, lon, source, place_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.name, p.type, p.lat, p.lon, 'osm', p.place_id ?? null);
    added++;
  }

  // --- Replaces (fix wrong coords — phantom embassy etc.) ---
  for (const r of ov.replaces ?? []) {
    if (!r.name || !r.type || !Number.isFinite(r.lat ?? NaN) || !Number.isFinite(r.lon ?? NaN)) continue;
    const del = db.prepare('DELETE FROM pois WHERE name = ?').run(r.name);
    db.prepare('INSERT INTO pois (name, type, lat, lon, source, place_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.name, r.type, r.lat, r.lon, 'osm', r.place_id ?? null);
    added += del.changes + 1;
  }

  // --- Addresses (exact house numbers OSM never mapped, e.g. Стефановски 16) ---
  for (const a of ov.addresses ?? []) {
    if (!a.street || !Number.isFinite(a.lat ?? NaN) || !Number.isFinite(a.lon ?? NaN)) continue;
    const key = streetKey(a.street);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM addresses WHERE key = ? AND housenumber = ?')
      .get(key, a.housenumber ?? '') as { n: number }).n;
    if (n > 0) continue;
    db.prepare('INSERT INTO addresses (street, housenumber, lat, lon, key) VALUES (?, ?, ?, ?, ?)')
      .run(a.street, a.housenumber ?? '', a.lat, a.lon, key);
    added++;
  }

  // --- Aliases (duplicate OSM street rows under the feed's spelling) ---
  for (const al of ov.aliases ?? []) {
    const srcKey = streetKey(al.osmStreet ?? '');
    const dstKey = streetKey(al.street ?? '');
    if (!srcKey || !dstKey || srcKey === dstKey) continue;
    const srcRows = db.prepare(
      'SELECT street, housenumber, lat, lon FROM addresses WHERE key = ?'
    ).all(srcKey) as Array<{ street: string; housenumber: string; lat: number; lon: number }>;
    for (const r of srcRows) {
      const n = (db.prepare('SELECT COUNT(*) AS n FROM addresses WHERE key = ? AND housenumber = ?')
        .get(dstKey, r.housenumber) as { n: number }).n;
      if (n > 0) continue;
      db.prepare('INSERT INTO addresses (street, housenumber, lat, lon, key) VALUES (?, ?, ?, ?, ?)')
        .run(al.street!, r.housenumber, r.lat, r.lon, dstKey);
      added++;
    }
  }
  return added;
}

export function writeMap(
  dbPath: string,
  pois: Array<{ name: string; type: string; lat: number; lon: number; source?: string; place_url?: string; place_id?: string }>,
  addresses: Array<{ street: string; housenumber: string; lat: number; lon: number }>,
): MapStats {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const tmp = `${dbPath}.tmp`;

  // Clean up ALL stale files from a previous crashed run — including the
  // journal, WAL, and SHM files that SQLite leaves behind.  The old code
  // only rmSync'd the .tmp itself, leaving the -journal/-wal/-shm which
  // made the next run hang on WAL recovery.
  for (const suffix of ['', '-journal', '-wal', '-shm', '.journal', '.wal', '.shm']) {
    rmSync(tmp + suffix, { force: true });
  }

  console.log(`[skopje-map] writing ${pois.length} POIs + ${addresses.length} addresses to ${tmp}...`);
  const db = new Database(tmp);
  try {
    // DELETE journal + synchronous OFF for max write speed during the build.
    // We don't need crash safety — the build is idempotent and atomic (rename).
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = OFF');

    db.exec(`
      CREATE TABLE pois (
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        lat  REAL NOT NULL,
        lon  REAL NOT NULL,
        source TEXT NOT NULL DEFAULT 'osm',
        place_url TEXT,
        place_id TEXT
      );
      CREATE INDEX idx_pois_lat ON pois(lat);
      CREATE TABLE addresses (
        street      TEXT NOT NULL,
        housenumber TEXT NOT NULL DEFAULT '',
        lat         REAL NOT NULL,
        lon         REAL NOT NULL,
        key         TEXT NOT NULL
      );
      CREATE INDEX idx_addr_key ON addresses(key);
    `);

    // Wrap ALL inserts in a single transaction — 10-100x faster than
    // auto-commit per row.
    const insertAll = db.transaction(() => {
      const insPoi = db.prepare('INSERT INTO pois (name, type, lat, lon, source, place_url, place_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const p of pois) insPoi.run(p.name, p.type, p.lat, p.lon, p.source ?? 'osm', p.place_url ?? null, p.place_id ?? null);
      console.log(`[skopje-map] inserted ${pois.length} POIs`);

      const insAddr = db.prepare('INSERT INTO addresses (street, housenumber, lat, lon, key) VALUES (?, ?, ?, ?, ?)');
      for (const a of addresses) insAddr.run(a.street, a.housenumber, a.lat, a.lon, streetKey(a.street));
      console.log(`[skopje-map] inserted ${addresses.length} addresses`);
      // Manual corrections folded INTO the build (address-overrides.json next
      // to the target DB) so a weekly OSM rebuild never wipes them. Skips
      // silently when no overrides file exists (tests build tmp maps).
      const applied = applyOverrides(db, path.join(path.dirname(dbPath), 'address-overrides.json'));
      if (applied > 0) console.log(`[skopje-map] applied ${applied} override row(s)`);
    });
    insertAll();

    db.close();
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    rmSync(tmp, { force: true });
    throw e;
  }

  renameSync(tmp, dbPath);
  return { pois: pois.length, addresses: addresses.length, bytes: statSync(dbPath).size };
}

/** Pull + rebuild the map. Writes a temp file and renames atomically, so a
 *  failed pull never leaves a half-written map for the resolver. */
export async function buildSkopjeDb(dbPath: string): Promise<MapStats> {
  const [pois, addresses] = await Promise.all([fetchPois(), fetchAddresses()]);
  return writeMap(dbPath, pois, addresses);
}
