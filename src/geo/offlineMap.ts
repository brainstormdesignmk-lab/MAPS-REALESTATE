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

/** Increment when landmark eligibility, distance, or tie-breaking policy changes.
 *
 *  v4 — dormitories (and the OSM `student_accommodation` label) are ranked as
 *  institutional anchors (4), and the "Inn" type is aliased to hotel (2).
 *  Before this, a 63 m student dorm (EB 94, Пелагонија) scored rank 0 and was
 *  pushed out of the top-25 pool by shops; the row could only ever name the
 *  supermarket at the door. The bump makes every stored list stale so the feed
 *  sweep re-ranks it instead of trusting the old order. */
export const LANDMARK_RANKING_POLICY_VERSION = 4;

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
  /** Google place_id (hex pair "0x…:0x…"). When a row has NO usable
   *  coordinate, landmarkLink emits maps.google.com/?cid=<decimal> — the EXACT
   *  place card, immune to name ambiguity. With coordinates the PIN wins
   *  (2026-10-13 policy: a card names the place but shows no pin). Populated
   *  from overrides and the monthly SerpApi top-up. */
  place_id?: string;
  /** PROMINENCE (the TC Kapištec lesson): how well-known the place is.
   *  Google review count — the tie-breaker WITHIN a type tier. OSM rows
   *  carry none (they lose same-tier ties to Google anchors by design). */
  review_count?: number | null;
  rating?: number | null;
  /** 1 = Google says permanently closed / business_status closed. Still a
   *  landmark (the building stands — "кај Рамстор" works), but demoted
   *  below every open place and never an "it's open" reference. */
  closed?: number | null;
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

export type OfflineResolveSource = 'osm_building' | 'osm_interpolated' | 'osm_street_anchor' | 'osm_low_confidence';

/** Result of the instant offline property resolver, tagged with an explicit
 *  trust level. Trusted coords (osm_building / osm_interpolated) may anchor
 *  POI searches and client links. Untrusted results (osm_low_confidence)
 *  must never anchor a landmark claim — they go to the honest "населба"
 *  fallback and the async re-resolution queue geocodes them later. */
export type OfflineResolve =
  | { lat: number; lon: number; trusted: true; source: 'osm_building' | 'osm_interpolated' | 'osm_street_anchor' }
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
  ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'],  ['t', 'т'], ['u', 'у'], ['f', 'ф'], ['h', 'х'], ['c', 'ц'], ['y', 'ј'], ['zh', 'ж'],
  ['ch', 'ч'], ['sh', 'ш'],
];

// Lookup tables, built ONCE. The transliterator used to run a linear `find`
// over these arrays for every character of every string (≈15 comparisons per
// character), which made toLatin/toCyrillic the top cost of the whole POI
// index — soundKey() folds every map word through them. Same entries, same
// match ORDER (two-character slice first, then one), so the output is byte-for-
// byte what the array scan produced.
const CYR2LAT_MAP = new Map(CYR2LAT);
const LAT2CYR_MAP = new Map(LAT2CYR);

// --- Latin diacritics -------------------------------------------------------
// OSM and Google names carry Croatian/Serbian spellings ("Kapištec", "Čair",
// "Železara"). The transliterator used to pass the accented letter through
// verbatim, so the client read "Капиšтец" — half Cyrillic, half Latin, which
// reads as a broken font. Every diacritic is folded to a spelling the digraph
// table knows BEFORE the letter pass: "Kapištec" → "Kapishtec" → "Капиштец".
//
// Two folds: `digraph` produces Macedonian spelling (š → sh → ш), `ascii`
// strips to the base Latin letter for MATCHING (š → s), where the comparison
// already treats ш/с as one class (CYR2LAT maps ш → s).
const LATIN_DIACRITIC_BASE: Record<string, string> = {
  'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a', 'ā': 'a', 'ă': 'a', 'ą': 'a',
  'ç': 'c', 'ć': 'c', 'č': 'c', 'ď': 'd', 'đ': 'd',
  'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e', 'ē': 'e', 'ė': 'e', 'ę': 'e', 'ě': 'e',
  'ǵ': 'g', 'ğ': 'g',
  'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i', 'ī': 'i', 'į': 'i', 'ı': 'i',
  'ĺ': 'l', 'ļ': 'l', 'ľ': 'l', 'ł': 'l',
  'ñ': 'n', 'ń': 'n', 'ň': 'n',
  'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o', 'ø': 'o', 'ō': 'o', 'ő': 'o',
  'ŕ': 'r', 'ř': 'r',
  'ś': 's', 'š': 's', 'ş': 's', 'ș': 's', 'ß': 's',
  'ť': 't', 'ţ': 't', 'ț': 't',
  'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u', 'ů': 'u', 'ū': 'u', 'ű': 'u',
  'ý': 'y', 'ÿ': 'y',
  'ź': 'z', 'ż': 'z', 'ž': 'z',
  'ḱ': 'k',
};

// Macedonian digraph spelling for the diacritics that denote a distinct
// Macedonian letter (č = ч, not ц; š = ш, not с; ž = ж, not з).
const LATIN_DIACRITIC_DIGRAPH: Record<string, string> = {
  ...LATIN_DIACRITIC_BASE,
  'ć': 'kj', 'č': 'ch', 'đ': 'gj', 'š': 'sh', 'ž': 'zh', 'ǵ': 'gj', 'ḱ': 'kj',
  'ľ': 'lj', 'ň': 'nj', 'ř': 'r', 'ś': 's', 'ź': 'z',
};

/** Fold Latin diacritics so the Macedonian transliterator never leaves an
 *  accented Latin letter inside a Cyrillic name. Case is preserved. */
export function foldLatinDiacritics(s: string, mode: 'digraph' | 'ascii' = 'digraph'): string {
  const table = mode === 'ascii' ? LATIN_DIACRITIC_BASE : LATIN_DIACRITIC_DIGRAPH;
  let out = '';
  for (const ch of s) {
    const low = ch.toLowerCase();
    const rep = table[low];
    if (rep === undefined) { out += ch; continue; }
    out += ch === low ? rep : rep.charAt(0).toUpperCase() + rep.slice(1);
  }
  return out;
}

// Cyrillic letters the map's own contributors substitute with Latin look-alikes
// (Google/OSM rows carry "Aмбасада", "Eуpoфapм", "Блок Градски Sид", "Туpиcт").
// Inside an already-Cyrillic word these Latin letters are HOMOGLYPHS, not an
// English spelling: repairing "p" as п gives "Тупицт" while the map means
// "Турист" — the look-alike (р, с, Ѕ, А, Е, …) is the intended letter.
const LATIN_HOMOGLYPH_CYR: Record<string, string> = {
  A: 'А', B: 'Б', C: 'С', D: 'Д', E: 'Е', F: 'Ф', G: 'Г', H: 'Н', I: 'И',
  J: 'Ј', K: 'К', L: 'Л', M: 'М', N: 'Н', O: 'О', P: 'Р', Q: 'К', R: 'Р',
  S: 'Ѕ', T: 'Т', U: 'У', V: 'В', W: 'В', X: 'Х', Y: 'У', Z: 'З',
};

const CYRILLIC_CHAR_RE = /[\u0400-\u04FF]/u;
const LATIN_RE = /[A-Za-z\u00C0-\u024F]/u;
const LATIN_ACCENTED_RE = /[\u00C0-\u024F]/u;

/** Phonetic transliteration of one Latin run, keeping its capitalization
 *  pattern ("Beer" → "Беер", "beer" → "беер", "EUPOФ" stays shouty). */
function phoneticRun(run: string): string {
  const cyr = toCyrillic(run);
  if (!/[A-Z]/.test(run)) return cyr;
  if (!/[a-z]/.test(run)) return cyr.toUpperCase();
  return cyr.charAt(0).toUpperCase() + cyr.slice(1);
}

/** Repair a place name that mixes scripts. Two artifact classes, both real in
 *  the map data and in names an older build already half-transliterated:
 *
 *   1. HOMOGLYPHS glued inside a Cyrillic word ("Aмбасада", "Sид", "Туpиcт",
 *      "Eуpoфapм") — one or two substituted letters, repaired to the Cyrillic
 *      letter they stand for.
 *   2. An accented Latin letter or a real Latin WORD cut into a Cyrillic token
 *      ("Капиšтец", "Паб Beerтија") — transliterated phonetically.
 *
 *  A run that stands alone between spaces/punctuation is NOT touched: the map's
 *  bilingual rows ("Глуво куче;Gluvo Kuče", "Зен кафе (Zen Café)") are content,
 *  and a wholly Latin token is left to displayPlaceName's word pass. Wholly
 *  Cyrillic text passes untouched ("Карпош III" keeps its Roman numeral). */
export function repairMixedScript(s: string): string {
  if (!CYRILLIC_CHAR_RE.test(s) || !LATIN_RE.test(s)) return s;
  // The dominant script of the WHOLE string breaks ties inside a word that is
  // all homoglyphs ("АМSМ Bus Stop" is Latin; "Блок Градски Sид" is not).
  const totalLat = (s.match(/[A-Za-z\u00C0-\u024F]/gu) ?? []).length;
  const totalCyr = (s.match(/[\u0400-\u04FF]/gu) ?? []).length;
  const preferLatin = totalLat > totalCyr;

  // WORD by word (letters only — punctuation and spaces are boundaries, so
  // "куче;Gluvo" is two clean words, not one mixed token). The direction of
  // the repair depends on which script the word really is: "Aмбасада" is a
  // Cyrillic word with homoglyphs glued in; "Post Officе" / "Buba Мara" /
  // "AutoRentals.MК" are LATIN names with a stray Cyrillic letter — pushing
  // those into Cyrillic ("Оффице", "Мара") would invent a translation the map
  // never had.
  return s.replace(/[A-Za-z\u00C0-\u024F\u0400-\u04FF]+/gu, (word) => {
    const latinRun = /[A-Za-z\u00C0-\u024F]+/gu;
    if (!CYRILLIC_CHAR_RE.test(word) || !LATIN_RE.test(word)) return word;
    // Roman numerals are Latin BY CONVENTION in a Cyrillic address.
    if (/^[IVXLC]+$/.test(word)) return word;
    const latinLetters = (word.match(latinRun) ?? []).join('').length;
    const cyrOnly = word.match(/[\u0400-\u04FF]/gu) ?? [];
    const cyrLetters = cyrOnly.length;
    const restorable = cyrOnly.every(ch => CYRILLIC_HOMOGLYPH_LAT[ch] !== undefined);
    const ambiguous = [...word].every(ch => {
      const up = ch.toUpperCase();
      return CYRILLIC_CHAR_RE.test(ch)
        ? CYRILLIC_HOMOGLYPH_LAT[ch] !== undefined
        : LATIN_HOMOGLYPH_CYR[up] !== undefined;
    });
    // Go Latin only when the word is decisively Latin, or is all homoglyphs and
    // the surrounding name is Latin ("…AutoRentals.MК", "Buba Мara"). A near-
    // tie in a Cyrillic name is a Cyrillic word wearing Latin lookalikes
    // ("Ресторан Кej", "Eуpoфapм").
    if (restorable && (latinLetters >= cyrLetters * 2 + 1 || (ambiguous && preferLatin))) {
      return word.replace(/[\u0400-\u04FF]/gu, (ch) => CYRILLIC_HOMOGLYPH_LAT[ch] ?? ch);
    }
    // Cyrillic-majority word: repair the Latin fragments in place.
    return word.replace(latinRun, (run) => {
      if (/^[IVXLC]+$/.test(run)) return run;
      // An accented Latin letter inside a Cyrillic word is always an artifact
      // ("Капиšтец"): the diacritic must become the Macedonian letter.
      if (LATIN_ACCENTED_RE.test(run) || run.length >= 3) return phoneticRun(run);
      let out = '';
      for (const ch of run) {
        const key = ch.toUpperCase();
        const cyr = LATIN_HOMOGLYPH_CYR[key];
        if (!cyr) { out += ch; continue; }
        out += ch === key ? cyr : cyr.toLowerCase();
      }
      return out;
    });
  });
}

/** The canonical STORED/COMPARED form of a POI name: whitespace collapsed and
 *  mixed-script homoglyph artifacts healed. Applied when the map is built (so
 *  a weekly rebuild cannot reintroduce them) and on both sides of a name
 *  match (a row written by an older build must stay findable by an honest
 *  Cyrillic query). Display-only concerns stay in displayPlaceName. */
export function cleanPoiName(name: string): string {
  const s = String(name ?? '');
  // The whitespace tidy allocates; only pay for it when the row needs it
  // (this runs per row on the findPoiByName scan, ~6k rows per call).
  // [^\S ] = any whitespace that is not a plain space (tab/newline).
  const tidy = /^\s|\s$|\s{2,}|[^\S ]/.test(s) ? s.replace(/\s+/g, ' ').trim() : s;
  return repairMixedScript(tidy);
}

/** The same healing for the map's STREET names (addresses table). A street
 *  stored as "Kоце Mеталец" is just as unmatchable as a POI, and the geocoder
 *  keys on it. */
export const cleanStreetName = cleanPoiName;

// The reverse homoglyph table — Cyrillic letters that stand in for a Latin
// one inside a LATIN name ("Post Officе", "Buba Мara", "AutoRentals.MК").
// Deliberately excludes the letters a Macedonian word genuinely uses where the
// Latin reading would be wrong outside a Latin-majority token.
const CYRILLIC_HOMOGLYPH_LAT: Record<string, string> = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O',
  'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X', 'Ѕ': 'S', 'Ј': 'J', 'І': 'I',
  'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o',
  'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'ј': 'j', 'і': 'i',
};

// The embassies Skopje clients actually name — "Црногорската амбасада" vs
// the map's "Embassy of Montenegro". Bounded dictionary, not open translation.
const EMBASSY_COUNTRY_EN: Record<string, string> = {
  'црногорск': 'Montenegro', 'crnogorsk': 'Montenegro',
  'бугарск': 'Bulgaria', 'bugarsk': 'Bulgaria',
  'српск': 'Serbia', 'srpsk': 'Serbia',
  'грчк': 'Greece', 'grchk': 'Greece',
  'албанск': 'Albania', 'albansk': 'Albania',
  'турск': 'Turkey', 'tursk': 'Turkey',
  'германск': 'Germany', 'germansk': 'Germany',
  'француск': 'France', 'francusk': 'France',
  'италијанск': 'Italy', 'italijansk': 'Italy',
  'американск': 'United States', 'amerikansk': 'United States',
  'холандск': 'Netherlands', 'holandsk': 'Netherlands',
  'британск': 'United Kingdom', 'britansk': 'United Kingdom',
  'австриск': 'Austria', 'austrisk': 'Austria',
  'швајцарск': 'Switzerland', 'shvajcarsk': 'Switzerland',
  'шведск': 'Sweden', 'shvedsk': 'Sweden',
  'руск': 'Russia', 'rusk': 'Russia',
  'романск': 'Romania', 'romansk': 'Romania',
  'хрватск': 'Croatia', 'hrvatsk': 'Croatia',
  'словенечк': 'Slovenia', 'slovenechk': 'Slovenia',
  'полск': 'Poland', 'polsk': 'Poland',
  'чешк': 'Czechia', 'chechk': 'Czechia',
  'словачк': 'Slovakia', 'slovakchk': 'Slovakia',
  'украинск': 'Ukraine', 'ukrainsk': 'Ukraine',
  'шпанск': 'Spain', 'shpansk': 'Spain',
  'кинеск': 'China', 'kinesk': 'China',
  'јапонск': 'Japan', 'japonsk': 'Japan',
};

// COLLOQUIAL NAMES the city uses for a place the map files under an OFFICIAL
// one. Bounded, and every entry is vouched for by the bank's own feed text:
// EB 54's ad reads «спроти 8-ми Септември (старата воена болница)», so
// «воена болница» IS the ГОБ „8 Септември“ — the old military hospital.
// Without the rewrite the fuzzy passes bound it to «Воена академија Генерал
// Михаило Апостолски» on the shared word «воена» — a different place 5 km
// across town, named in a card the client never asked about.
const LOCAL_PLACE_ALIASES: Array<[RegExp, string]> = [
  // The target names the HOSPITAL row, never the bus stop of the same name:
  // the map carries «Болница 8ми Септември» as a bus_station and «ГОБ 8-ми
  // Септември» as the hospital itself 200 m away, and the old target string
  // was a substring of the STOP only — so the funnel measured every card from
  // a bus stop and named it as the place (the [23:34] capture).
  [/(?<![\p{L}\p{N}])(?:стара(?:та)?\s+)?(?:воена(?:та)?\s+болница|voena(?:ta)?\s+bolnica)(?![\p{L}\p{N}])/iu,
    'ГОБ 8-ми Септември'],
  // «ДРЖАВНА БОЛНИЦА» IS the УКЦ „Мајка Тереза“ complex — the state clinical
  // centre on Бул. Водњанска 17, the one Skopjani name when they mean the
  // public hospital as opposed to Систина/Аџибадем. WHY an alias (the [18:56]
  // capture 'ZDRAVO STANCE ZA PRODAVANJE KAJ DRZAVNA BOLNICA?'): the map had
  // the complex's 20 individual clinics but no row for the complex, so no
  // similarity pass could ever find it and the funnel asked the client for a
  // location he had just named. The row is now in the overrides file
  // (data/address-overrides.json → pois „Клинички центар“) and this table is
  // the bounded bridge from the colloquial name to it. Both spellings are
  // listed because the Roman fold of „државна“ is „drzavna“ in either script
  // (ж and з both fold to z), so the extractor hands over «дрзавна» as often
  // as it hands over «државна».
  // THE HOSPITAL WORD IS OPTIONAL (the [04:47] capture): the client wrote
  // «TUKA KAJ DRZAVNA BLISKU» / «KAJ DRZAVNA», the bare adjective Skopjani use
  // for the complex, and the alias demanded «болница» — so the lookup fell
  // through to the substring pass and answered with «Reptil Market br.11
  // Drzavna bolnica» (a pet shop NAMED AFTER the hospital, the only row in the
  // map carrying the word), anchoring a whole search on a shop. The adjective
  // alone is the place in this feed's vocabulary.
  [/(?<![\p{L}\p{N}])(?:државна(?:та)?|дрзавна(?:та)?)(?:\s+болниц(?:а|ата|и|у))?(?![\p{L}\p{N}])/iu,
    'Клинички центар'],
  [/(?<![\p{L}\p{N}])drzavna(?:ta)?(?:\s+bolnic(?:a|i|u))?(?![\p{L}\p{N}])/iu,
    'Клинички центар'],
  // «ГРАДСКА» ALONE IS «ГРАДСКА БОЛНИЦА» (the [20:30] capture) — the same class
  // as «државна»: the adjective is what Skopjani call the city hospital. Asked
  // bare, the map's closest row for the word was «Градска кафеана „Идадија“»,
  // a kafana, so «КОЛКУ ИМА ОД ГРАДСКА ДО СТАНОТ?» measured the flat to a
  // restaurant (and, when the flat's own word was misread as the place, to a
  // kindergarten 2,4 km away). A POI-type noun after the adjective keeps its
  // own row — «Градска кафеана», «Градска библиотека» are places in their own
  // right, and the negative lookahead is what keeps them out of this alias.
  [/(?<![\p{L}\p{N}])(?:градска(?:та)?|gradska(?:ta)?)(?:\s+(?:болниц(?:а|ата|и|у)|bolnic(?:a|ata|i|u)))?(?!\s*(?:кафеан|кафан|меан|пивниц|библиотек|книжар|аптек|управа|општин|галериј|сцена|плажа|базен|стадион)\p{L})(?![\p{L}\p{N}])/iu,
    'Градска болница'],
  // «ЕКОНОМСКОТО УЧИЛИШТЕ» IS СЕПУГС „Васил Антевски – Дрен“ — the city's
  // Средно економско-правно училиште, in Кисела Вода. WHY an alias (the [11:28]
  // capture «NA KOLKAVO RASTOJANIE SE DO EKONOMSKOTO ?» after two Кисела Вода
  // flats were listed): the map DOES hold the school, but the row's name carries
  // only the official abbreviation (СЕПУГС), so the client's words — the
  // adjective alone, «економското», or «економското сколо» — matched nothing,
  // the distance lane fell through to the LLM, and the answer was «точното
  // растојание не ми е заведено» about a place the map can measure to the
  // metre. The rewrite hands the map the abbreviation its own row is filed
  // under; the centre tie-break still picks the branch nearest the property, so
  // a flat in a different municipality does not inherit Кисела Вода's distance.
  // No open-ended translation: this is one school's official name, expanded.
  [/(?<![\p{L}\p{N}])(?:економско(?:то)?|ekonomsko(?:to)?)(?:\s+(?:училиште|училиштето|сколо|школо|uciliste|ucilisteto|skolo|shkolo|school))?(?![\p{L}\p{N}])/iu,
    'СЕПУГС'],
];

/** SECOND NAMES FOR THE SAME ALIAS TARGET, tried only when the canonical row is
 *  absent from this map snapshot. A map files an institution under whatever its
 *  source called it: the live map carries the old military hospital as «ГОБ
 *  8-ми Септември» (hospital) and only its bus STOP as «Болница 8ми
 *  Септември», while an older/synthetic snapshot carries the hospital under
 *  that second name. The canonical target stays canonical — this list is the
 *  fallback, and a TRANSIT row is never accepted from it (a stop is named after
 *  the place it serves; taking one was the [23:34] capture). */
const LOCAL_PLACE_ALIAS_FALLBACKS: Record<string, string[]> = {
  'ГОБ 8-ми Септември': ['Болница 8ми Септември'],
};

/** The map's OFFICIAL name for a colloquial one the client used, when the
 *  bounded table knows it. `undefined` for everything else — no open-ended
 *  translation. Callers use it to skip name-similarity guards: an explicit
 *  alias is the client's own name for that place, not a fuzzy guess. */
export function officialPlaceName(name: string): string | undefined {
  const clean = (name ?? '').replace(/^(?:кај|спроти|как|кај штипски|кај скопски)\s+/i, '').trim();
  if (!clean) return undefined;
  for (const [re, official] of LOCAL_PLACE_ALIASES) if (re.test(clean)) return official;
  return undefined;
}

// ── THE SCHOOL-NAME BRIDGE ──────────────────────────────────────────────────
// The map files schools the way the registry does: under an abbreviation
// (СЕПУГС, СУГС, ООУ, ДСУ) or with the type as an ADJECTIVE («Медицинско
// училиште»). Clients say neither — they write the adjective in the definite
// form and drop the noun: «медицинското», «хемиското», «угостителското»,
// «економското». Every one of those MISSED the map before this table: the
// definite suffix (…-ото/…-ата) is part of the name as typed, so no substring
// pass could see the row's bare stem, and with the noun elided there was no
// word to match at all — the distance/where lanes fell through and the client
// was told the place was unknown.
//
// Bounded on purpose: only the school-type stems Macedonian actually uses are
// completed, and only with «училиште»/«гимназија». An arbitrary adjective never
// becomes a school.
const SCHOOL_TYPE_STEMS: Array<[RegExp, string]> = [
  [/^медицинск/u, 'медицинско'],
  [/^хемиск/u, 'хемиско'],
  [/^економск/u, 'економско'],
  [/^угостителск/u, 'угостителско'],
  [/^музичк/u, 'музичко'],
  [/^балетск/u, 'балетско'],
  [/^градежн/u, 'градежно'],
  [/^земјоделск/u, 'земјоделско'],
  [/^шумарск/u, 'шумарско'],
  [/^правн/u, 'правно'],
  [/^текстилн/u, 'текстилно'],
  [/^прехранбен/u, 'прехранбено'],
  [/^сообраќајн/u, 'сообраќајно'],
  [/^машинск/u, 'машинско'],
  [/^електротехничк/u, 'електротехничко'],
  [/^геодетск/u, 'геодетско'],
  [/^спортск/u, 'спортско'],
  [/^математичк/u, 'математичко'],
  [/^филолошк/u, 'филолошко'],
  [/^уметничк/u, 'уметничко'],
  [/^балетск/u, 'балетско'],
];

/** The definite article off ONE word — as the stem the map indexes, not as a
 *  chopped-off fragment. The article is only the LAST two letters when a VOWEL
 *  precedes it («медицинско-то» → «медицинско», never «медицинск»); «-от» is
 *  the one that follows a consonant. «-иот» is three letters. A stem is never
 *  taken below 4 letters («тато» must not become «та»). */
function dropDefiniteSuffix(word: string): string {
  const w = word.trim();
  const low = w.toLowerCase();
  const cut = (n: number): string => (w.length - n >= 4 ? w.slice(0, -n) : w);
  if (/иот$/u.test(low)) return cut(3);        // «градежниот» → «градежн»
  if (/[аеиоу]то$/u.test(low)) return cut(2);  // «медицинското» → «медицинско»
  if (/[аеиоу]та$/u.test(low)) return cut(2);  // «медицинската» → «медицинска»
  if (/[аеиоу]те$/u.test(low)) return cut(2);  // «медицинските» → «медицински»
  if (/[^аеиоу\s]от$/u.test(low)) return cut(2); // «училиштет»-style leftovers
  return w;
}

/** Alternative needles for a SCHOOL the client named in their own words, tried
 *  only AFTER the exact passes have missed (never in place of them).
 *
 *  The two shapes it repairs, both from real captures:
 *    «МЕДИЦИНСКОТО УЧИЛИШТЕ» → «медицинско училиште»   (definite article)
 *    «економското»          → «економско училиште»     (elided noun)
 *  Order is by fidelity: the article strip first, then the completed forms. */
export function schoolQueryForms(name: string): string[] {
  const base = (name ?? '').trim();
  if (base.length < 4) return [];
  const seen = new Set([base.toLowerCase()]);
  const out: string[] = [];
  const add = (s: string): void => {
    const t = s.replace(/\s+/g, ' ').trim();
    const k = t.toLowerCase();
    if (t.length < 4 || seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  const words = base.split(/\s+/);
  const bare = words.map(dropDefiniteSuffix).join(' ');
  add(bare);
  // THE ELIDED NOUN: the last word is a school-type adjective in any gender.
  const last = bare.split(/\s+/).slice(-1)[0] ?? '';
  const lastCyr = /[\u0400-\u04FF]/u.test(last) ? last : toCyrillic(last);
  for (const [re, stem] of SCHOOL_TYPE_STEMS) {
    if (!re.test(lastCyr.toLowerCase())) continue;
    const head = bare.split(/\s+/).slice(0, -1).join(' ');
    for (const noun of ['училиште', 'гимназија']) {
      add(`${head} ${stem} ${noun}`);
      add(`${stem} ${noun}`);
    }
    add(stem);
    break;
  }
  return out;
}

/** A PART OF A VENUE, NOT THE VENUE: «Food Court», «Apteka», «Parking»,
 *  «Store»… A map row named «City Mall Food Court» starts with the needle
 *  «city mall» and beat «Skopje City Mall» on that alone, so a client who
 *  named the mall was told about its food court. */
const VENUE_PART_WORDS = new Set([
  'food', 'court', 'apteka', 'аптека', 'parking', 'паркинг', 'booth',
  'store', 'shop', 'outlet', 'office', 'канцеларија', 'entrance', 'влез',
  'kasa', 'каса', 'restoran', 'ресторан', 'kafic', 'кафич',
]);

/** WHAT KIND OF PLACE a name says it is — a bounded category table used as a
 *  HARD identity guard, never as a ranking signal.
 *
 *  WHY (the [15:36] capture): the client asked for a flat near «VOENA BOLNICA»
 *  (the old military HOSPITAL). The colloquial-name table rewrites that to the
 *  map's own «Болница 8ми Септември», but if that row is ever missing the fuzzy
 *  passes below would fall back to the words the two names share («воена») and
 *  answer with «Воена академија Генерал Михаило Апостолски» — a different
 *  institution five kilometres across town, served in a card the client never
 *  asked about. A hospital can never become an academy, a mall can never
 *  become a church: when the client's phrase names a CATEGORY and the candidate
 *  row names a DIFFERENT one, the row is not the place. Rows with no category
 *  word of their own (an acronym, a bare brand) are never vetoed — the guard
 *  only fires on a CONTRADICTION, so it cannot invent a miss where none exists.
 */
const CATEGORY_STEMS: Array<[string, string]> = [
  // medical
  ['bolnic', 'medical'], ['hospital', 'medical'], ['klinik', 'medical'], ['klinick', 'medical'],
  ['ambulant', 'medical'],
  // academic (a military ACADEMY is not a military hospital)
  ['akademij', 'academic'], ['academy', 'academic'], ['akademsk', 'academic'],
  // education
  ['ucilist', 'education'], ['gimnazij', 'education'], ['univerzitet', 'education'],
  ['fakultet', 'education'], ['university', 'education'], ['school', 'education'],
  ['colege', 'education'], ['college', 'education'],
  // place of worship
  ['crkv', 'worship'], ['church', 'worship'], ['katedral', 'worship'], ['manastir', 'worship'],
  ['dzamij', 'worship'], ['mosque', 'worship'],
  // retail
  ['trgovski', 'retail'], ['shopping', 'retail'], ['market', 'retail'], ['pazar', 'retail'],
  ['supermarket', 'retail'], ['mall', 'retail'],
  // finance / government
  ['banka', 'finance'], ['bank', 'finance'],
  ['opstina', 'government'], ['municipality', 'government'], ['sobranie', 'government'],
  ['assembly', 'government'], ['policij', 'government'], ['police', 'government'],
  ['posta', 'government'], ['postoffice', 'government'],
  // hospitality / culture / sport
  ['hotel', 'hospitality'], ['motel', 'hospitality'], ['kafe', 'hospitality'],
  ['cafe', 'hospitality'], ['kafic', 'hospitality'], ['restoran', 'hospitality'],
  ['restaurant', 'hospitality'],
  ['muzej', 'culture'], ['museum', 'culture'], ['teatar', 'culture'],
  ['theatre', 'culture'], ['theater', 'culture'], ['pozorist', 'culture'],
  ['stadion', 'sport'], ['stadium', 'sport'], ['arena', 'sport'],
  // other institutions
  ['apotek', 'pharmacy'], ['pharmacy', 'pharmacy'],
  // «аптека» is the standard Macedonian spelling (the table only knew the
  // Serbian «апотека»), and it is exactly the class noun a lone needle must be
  // refused as — a bare «кај аптеката» names no pharmacy.
  ['aptek', 'pharmacy'],
  ['ambasad', 'embassy'], ['embassy', 'embassy'],
  ['park', 'park'], ['gradin', 'park'],
  ['skol', 'education'], ['pekara', 'bakery'], ['bakery', 'bakery'],
];

/** Short words that are categories only as WHOLE words ("mol" is a mall, but
 *  "molim" is «please»; "tc" is a shopping centre, "post" is a post office
 *  while «postoi» is not one). */
const CATEGORY_EXACT: Record<string, string> = {
  mol: 'retail', moll: 'retail', molot: 'retail', tc: 'retail',
  post: 'government', posta: 'government', skola: 'education', skoloto: 'education',
  crkva: 'worship', crkvata: 'worship', park: 'park', parkot: 'park',
};

/** The bounded CATEGORY of a place name, or undefined when its words name no
 *  institution this table knows. Latin-folded, so Cyrillic and the client's own
 *  spelling land on the same stems. */
export function placeCategory(name: string): string | undefined {
  const words = toLatin(name).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  for (const w of words) {
    const exact = CATEGORY_EXACT[w];
    if (exact) return exact;
    for (const [stem, cat] of CATEGORY_STEMS) if (w.startsWith(stem)) return cat;
  }
  return undefined;
}

/** A SHOP IS NOT A PLACE, AND A SHOP INSIDE A MALL IS THE MALL.
 *
 *  The owner's rule (the EB 53 card): a card told the client the flat «Се
 *  наоѓа во близина на Butik Galion» — a boutique 35 m away and INSIDE ТЦ
 *  Бисер. Nobody navigates by a boutique, and the feed had typed it «Shopping
 *  mall», so every type-rank in the engine treated it as a first-class complex
 *  and it took the first rotation slot. ТЦ Бисер is the place a client knows.
 *
 *  The rule is GLOBAL: a candidate whose own name marks it as a shop/boutique
 *  is never a nearby landmark. When it sits inside a complex, the complex is
 *  served in its place (enclosingComplex); when it does not, it is dropped —
 *  the honest neighborhood line beats a name nobody recognises. Matched on the
 *  FIRST WORD only („Shopping Center Capitol Mall“ is a complex, „Shop …“ is
 *  not) and on the small-shop Google/OSM types. Markets and pharmacies are
 *  deliberately NOT here: „кај Тинекс“ and „кај аптеката“ are how people give
 *  directions. */
const SHOP_FIRST_WORDS = new Set([
  'butik', 'butika', 'butikot', 'boutique', 'бутик', 'shop', 'shoppe', 'шоп',
  'store', 'стор', 'kiosk', 'киоск', 'dukjan', 'dukan', 'дуќан', 'дуќанот',
  'trafika', 'трафика', 'frizerski', 'фризерски', 'frizer', 'фризер',
]);
const SHOP_TYPES = new Set([
  'clothing store', 'clothes store', 'clothing', 'clothes', 'shoe store',
  'shoes', 'jewelry store', 'jewelry', 'jewellery', 'gift shop', 'toys',
  'book store', 'bookstore', 'hardware store', 'convenience store',
  'boutique', 'butik', 'store', 'shop', 'kiosk', 'variety store',
  // A LISTING IS NOT A LANDMARK (the [08:46] capture): the map holds «Apartmani
  // Skopje» filed as a Holiday apartment — a rental listing, not a place a
  // client navigates by. The client's own word «APARTMAN» (his property TYPE)
  // matched it and the whole search was anchored on a holiday flat in Центар,
  // a kilometre away from the Аеродром block he had actually named.
  'holiday apartment', 'apartment hotel listing',
]);

// ── WORDS THAT ARE NEVER A PLACE ON THEIR OWN ──────────────────────────────
// The [23:00] capture: „GLEDAV EDEN STAN KAJ VAS NA SAJT KAJ SJO“. The wish
// extractor's grammar tail «САЈТ» (on your SITE) reached the fuzzy lookup and
// came back as the bakery «Жито» — and a bare «стан» comes back as «Станица
// Парк» (it merely STARTS the name). Nobody had said Жито or Капиштец, yet the
// whole serve was built from it: „Разбрав — значи баравте стан во близина на
// Жито (Капиштец)“. A SINGLE everyday word is not a venue; the veto is
// word-exact and single-token, so «Сајт Комплекс» or «Станбен блок» still
// resolve normally.
const NOT_A_PLACE_ALONE = new Set([
  // web / page
  'sajt', 'сајт', 'sajtot', 'сајтот', 'sajtovi', 'сајтови',
  'stranica', 'страница', 'stranicata', 'страницата', 'stranata', 'страната',
  'oglas', 'оглас', 'oglasot', 'огласот', 'oglasite', 'огласите',
  'agencija', 'агенција', 'agencijata', 'агенцијата',
  // the listing itself
  'stan', 'стан', 'stanot', 'станот', 'stanovi', 'станови', 'stanche', 'станче',
  'kukja', 'куќа', 'kukjata', 'куќата', 'kuki', 'куќи',
  'garsonjera', 'гарсоњера', 'garsonjerata', 'гарсоњерата',
  'lokal', 'локал', 'lokalot', 'локалот', 'deloven', 'деловен',
  'plac', 'плац', 'placot', 'плацот',
  'dukjan', 'дуќан', 'mesto', 'место', 'grad', 'град',
  // THE WHOLE PROPERTY FAMILY (the [08:46] capture): «APARTMAN» — the client's
  // answer to the TYPE question — reached the map and came back as the holiday
  // listing «Apartmani Skopje»; the anchor, the derived district (Центар) and
  // every later distance were built on a place he had never named, and his own
  // «VO AERODROM ZATOA TI REKOV KAJ TRI BISERI» had to fight it. Every type a
  // client can answer that question with is here, both scripts and the plural/
  // definite forms: the words of THIS business are never a venue on their own.
  'apartman', 'апартман', 'apartmani', 'апартмани', 'apartmanot', 'апартманот',
  'apartmanite', 'апартманите', 'apartment', 'apartments',
  'dupleks', 'дуплекс', 'kotek', 'котек', 'vila', 'вила', 'vili', 'вили',
  'garaza', 'гаража', 'garazhi', 'гаражи', 'garazata', 'гаражата',
  'magacin', 'магацин', 'magacinot', 'магацинот',
  'kancelarija', 'канцеларија', 'kancelarijaта', 'канцеларијата',
  'zemjiste', 'земјиште', 'zemjisteto', 'земјиштето',
  'nedviznost', 'недвижност', 'nedviznosta', 'недвижноста',
  'imov', 'имот', 'imot', 'imotot', 'имотот', 'soba', 'соба', 'sobi', 'соби',
  // money / time vocabulary the prepositions also open („до 250“, „околу“)
  'cena', 'цена', 'cenata', 'цената', 'evra', 'евра', 'evro', 'евро',
  'denari', 'денари', 'kirija', 'кирија', 'mesecno', 'месечно',
  // CLOSED-CLASS WORDS (the «DRUGI» capture): the client typed «DRUGI»
  // ("other", answering a served pair) and the map returned «ПОУ „Драга
  // Стојановска“ - с. Сопиште» — the vowel-stripped sound key of both is «drg»
  // — so a school in Сопиште became the search anchor for two turns and every
  // card was measured from a place nobody had named. Pronouns, quantifiers,
  // ordinals and the "another" family are NEVER a venue name on their own; the
  // veto is word-exact and single-token, so a real name that merely CONTAINS
  // one («Другарче», «Три Бисери», «Две капки») still resolves when the client
  // says the whole name.
  'drug', 'drugi', 'drugiot', 'druta', 'druga', 'drugata', 'drugo', 'drugoto',
  'drugite', 'друг', 'други', 'другиот', 'друга', 'другата', 'друго', 'другото',
  'другите', 'друѓи', 'ostanato', 'останато', 'останатото', 'ostanati', 'останати',
  'ostanatiot', 'останатиот', 'ostanata', 'останатата',
  'sekoj', 'sekoja', 'sekoe', 'sekој', 'секој', 'секоја', 'секое', 'site', 'сите',
  'nekoj', 'nekoja', 'nekoe', 'nekoi', 'некој', 'некоја', 'некое', 'некои',
  'bilo', 'било', 'koj', 'koja', 'koe', 'koi', 'кој', 'која', 'кое', 'кои',
  'shto', 'што', 'ova', 'ovoj', 'ovaa', 'ova', 'ова', 'овој', 'оваа',
  'toa', 'toj', 'taa', 'тоа', 'тој', 'таа', 'isti', 'istiot', 'ista', 'istata',
  'isto', 'istoto', 'исти', 'истиот', 'иста', 'истата', 'исто', 'истото',
  'prv', 'prva', 'prvo', 'vtor', 'vtora', 'vtoro', 'tret', 'treta', 'treto',
  'прв', 'прва', 'прво', 'втор', 'втора', 'второ', 'трет', 'трета', 'трето',
  'eden', 'edna', 'edno', 'dva', 'dve', 'tri', 'eden', 'еден', 'една', 'едно',
  'два', 'две', 'три', 'cetiri', 'четири',
]);

/** True when the needle is ONE everyday word that can never name a place.
 *
 *  A CLASS NOUN ALONE IS NEVER A LANDMARK (the [23:34] capture): the wish
 *  extractor trims a place name to its last word, so «KAJ VOENA BOLNICA» also
 *  offered the candidate «BOLNICA», which resolved to the shortest map row
 *  carrying that word — «Болница за зависности», 4 km across town. The turn's
 *  copy named the military hospital while the anchor slot held the addiction
 *  clinic, and every later card was measured from the wrong place. A bare
 *  «болница/мол/црква/училиште/амбасада/пазар…» names a KIND, not a place: the
 *  client who really means one says WHICH one. placeCategory() already knows
 *  that vocabulary, so the veto is the same bounded table — no new list.
 *
 *  EXCEPT WHERE THE BARE WORD IS THE NAME. placeCategory() answers «what KIND
 *  of place is this word», never «how many of them are there» — and the
 *  Assembly («Собрание на Република Македонија») is ONE building whose name is
 *  the ordinary word for it. Vetoing that class word refused the place a
 *  client actually names («кај Собрание»), and the four-place rotation lost its
 *  fourth place to a miss. */
const CLASS_NOUN_IS_A_NAME = new Set(['sobranie', 'собрание', 'assembly', 'скупштина']);
export function refusesGenericNeedle(clean: string): boolean {
  const words = clean.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length !== 1) return false;
  if (NOT_A_PLACE_ALONE.has(words[0])) return true;
  if (CLASS_NOUN_IS_A_NAME.has(words[0])) return false;
  return placeCategory(words[0]) !== undefined;
}

/** True when a name/type says SHOP, not a place a client navigates by. */
export function isShopLevelPlace(name: string, type?: string | null): boolean {
  const first = toLatin(String(name ?? '')).trim().split(/\s+/)[0] ?? '';
  if (SHOP_FIRST_WORDS.has(first)) return true;
  return SHOP_TYPES.has(normType(type));
}

/** The transit class — a STOP is named AFTER the place it serves. */
const TRANSIT_TYPES = new Set([
  'bus_station', 'bus_stop', 'bus station', 'bus stop',
  'tram_station', 'tram_stop', 'tram station', 'tram stop',
]);

/** True when the row is a bus/tram stop rather than a place. */
export function isTransitPlace(type?: string | null): boolean {
  return TRANSIT_TYPES.has(normType(type));
}

/** The SERVICE-POINT class — a cash machine or a bank branch is a tenant of
 *  the place it is named after, never the place itself.
 *
 *  THE [04:46] CAPTURE: «A DO LEPTOKARIJA ?» was answered «NLB Bank ATM
 *  Leptokarija се наоѓа на 260 метри» — an ATM INSIDE the mall the client meant.
 *  Both rows are `contains` matches for the needle, so the distance tie-break
 *  decided, and the ATM sits 160 m nearer the flat than «ТЦ Лептокарија». A
 *  client measuring to «Лептокарија» means the centre, exactly as he means the
 *  mall and not one of its shops (the tenant rule in findPoiByNameCore).
 *
 *  A service point steps aside only when a real PLACE also matches — a chat
 *  that names «кај Комерцијална банка» keeps its branch. */
const SERVICE_POINT_TYPES = new Set([
  'atm', 'bank', 'bureau_de_change', 'money_transfer', 'currency_exchange',
]);

/** True when the client's own words name transit (then a stop IS the answer). */
const ASKS_TRANSIT_RE = /(автобус|трамвај|bus\b|tram\b|станица|stanica|stop\b)/iu;

/** True when a name reads as a COMPLEX/centre rather than a tenant inside one. */
/** Minimum letters for a PARTIAL (word-prefix) map-name match. A two- or
 *  three-letter vocabulary word can only ever be a coincidence: the [19:46]
 *  capture asked «А ВО КОЈА НАСЕЛБА ИМА?» and the substring pass bound the verb
 *  «има» to «Image Plus» (same for «нема»→«Cinematheque of Macedonia»,
 *  «имате»→«Primatex», «да»→«ДАЛЕКС»). Whole-wordmatches keep working for
 *  real acronyms («ГТЦ», «ТЦ»). */
export const PARTIAL_NAME_MIN_LEN = 4;

/** Minimum letters for the last-resort phonetic/variant/typo passes: below
 *  this the fold is guessing (the phonetic pass bound «moze» to «Mezzo»).
 *  Genuinely short names still resolve through the exact/whole-word passes. */
export const FUZZY_NAME_MIN_LEN = 5;

/** A partial name hit that respects WORD BOUNDARIES. `haystack` is a folded
 *  map form (lowercase Latin or Cyrillic), `needle` the client's own words.
 *
 *  Rules, from strongest to weakest:
 *   • the needle is a WHOLE word of the haystack (any length ≥3) — «ГТЦ» in
 *     «Градски трговски центар (ГТЦ)». Two letters are never a name: «да» sits
 *     as a whole word inside «Ми-Да Гранд Моторс», and a bare «тц» is answered
 *     by the exact name pass, never by this one;
 *   • the needle STARTS a word and is long enough to be meaningful (≥4) —
 *     «капи» in «Капиштец», «лепто» in «Лептокарија»;
 *   • the needle starts the whole name and is ≥4 — same contract.
 *  A match that sits INSIDE a longer word is never taken: that is how
 *  «нема» matched «ci-nema-theque» and «имате» matched «pri-mate-x». */
export function wordAlignedHit(haystack: string, needle: string): boolean {
  if (!haystack || !needle || needle.length < 3) return false;
  const isWordChar = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}]/u.test(ch);
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    const startsWord = !isWordChar(i === 0 ? undefined : haystack[i - 1]);
    if (startsWord) {
      const endsWord = !isWordChar(haystack[i + needle.length]);
      if (endsWord) return true;
      if (needle.length >= PARTIAL_NAME_MIN_LEN) return true;
    }
    i = haystack.indexOf(needle, i + 1);
  }
  return false;
}

/** Function words — a query made ONLY of these names no place. Kept as its
 *  own list (not the map's STOPWORDS, which are place-preposition glue): these
 *  are the verbs, particles and question words a client wraps a request in,
 *  and handing any of them to the lookup is guessing. The [19:46] sweep found
 *  the map answering «ИМА»→«Image Plus», «НЕМА»→«Cinematheque of Macedonia»,
 *  «ИМАТЕ»→«Primatex», «ДА»→«Ми-Да Гранд Моторс», «MOZE»→«Mezzo». */
const GRAMMAR_WORDS = new Set([
  'има', 'имал', 'имала', 'имале', 'имаме', 'имате', 'имаат',
  'нема', 'немаше', 'немате',
  'да', 'не', 'ли', 'е', 'се', 'и', 'а', 'или', 'што', 'сто', 'каде', 'кде',
  'кој', 'која', 'кое', 'кои', 'колку', 'како', 'зошто',
  'може', 'можам', 'можете', 'можат', 'мора', 'морам', 'морате', 'би', 'ќе',
  'знам', 'знаете', 'сум', 'си', 'сме', 'сте', 'сакам', 'сакате', 'барам', 'треба',
  'ima', 'imal', 'imala', 'imale', 'imame', 'imate', 'imaat',
  'nema', 'nemase', 'nemate',
  'da', 'ne', 'li', 'e', 'se', 'i', 'a', 'ili', 'sto', 'kade', 'kde',
  'koj', 'koja', 'koe', 'koi', 'kolku', 'kako', 'zosto',
  'moze', 'mozam', 'mozete', 'mozat', 'mora', 'moram', 'morate', 'bi', 'ke',
  'znam', 'znaete', 'sum', 'si', 'sme', 'ste', 'sakam', 'sakate', 'baram', 'treba',
]);

/** True when the query carries NO name at all — every word is a function word. */
export function isGrammarOnlyQuery(name: string): boolean {
  const words = cleanPoiName(String(name ?? ''))
    .toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return true;
  return words.every(w => GRAMMAR_WORDS.has(w) || STOPWORDS.has(w)
    || GRAMMAR_WORDS.has(stripDefinite(w)) || STOPWORDS.has(stripDefinite(w)));
}

export function isComplexName(name: string): boolean {
  const words = toLatin(String(name ?? '')).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.some(w => w === 'tc' || w === 'mall' || w === 'mol' || w === 'mallot'
    || w === 'centar' || w === 'center' || w === 'centre' || w === 'trgovski');
}

export function toLatin(s: string): string {
  let out = '';
  for (const ch of foldLatinDiacritics(s.toLowerCase(), 'ascii')) {
    out += CYR2LAT_MAP.get(ch) ?? ch;
  }
  return out;
}

export function toCyrillic(s: string): string {
  const low = foldLatinDiacritics(s.toLowerCase());
  let out = '';
  let i = 0;
  while (i < low.length) {
    const two = LAT2CYR_MAP.get(low.slice(i, i + 2));
    if (two) { out += two; i += 2; continue; }
    out += LAT2CYR_MAP.get(low[i]) ?? low[i];
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
/** Cyrillic → Latin spelling (the display/matching form: ж → zh, ч → ch).
 *  The table is module-level: it was re-allocated on every call, and this is
 *  the hottest transliterator in the geo layer (every map row, every word). */
const TRANSLIT_TO_LATIN: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'ѓ': 'gj', 'е': 'e', 'ж': 'zh', 'з': 'z',
  'ѕ': 'dz', 'и': 'i', 'ј': 'j', 'к': 'k', 'л': 'l', 'љ': 'lj', 'м': 'm', 'н': 'n', 'њ': 'nj',
  'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'ќ': 'kj', 'у': 'u', 'ф': 'f', 'х': 'h',
  'ц': 'c', 'ч': 'ch', 'џ': 'dzh', 'ш': 'sh',
};

export function translitToLatin(s: string): string {
  let out = '';
  for (const c of foldLatinDiacritics(s.toLowerCase())) out += TRANSLIT_TO_LATIN[c] ?? c;
  return out;
}

/** Tolerant name key: transliterate + lowercase + strip punctuation/spaces.
 *  Deliberately does NOT strip meaningful words — "Kipper" vs
 *  "Kipper Market - Butel" are different branches and must stay distinct. */
export function normName(s: string): string {
  return translitToLatin(s).replace(/[^a-z0-9]/g, '');
}

/** The PHONETIC word keys of a name — the Latin spelling a Macedonian client
 *  actually types, in WHICH SCRIPT the map happens to store.
 *
 *  WHY this exists (the [16:11] «VO BLIZINA NA KATOLICKA» capture): a client
 *  writing Macedonian sounds in Latin spells ч as c — «Katolicka» — while the
 *  engine's own transliterator emits the "ch" spelling (translitToLatin:
 *  ч → ch). Character-level matching therefore compared «katolicka» against
 *  «katolichka» and MISSed, the church never got coordinates, and no flat near
 *  it could ever be ranked. toLatin() folds the CYRILLIC side onto the
 *  c/s/z spelling the client used (ч → c, ш → s, ж → z, ѕ/џ → dz, ѓ → gj,
 *  ќ → kj); this key does the same for the LATIN respellings clients type, so
 *  «Католичка», «Katolicka», «Katolichka» and the extractor's own «католицка»
 *  all land on ONE word key. Same for «Штип»/«Shtip»/«Stip» and
 *  «Буњаковец»/«Bunjakovets»/«Bunjakovec». Words shorter than 3 letters are
 *  dropped (they carry no place identity). */
export function phoneticWordKeys(name: string): string[] {
  const t = toLatin(name).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  // Longest digraphs first: "dzh" must fold before "zh" sees its tail.
  const fold = (w: string): string => w
    .replace(/dzh/g, 'dz')
    .replace(/sh/g, 's')
    .replace(/zh/g, 'z')
    .replace(/ch/g, 'c')
    .replace(/ts/g, 'c')
    .replace(/dz/g, 'z')
    .replace(/gj/g, 'g')
    .replace(/kj/g, 'k')
    .replace(/lj/g, 'l')
    .replace(/nj/g, 'n');
  return [...new Set(t.split(' ').filter(w => w.length >= 3).map(fold))];
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

// ── ONE SPELLING PER WORD (the name-variant fold) ──────────────────────────
// A Skopje place name is written three ways at once: as the operator types it
// („Сити Мол“), as OSM/Google hold it („Skopje City Mall“), and as the client
// says it out loud in Roman letters („CITY MOL“). Character-level comparison
// sees three different words, so the coverage guard threw away the map's own
// place three captures in a row: [18:34] CITY MALL (script), [20:49] CITY MOL
// (spelling family).
//
// THE FOLD: every word goes through toLatin → lowercase → the c→k bridge (the
// one the guard already used, so „Broz Cafe“/„broz kafe“ still agree), and the
// result is looked up in this table. The table is SEEDED with the families that
// already cost us captures and COMPLETED at build time from
// data/name-variants.json — pairs harvested from the map itself (co-located
// Latin and Cyrillic rows), reviewed, and loaded via loadNameVariants(). It is
// word-level by construction: a variant can never rename a PLACE, only say
// that two spellings are the same word.
/** THE SOUND SKELETON of a word — the key that makes „City“, „Siti“ and
 *  „сити“ the same word, without a dictionary of every place in Skopje.
 *
 *  WHY (three captures, one cause — [18:34], [18:47], [20:49]): a Skopje name
 *  is written three ways at once — the operator's Cyrillic („Сити Мол“), the
 *  map's English („Skopje City Mall“) and the client's Roman letters („CITY
 *  MOL“). Character comparison sees different words, and every hand-written
 *  list of spelling pairs only fixes the pairs somebody already lost money on.
 *
 *  The skeleton keeps the consonants, folds the consonant letters that mark the
 *  same sound (c before e/i = s, v = f, z = s, q/x/ph/ck, and the Macedonian
 *  latin digraphs sh/zh/ch/dz/gj/kj/lj/nj), drops vowels and h, and collapses
 *  doubled letters. „city“→st, „siti“→st · „mall“→ml, „mol“→ml · „centar“ and
 *  „center“→sntr · „Kipper“ and „Kiper“→kpr · „Broz“ and „Bроз“→brs. It is
 *  applied ONLY where a lookup/coverage test needs a same-word answer, never
 *  for display, and it can only ever MERGE spellings — an unknown word keeps
 *  its own skeleton, so nothing is invented. */
export function soundKey(input: string): string {
  let w = toLatin(String(input ?? '')).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!w) return '';
  // Digits are identity („Бит Пазар 1“ ≠ „Бит Пазар 2“) — kept verbatim.
  const digits = w.replace(/[^0-9]/g, '');
  w = w.replace(/[0-9]/g, '');
  if (!w) return digits;
  w = w
    // Macedonian latin spellings first (longest digraphs first).
    .replace(/dzh/g, 'dz').replace(/sh/g, 's').replace(/zh/g, 'z').replace(/ch/g, 'c')
    .replace(/ts/g, 'c').replace(/dz/g, 'z').replace(/gj/g, 'g').replace(/kj/g, 'k')
    .replace(/lj/g, 'l').replace(/nj/g, 'n')
    // English digraphs / letters with one sound.
    .replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/qu/g, 'k').replace(/x/g, 'ks')
    .replace(/v/g, 'f').replace(/z/g, 's').replace(/q/g, 'k');
  w = w.replace(/([a-z])\1+/g, '$1');
  let out = '';
  for (let i = 0; i < w.length; i++) {
    const ch = w[i];
    if (ch === 'c') { out += 'ei'.includes(w[i + 1] ?? '') ? 's' : 'k'; continue; }
    // Vowels and the glides w/y carry no skeleton („tower“ ≡ „тауер“).
    if ('aeiouwy'.includes(ch)) continue;
    if (ch === 'h') continue;
    // J IS THE SAME GLIDE INSIDE A WORD (the [21:45] «DAJMOND MOL» capture):
    // «дајмонд»/«dajmond» is how a client spells the map's «Diamond», and a j
    // keeps no sound there. Left in the skeleton it made «dajmond» (djmnd) and
    // «diamond» (dmnd) two different words, so «ДАЈМОНД МОЛ» could not bind the
    // map's own «Diamond Mall» — it bound the bookstore whose Cyrillic name
    // carries «дајмонд мол» verbatim, the guard refused the tenant, and the
    // client was told there was no data around a mall two streets away.
    // ONLY INSIDE a word: a leading j is a real letter („Јоле“/„Jole“ keeps it),
    // so this can merge spellings of one name but not two names.
    if (ch === 'j' && i > 0) continue;
    out += ch;
  }
  return (out + digits).slice(0, 8);
}
const NAME_VARIANT_SEED: Record<string, string> = {};
let NAME_VARIANTS: Record<string, string> = { ...NAME_VARIANT_SEED };
/** Install the harvested variant table (data/name-variants.json). Merged over
 *  the seed, so removing a pair from the file falls back to the seed, never to
 *  a stale value. Called by OfflineMapStore on open, when the map carries a
 *  name_variants table (apply_overrides.ts writes it). */
export function loadNameVariants(pairs: Iterable<[string, string]>): void {
  const t: Record<string, string> = { ...NAME_VARIANT_SEED };
  for (const [from, to] of pairs) if (from && to && from !== to) t[from] = to;
  NAME_VARIANTS = t;
  // The canonical-key memo bakes the variant table into its answers.
  CANON_CACHE.clear();
}
/** The canonical key of ONE folded word (``toLatin``+c→k space). Unknown words
 *  are their own key, so this fold can only ever MERGE spellings, never invent
 *  a match. Also the key the harvest writes pairs in. */
export function nameWordKey(folded: string): string {
  return NAME_VARIANTS[folded] ?? folded;
}
/** ONE EDIT APART — the typo budget. Damerau-Levenshtein ≤ 1: a dropped
 *  letter, a doubled letter, a swapped pair or a single substitution.
 *  „karpš“/„karpoš“, „bulnica“/„bolnica“. */
export function editWithinOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    // one substitution, or one adjacent transposition
    const rest = a.slice(i + 1), restB = b.slice(i + 1);
    if (rest === restB) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  // one insertion/deletion
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** Are two words the SAME WORD up to one typo? Compared on the RAW words
 *  (transliterated, lowercased) — NOT on the sound key: the key is deliberately
 *  compressed, so one edit there is often a different word altogether
 *  («Пелитер» vs «Култура» share a skeleton shape, «Пелитер» vs «Пелистер» share
 *  almost every letter). The budget only opens on words of five letters or more,
 *  and the FIRST LETTER must agree — a slip at the start of a name is how a
 *  completely different place is reached. */
export function wordsAlmostEqual(a: string, b: string): boolean {
  const na = toLatin(String(a ?? '')).toLowerCase().replace(/[^a-z0-9]/g, '');
  const nb = toLatin(String(b ?? '')).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length < 5 || nb.length < 5) return false;
  if (na[0] !== nb[0]) return false;
  return editWithinOne(na, nb);
}

/** Canonical key of a raw word (any script) — the single entry point callers
 *  use, so the guard, the lookup and the harvest cannot drift apart: the sound
 *  skeleton, then the reviewed exception table for pairs the skeleton cannot
 *  see (a translation, not a spelling variant). */
/** Canonical keys already computed, keyed by the raw word. The map's 27.164
 *  name words are only 9.524 distinct, so the fold is paid once per DISTINCT
 *  word instead of once per occurrence — and the same cache serves the client's
 *  own words too. Bounded: a pathological corpus clears it rather than growing
 *  without limit. */
const CANON_CACHE = new Map<string, string>();
const CANON_CACHE_MAX = 20000;

export function canonicalWordKey(word: string): string {
  const w = String(word ?? '');
  const cached = CANON_CACHE.get(w);
  if (cached !== undefined) return cached;
  const k = soundKey(w);
  // A word with NO consonants keeps its own spelling as the key („ООУ“, „Oui“,
  // „Why“): an empty key would make every such word equal to every other one —
  // and made the guard refuse «ООУ 11 Октомври» its own name, because the head
  // word of the map name folded to nothing.
  let out: string;
  if (k) out = nameWordKey(k);
  else {
    const plain = toLatin(w).toLowerCase().replace(/[^a-z0-9]/g, '');
    out = plain ? nameWordKey(plain) : '';
  }
  if (CANON_CACHE.size >= CANON_CACHE_MAX) CANON_CACHE.clear();
  CANON_CACHE.set(w, out);
  return out;
}
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

// ── BILINGUAL PLACE IDENTITY (one place, many spellings) ────────────────────
// The same physical place lives in the map up to three times: OSM's Cyrillic
// name, Google's English name, and whatever the feed enriched. The identity
// passes used to compare the two keys above by EXACT string equality, so
// bureaucratic noise ("of the Republic of", "Consular Section of the") and
// word order split ONE place into two rotation slots — the Embassy bug:
//   L1 "Embassy of Montenegro"  + maps.google.com/?cid=…   (English, place card)
//   L2 "Амбасада на Црна Гора" + maps.google.com/?q=…     (Macedonian, raw pin)
// Same building, twice, two languages, two link forms.
//
// The rule below is TOKEN-level and deliberately conservative:
//   • transliterate + lexicon-map EVERY word (the same tables semanticNameKey uses)
//   • drop bureaucratic NOISE words — but KEEP DIGITS, so "Бит Пазар 1" can
//     never equal "Бит Пазар 2" (semanticNameKey strips digits, which is why it
//     must never be used for identity)
//   • compare as an UNORDERED SET: "embassy turkey" ≡ "embassy republic turkey"
//   • qualifiers (residence/consular/section) are KEPT — they mark genuinely
//     different units of the same institution and gate the embassy tier.

/** Bureaucratic filler that carries no identity. Dropped as tokens. */
export const IDENTITY_NOISE = new Set([
  'of', 'the', 'na', 'vo', 'od', 'do', 'kaj', 'sproti', 'de', 'i', 'so', 'za',
  'and', 'in', 'at', 'republic', 'republika', 'republiki', 'federal', 'federacija',
  'general', 'br', 'b', 'ul', 'ulica', 'street', 'bulevar', 'boulevard',
  // GENERIC VENUE WORDS. "Mavrovka Mall" / "ТЦ Мавровка" / "Mavrovka" are one
  // shopping centre described three ways; without dropping the generic part the
  // same building took three rotation slots (live 2026-10-11: 54m / 54m / 74m
  // in one reply). These words describe WHAT a place is, never WHICH one it is,
  // so they carry no identity — and the Kipper protection still holds, because
  // "Kipper" vs "Kipper Market - Butel" keeps the neighbourhood token 'butel'.
  'mall', 'tc', 'trgovski', 'shopping', 'shop', 'center', 'centre', 'centar',
  // INSTITUTIONAL ABBREVIATIONS — the same school across two sources:
  // "ООУ Лазо Ангеловски" and "ОУ Лазо Ангеловски" (основно/општинско училиште).
  'oou', 'ou', 'sou', 'ju', 'jp', 'ad', 'doo', 'dptu', 'guc', 'dgu', 'azc',
]);

/** Distinctive qualifiers that make two same-country institutions DIFFERENT
 *  places (an embassy vs its consular section vs its residence). Kept as
 *  tokens, and used to gate the embassy-uniqueness tier. */
export const IDENTITY_QUALIFIER = /residence|consular|consulate|section|annex|depot/i;

/** Identity tokens: canonical, noise-free, DIGITS PRESERVED, order ignored. */
export function identityTokens(name: string): string[] {
  let t = translitToLatin(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [from, to] of LEXICON_PHRASES) t = t.split(from).join(to);
  const out: string[] = [];
  for (const w of t.split(' ')) {
    if (!w) continue;
    const canon = LEXICON_WORDS[w] ?? w;
    if (!canon || IDENTITY_NOISE.has(canon)) continue;
    out.push(canon);
  }
  return out;
}

/** Unordered, noise-free identity key (digits kept). */
export function identityKey(name: string): string {
  return [...new Set(identityTokens(name))].sort().join(' ');
}

// ── RETRIEVAL TOKENS (client-typed place words) ─────────────────────────────
// identityTokens() canonicalizes the DISTINCTIVE words of a name; it drops the
// venue words (mall / trgovski / shopping / centar) because they never say
// WHICH place is meant. That is right for dedupe and wrong for LOOKUP: a
// client asks for „BUNJAKOVEC TRGOVSKI“ — place name + venue word, in the
// opposite order and the other language from the map's own
// „Shopping Center Bunjakovec“. Substring matching can never bridge that
// (there is no contiguous run of characters shared by both strings), so the
// phrase resolved to NOTHING and the distance answer fell through to the
// service question. Retrieval therefore needs the same bilingual vocabulary
// in an ORDER-INDEPENDENT form, with the venue words KEPT.
// Latin forms only — stripDefinite() transliterates before stripping, so the
// Cyrillic spellings („трговскиот“) arrive here as trgovskiot.
const DEFINITE_SUFFIXES_LOOKUP = ['ot', 'ov', 'ta', 'to', 'te', 'iot'];

/** The word with the client's definite article removed („trgovskiot“ →
 *  „trgovski“, „centarot“ → „centar“). Never below four characters, so
 *  „тато“ cannot become „та“. */
function stripDefinite(word: string): string {
  const latin = translitToLatin(word);
  for (const suffix of DEFINITE_SUFFIXES_LOOKUP) {
    if (!latin.endsWith(suffix)) continue;
    const stem = latin.slice(0, -suffix.length);
    if (stem.length >= 4) return stem;
  }
  return latin;
}

/** Canonical lexicon form of one word, tolerating the definite article the
 *  client writes („trgovskiot“ / „трговскиот“). A stem is only accepted when
 *  it lands on a KNOWN lexicon word — no open-ended stemming. */
function lexiconForm(word: string): string {
  if (LEXICON_WORDS[word]) return LEXICON_WORDS[word];
  const latin = translitToLatin(word);
  if (LEXICON_WORDS[latin]) return LEXICON_WORDS[latin];
  const stem = stripDefinite(word);
  if (stem !== latin && LEXICON_WORDS[stem]) return LEXICON_WORDS[stem];
  return latin;
}

/** Ordered-independent, bilingual token set of a place name, venue words KEPT.
 *  "Shopping Center Bunjakovec" → ['shopping','center','bunjakovec']
 *  "BUNJAKOVEC TRGOVSKI"        → ['bunjakovec','shopping'] */
export function placeLookupTokens(name: string): string[] {
  let t = translitToLatin(name)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [from, to] of LEXICON_PHRASES) t = t.split(from).join(to);
  const out: string[] = [];
  for (const word of t.split(' ')) {
    if (!word) continue;
    const canon = lexiconForm(word);
    if (canon && !STOPWORDS.has(canon) && !out.includes(canon)) out.push(canon);
  }
  return out;
}

/** Distance bounds shared by the map build (identity-heal.ts) and the runtime
 *  dedupe (nearestPois) — one rule, two call sites, so the build and the
 *  request path can never disagree about what "one place" means. */
export const IDENTITY_TOKEN_RADIUS = 120;  // same token set (order-insensitive)
export const IDENTITY_SUBSET_RADIUS = 40;  // one name contained in the other
export const IDENTITY_EMBASSY_RADIUS = 200; // same country, one in-city embassy

/** Countries our lexicon can recognize in landmark names. Keys are the
 *  normalized/canonical word forms (post-transliteration, post-lexicon).
 *  Used by the contradiction guard and the embassy-uniqueness tier. */
export const IDENTITY_COUNTRIES = new Set([
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

/** Cross-language pairs that normalize differently but denote one country. */
const IDENTITY_COUNTRY_ALIASES: Array<[string, string[]]> = [
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

/** Country tokens named by a place, in their canonical form. */
export function countriesIn(s: string): Set<string> {
  const words = new Set(identityTokens(s));
  const found = new Set<string>();
  for (const w of words) if (IDENTITY_COUNTRIES.has(w)) found.add(w);
  for (const [canon, alts] of IDENTITY_COUNTRY_ALIASES) {
    if (found.has(canon)) for (const a of alts) found.add(a);
    for (const a of alts) if (found.has(a)) found.add(canon);
  }
  return found;
}

/** True when a and b name contradictory countries (both name a country, and
 *  the sets are disjoint). Never true when either side names none. */
export function countryContradiction(nameA: string, nameB: string): boolean {
  const a = countriesIn(nameA);
  const b = countriesIn(nameB);
  if (!a.size || !b.size) return false;
  for (const w of a) if (b.has(w)) return false;
  return true;
}

/** Is the name an embassy/diplomatic mission at all? */
export const EMBASSY_RE = /\bembassy\b|\bambasada\b|\bambasadi\b|\bambasadi\b|\bemabassy\b/i;
export function isEmbassyName(name: string): boolean {
  return EMBASSY_RE.test(semanticNameKey(name)) || EMBASSY_RE.test(name.toLowerCase());
}

/** Does a name carry a discriminative qualifier (residence/consular/…)? */
export function hasIdentityQualifier(name: string): boolean {
  return IDENTITY_QUALIFIER.test(identityTokens(name).join(' ')) || IDENTITY_QUALIFIER.test(name);
}

export type PlaceAgreementTier = 'token' | 'subset' | 'embassy' | 'none';
export interface PlaceAgreement { same: boolean; tier: PlaceAgreementTier }

/**
 * THE single "are these two names the same physical place?" rule.
 *
 *   token  — identical token SET (order-insensitive, noise dropped, digits kept)
 *            within IDENTITY_TOKEN_RADIUS. "Амбасада на Турција" ≡
 *            "Embassy of Republic of Turkey"; "Амбасада на Република Чешка" ≡
 *            "Embassy of the Czech Republic"; "Бит Пазар 1" ≠ "Бит Пазар 2".
 *   subset — one token set contained in the other within IDENTITY_SUBSET_RADIUS,
 *            the smaller side carrying ≥1 distinctive (≥4-char) token AND the
 *            two rows standing on OPPOSITE identity sides (exactly one of them
 *            carries a Google place_id). That is the actual evidence for
 *            "Рептил" ≡ "Reptil Market br.3 Kisela Voda": Google identified the
 *            site and the OSM row is its local-script name. It is exactly what
 *            is MISSING for two un-identified rows that merely share a brand
 *            ("Kipper" vs "Kipper Market - Butel" = different branches), so
 *            those stay separate — the branch protection is unchanged.
 *   embassy— both embassies, same country, same qualifier state, no country
 *            contradiction, within IDENTITY_EMBASSY_RADIUS. A country has at
 *            most one main embassy per city; the residence/consular-section
 *            anchors are excluded unless the row itself is one.
 *
 * ``distanceM`` is the distance between the two candidates (NOT to a center).
 */
export function samePlaceName(
  nameA: string,
  nameB: string,
  distanceM: number,
  hasIdentityA = false,
  hasIdentityB = false,
): PlaceAgreement {
  const ta = new Set(identityTokens(nameA));
  const tb = new Set(identityTokens(nameB));
  if (ta.size === 0 || tb.size === 0) return { same: false, tier: 'none' };

  const sameSet = ta.size === tb.size && [...ta].every(t => tb.has(t));
  if (sameSet && distanceM <= IDENTITY_TOKEN_RADIUS) return { same: true, tier: 'token' };

  const subset = [...ta].every(t => tb.has(t)) || [...tb].every(t => ta.has(t));
  const smaller = ta.size <= tb.size ? ta : tb;
  const larger = ta.size <= tb.size ? tb : ta;
  const distinctive = [...smaller].some(t => t.length >= 4);
  // A BRANCH NUMBER is the only thing the larger name adds ("Веро Центар" vs
  // "Веро 9", 14m apart): the digit identifies WHICH shop, not a spelling of
  // the same one. "Бит Пазар" vs "Бит Пазар 1" already stay apart by the token
  // rule; the subset tier must not undo that merely because one row carries
  // Google's identity (the Vero Center mall and the Vero supermarket inside
  // it are two businesses in one building, like the bank-in-mall case).
  const onlyDigitsAdded = [...larger].every(t => smaller.has(t) || /^\d+$/.test(t))
    && [...larger].some(t => !smaller.has(t));
  const exclusiveIdentity = hasIdentityA !== hasIdentityB;
  // The qualifier guard applies here too: "Embassy of Republic of Turkey"
  // contains "Turkish Embassy (Residence)", but the residence is a DIFFERENT
  // building — containment must never fuse an institution with its
  // consular section / residence.
  const qualifierAgrees = hasIdentityQualifier(nameA) === hasIdentityQualifier(nameB);
  if (subset && distinctive && exclusiveIdentity && qualifierAgrees && !onlyDigitsAdded
      && distanceM <= IDENTITY_SUBSET_RADIUS) {
    return { same: true, tier: 'subset' };
  }

  if (isEmbassyName(nameA) && isEmbassyName(nameB)
      && !countryContradiction(nameA, nameB)
      && hasIdentityQualifier(nameA) === hasIdentityQualifier(nameB)) {
    const shared = [...countriesIn(nameA)].some(c => countriesIn(nameB).has(c));
    if (shared && distanceM <= IDENTITY_EMBASSY_RADIUS) return { same: true, tier: 'embassy' };
  }

  return { same: false, tier: 'none' };
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
/** Address-row provenance. '' = OSM build row (the 7,674 backbone);
 *  'google_street' = a Google-verified street anchor planted by the
 *  self-learning loop (scripts/street-teach.ts, the monthly B3 drain).
 *  The distinction is what lets Stage C trust a taught street's anchor
 *  while an OSM "ББ" centroid stays untrusted: Google confirmed the
 *  street EXISTS at that point; OSM's centroid is a cartographic label
 *  with no ground truth. Rebuilds PRESERVE learned anchors by re-running
 *  this schema-tolerant migration before inserting OSM rows. */
const ADDR_SOURCE_DDL = "ALTER TABLE addresses ADD COLUMN source TEXT NOT NULL DEFAULT ''";

function ensureAddressSourceColumn(db: Database.Database): void {
  const cols = (db.prepare('PRAGMA table_info(addresses)').all() as Array<{ name: string }>).map(c => c.name);
  if (!cols.includes('source')) db.exec(ADDR_SOURCE_DDL);
}

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

const CYRILLIC_RE = /[\u0400-\u04FF]/;
/** Do we prefer this spelling in a client-facing answer? The agency speaks
 *  Macedonian, so a Cyrillic name beats its Latin twin ("Амбасада на Црна
 *  Гора" over "Embassy of Montenegro"). */
export function prefersLocalScript(name: string): boolean {
  return CYRILLIC_RE.test(name);
}

/** The map's own NEIGHBOURHOOD label for a point (MapP3). OSM tags each city
 *  quarter as a `suburb` row — Карпош 3, Тафталиџе, Водно — and those rows are
 *  the only geography in the file: a landmark's own row says WHAT it is, never
 *  WHICH neighbourhood it stands in. The nearest suburb row within maxM is the
 *  answer ("ТЦ Лептокарија → Карпош 3, 219 m"). Beyond maxM there is no label:
 *  a quarter three kilometres away is not evidence of where a place is.
 *
 *  Pure so the caller can test the rule without a DB file. */
export function nearestAreaLabel(
  rows: Array<{ name: string; lat: number; lon: number }>,
  lat: number, lon: number, maxM = 2500,
): { name: string; distance_m: number } | undefined {
  let best: { name: string; distance_m: number } | undefined;
  for (const r of rows) {
    if (!r.name || !r.name.trim()) continue;
    const d = distM(lat, lon, r.lat, r.lon);
    if (d > maxM) continue;
    if (!best || d < best.distance_m) best = { name: r.name.trim(), distance_m: Math.round(d) };
  }
  return best;
}

/** A POI row after the same-place collapse in nearestPois(). */
export interface MergedPoi {
  name: string; type: string; lat: number; lon: number; dist: number;
  source?: string; place_url?: string; place_id?: string;
  review_count?: number | null; rating?: number | null; closed?: number | null;
}

/** Merge two rows the shared identity rule has proven to be ONE place.
 *  Invariants (this is what fixes the "English name + raw pin" answers):
 *    • the LOCAL-SCRIPT name survives (Cyrillic over Latin)
 *    • the Google identity survives (place_id from whichever side has it)
 *    • Google's coordinates win (verified), its rating/reviews ride along
 *    • the better type wins — a rank-0 Google row ("Corporate office",
 *      "Foreign consulate") must NOT demote a diplomatic row to type 0, but
 *      it still donates its place_id, so the served row keeps Google's
 *      identity for the no-coordinate place-card fallback (Turkey)
 *    • the distance is recomputed against the coordinates actually served */
export function mergeSamePlace(keep: MergedPoi, other: MergedPoi, centerLat: number, centerLon: number): MergedPoi {
  const kCyr = prefersLocalScript(keep.name), oCyr = prefersLocalScript(other.name);
  const name = kCyr && !oCyr ? keep.name : oCyr && !kCyr ? other.name : keep.name;
  const identity = keep.place_id ? keep : other.place_id ? other : null;
  const googleSide = keep.source === 'google' ? keep : other.source === 'google' ? other : null;
  const type = typeRank(other.type) > typeRank(keep.type) ? other.type : keep.type;
  const lat = googleSide?.lat ?? keep.lat;
  const lon = googleSide?.lon ?? keep.lon;
  return {
    name,
    type,
    lat,
    lon,
    dist: distM(centerLat, centerLon, lat, lon),
    source: identity?.source ?? keep.source,
    place_url: keep.place_url ?? other.place_url,
    place_id: identity?.place_id ?? keep.place_id ?? other.place_id ?? null as unknown as string | undefined,
    review_count: keep.review_count ?? other.review_count ?? null,
    rating: keep.rating ?? other.rating ?? null,
    closed: keep.closed ?? other.closed ?? 0,
  };
}

/** Same-place test for two POI rows: Google's identity when both carry one,
 *  otherwise the shared bilingual name rule at the real row-to-row distance. */
export function samePlacePoi(a: MergedPoi, b: MergedPoi): PlaceAgreement {
  if (a.place_id && b.place_id && a.place_id === b.place_id) return { same: true, tier: 'token' };
  return samePlaceName(a.name, b.name, distM(a.lat, a.lon, b.lat, b.lon), !!a.place_id, !!b.place_id);
}

/** ONE map row with the per-row derivations the name passes need.
 *
 *  WHY THIS EXISTS: the name lookup used to re-derive EVERY row on EVERY call
 *  — cleanPoiName + toLowerCase + translitToLatin + placeCategory + the
 *  shop/transit tests, and on the deep passes placeLookupTokens +
 *  phoneticWordKeys + canonicalWordKey for all ~6.000 rows. None of it depends
 *  on the needle: it is a property of the ROW. Measured before this cache, one
 *  findPoiByName(«Капитол Мол») cost 2.2 s and a single «STO IMATE KAJ KAPITOL
 *  MOL» turn 18.5 s; the same work is now paid once per store.
 *
 *  EVERYTHING BEYOND THE FOLDS IS LAZY: the cheap tier (folded name) is the
 *  only part a lookup always needs — measured over the shipped map, the flags
 *  cost placeCategory 166 ms + isShopLevelPlace 117 ms for all 5.992 rows, and
 *  the deep tier (token sets, phonetic keys, typo words) another ~800 ms. They
 *  now cost nothing until a pass asks for that particular row, so a lookup the
 *  first (substring) pass answers never pays for any of them. */
interface PoiIndexRow {
  name: string;
  type: string;
  lat: number;
  lon: number;
  place_url?: string;
  place_id?: string;
  /** cleanPoiName(name).toLowerCase() — the healed, case-folded row name. */
  low: string;
  /** translitToLatin(low) — the script bridge's form. */
  latin: string;
  /** low reduced to space-separated words (punctuation dropped). */
  foldLow: string;
  /** latin reduced to space-separated words. */
  foldLatin: string;
  // ── lazily filled (undefined = not computed yet) ─────────────────────────
  /** placeCategory(name); null = the row carries no category word. */
  cat?: string | null;
  shop?: boolean;
  transit?: boolean;
  residential?: boolean;
  tokens?: string[];
  tokenSet?: Set<string>;
  phone?: string[];
  phoneSet?: Set<string>;
  canonSet?: Set<string>;
  typoWords?: string[];
  typoKeys?: string[];
  idKey?: string;
}

type PoiHit = {
  lat: number;
  lon: number;
  name: string;
  type?: string;
  place_url?: string;
  place_id?: string;
};

/** Row TYPES that mean "a residential block", not "a venue": a named complex
 *  yields to a place row when both match (the Лептокарија capture). */const RESIDENTIAL_POI_TYPES = new Set([
  'residential', 'housing complex', 'apartment', 'apartment complex',
  'condominium complex', 'dormitory',
]);

/** The client's own PROPERTY vocabulary — the words a flat, a room or a house
 *  is asked for with. Such a word names what the client WANTS, never a place
 *  he navigates by, so a needle carrying one can never resolve to a POI.
 *
 *  The [08:46] capture: the client answered the type question with «APARTMAN»,
 *  the wish extractor handed «APARTMAN» to the map, the map answered
 *  «Apartmani Skopje» (one holiday flat, 4 km away in Центар), and the whole
 *  search was anchored on it: every later card read «Се наоѓа на 1,4 km од
 *  Апартмани Скопје», and the widen line called that listing a «населба». One
 *  property word is a CATEGORY answer; it must never move the geography. */
//  EXACT FORMS, never an open stem: «стан\p{L}*» would also swallow «Станица»
//  («Железничка станица» is a real landmark and must keep resolving), and
//  «куќа» is deliberately ABSENT — «Куќа на културата» is a venue name, while
//  the house category is read by the funnel's own detectors, not from the map.
const PROPERTY_CATEGORY_WORD_RE =
  /(?<![\p{L}])(?:апартман(?:и|от|от|ска)?|apartman(?:i|ot)?|стан|станот|станови|станче|станчето|stan|stanot|stanovi|stance|соба|соби|soba|sobi|дуплекс\p{L}*|duplex\p{L}*|гарсоњер\p{L}*|garsonjer\p{L}*)(?![\p{L}])/iu;

/** Row types that are a PROPERTY LISTING — one flat/house offered for sale or
 *  rent, filed by the map as a POI. Never a landmark: the client asks for stock
 *  NEAR a place he can stand in front of, and a holiday flat is the thing being
 *  sold, not the place it is near.
 *
 *  Deliberately NOT the whole residential family: «Буњаковец кула 5» is filed
 *  `residential` and IS a landmark people give directions by (the map test
 *  «miss-recovery» pins it), so only the LISTING types are refused here. */
const LISTING_POI_TYPES = new Set([
  'holiday apartment', 'apartment hotel', 'apartment hotel listing',
  'lodging', 'guest house',
]);

/** True when a map row is a property LISTING — never a place anchor. */
export function isListingPoiType(type?: string | null): boolean {
  return LISTING_POI_TYPES.has(normType(type));
}

/** The landmark lookup's diagnostic trail, OFF unless asked for. It used to be
 *  an unconditional appendFileSync on every match — a syscall per lookup in
 *  production and a log that reached 28 MB on this box. Diagnostics are an
 *  opt-in debugging aid, never a runtime side effect. */
function traceLandmark(line: string): void {
  if (!process.env.LINA_LANDMARK_DEBUG) return;
  try { fs.appendFileSync('/tmp/landmark-debug.log', line); } catch { /* diagnostics are best-effort */ }
}

export class OfflineMapStore {
  private db: Database.Database | null = null;
  /** The map file path — learnAddress() needs it to open a read-write conn. */
  private dbPath: string | null = null;
  /** Lazy READ-WRITE connection for learnAddress() — scripts teach the map;
   *  the runtime never opens it (stays read-only by construction). */
  private rwDb: Database.Database | null = null;
  /** Lazy cache of all distinct address keys for the fuzzy matcher. */
  private keyCache: string[] | null = null;
  /** Lazy per-row POI index (see PoiIndexRow) — built once per store. */
  private poiIndex: PoiIndexRow[] | null = null;
  /** Memoized findPoiByName results (null = a remembered MISS), so the same
   *  landmark asked twice in a turn costs nothing. Bounded: cleared when it
   *  grows past POI_LOOKUP_CACHE_MAX. */
  private poiLookups = new Map<string, PoiHit | null>();
  private static readonly POI_LOOKUP_CACHE_MAX = 512;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    try {
      this.db = new Database(dbPath, { readonly: true });
      // Schema self-upgrade: DBs built before the place_id column (Google
      // place-card links) must still open — new column reads as NULL and the
      // overrides fill it on the next apply/build. readonly connections can
      // still PRAGMA table_info; only the ALTER would fail, and a NULL
      // place_id is handled gracefully everywhere (link falls to next tier).
      // addresses.source (google_street provenance) carries the same rule.
      try { ensureAddressSourceColumn(this.db); } catch { /* read-only FS — readers tolerate the missing column */ }
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
      // Harvested spelling variants (data/name-variants.json → name_variants,
      // written by apply_overrides.ts after every rebuild). Absent table = the
      // in-code seed only, which is a safe subset.
      try {
        const rows = this.db.prepare('SELECT word, canonical FROM name_variants').all() as Array<{ word: string; canonical: string }>;
        if (rows.length) loadNameVariants(rows.map(r => [r.word, r.canonical] as [string, string]));
      } catch { /* older DB — seed only */ }
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
    if (this.rwDb) { try { this.rwDb.close(); } catch { /* ignore */ } this.rwDb = null; }
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
      review_count?: number | null; rating?: number | null; closed?: number | null;
    }>;

    const inCircle = rows
      .map(r => ({ ...r, dist: distM(lat, lon, r.lat, r.lon) }))
      .filter(r => r.dist <= radiusM);

    // Junk types (taxonomy dirt from the Overpass/Google merge) are never
    // usable as landmarks — filter BEFORE ranking so a "yes" building can't
    // outrank a real anchor.
    // Junk types (taxonomy dirt from the Overpass/Google merge) are never
    // usable as landmarks — filter BEFORE ranking so a "yes" building can't
    // outrank a real anchor. NOTE: 'residential' (bare OSM landuse tag on
    // apartment complexes) is NOT junk when it names a known complex —
    // Беверли Хилс is typed exactly that and is THE landmark of its block.
    // Only unnamed residential rows are junk; named ones stay eligible.
    const JUNK_TYPES = new Set(['yes', 'place', 'company', '',
      'house', 'building', 'address', 'unknown']);
    const clean = inCircle.filter(r =>
      !JUNK_TYPES.has(normType(r.type)) ||
      (normType(r.type) === 'residential' && !!r.name && r.name.trim().length > 0));

    // STEP 3 — distance chooses the first eligible public location. Transit
    // stops are secondary references (they can share a name with the place
    // they serve), so keep them as fallbacks after actual places.
    const TRANSIT_TYPES = new Set([
      'bus_station', 'bus_stop', 'bus station', 'bus stop',
      'tram_station', 'tram_stop', 'tram station', 'tram stop',
    ]);
    const secondaryTransit = (type: string): number => TRANSIT_TYPES.has(normType(type)) ? 1 : 0;

    // STEP 4 — SIGNIFICANCE FIRST inside the ring. A client navigates by the
    // embassy, the mall, the school or the church ("кај Католичка"), not by
    // the pharmacy that merely happens to be 20 m closer: typeRank decides,
    // and only equal-significance places are ordered by distance. The caller's
    // radius is the honesty cap (200 m for "во близина" claims) — significance
    // never reaches outside it. Google prominence still breaks distance ties
    // inside a class (a busy branch is the one people mean), and transit stops
    // stay a fallback pool, never crowding out a real place.
    const prominence = (r: { review_count?: number | null; closed?: number | null; source?: string }): number => {
      if (r.closed === 1) return -1;
      const base = Math.log10((r.review_count ?? 0) + 1);
      return r.source === 'google' ? base + 0.01 : base;
    };
    const bySignificance = (a: { dist: number; type: string; name: string; review_count?: number | null; closed?: number | null; source?: string },
                            b: { dist: number; type: string; name: string; review_count?: number | null; closed?: number | null; source?: string }): number =>
      typeRank(b.type) - typeRank(a.type)
      || a.dist - b.dist
      || prominence(b) - prominence(a)
      || a.name.localeCompare(b.name);
    // SAME-PLACE COLLAPSE — the ONE bilingual identity rule (samePlacePoi),
    // shared with the map build (scripts/identity-heal.ts), so the request
    // path can never disagree with what the build merged:
    //   • identical non-null place_id — the same physical place no matter how
    //     the name is spelled and no matter the coordinate disagreement
    //   • identical token set (order-insensitive, noise dropped, digits kept)
    //     within 120m — "Embassy of Montenegro" ≡ "Амбасада на Црна Гора"
    //   • containment within 40m — "Рептил" ≡ "Reptil Market br.3 Kisela Voda"
    //   • same-country embassies with the same qualifier state, within 200m
    // The merge keeps the CyriLLIC name AND Google's identity, so a twin can
    // no longer occupy two rotation slots ("Embassy of Montenegro" + ?cid,
    // then "Амбасада на Црна Гора" + ?q — one building, twice).
    const merged: MergedPoi[] = [];
    const byDistance = (a: { dist: number; name: string }, b: { dist: number; name: string }): number =>
      a.dist - b.dist || a.name.localeCompare(b.name);
    for (const poi of clean.sort(byDistance)) {
      const dupIdx = merged.findIndex(g => samePlacePoi(g, poi).same);
      if (dupIdx >= 0) {
        merged[dupIdx] = mergeSamePlace(merged[dupIdx], poi, lat, lon);
        continue;
      }
      merged.push(poi);
    }
    // STEP 5 — the significance-ordered pool. Ordinary places fill the cap
    // first; transit stops fill unused slots only as fallbacks, so a dense
    // stop cluster cannot crowd out a real public place. A verified Google
    // identity may change merged coordinates, so the order uses the
    // post-merge distances.
    const primaryPool = merged.filter(p => secondaryTransit(p.type) === 0).sort(bySignificance).slice(0, limit);
    const transitPool = primaryPool.length < limit
      ? merged.filter(p => secondaryTransit(p.type) === 1).sort(bySignificance).slice(0, limit - primaryPool.length)
      : [];
    const candidates = [...primaryPool, ...transitPool];
    return candidates.map(p => ({
      name: p.name,
      type: p.type,
      distance_m: Math.round(p.dist),
      lat: p.lat,
      lon: p.lon,
      place_url: p.place_url,
      place_id: p.place_id,
      review_count: p.review_count ?? null,
      // `rating` was captured and stored (75% of Google rows) but silently
      // dropped here, so the field LocalPoi declares never reached a client.
      rating: p.rating ?? null,
      closed: p.closed ?? 0,
    }));
  }

  /** The COMPLEX a shop stands inside — the place a client actually navigates
   *  by. A boutique, kiosk or shopfront row is a TENANT, never an anchor: the
   *  EB 53 card said «во близина на Butik Galion» while ТЦ Бисер — the place
   *  everyone in Аеродром knows — stood 20 m away and is where that boutique
   *  is. The lookup is a 250 m ring around the shop's own pin, filtered to
   *  complexes (a mall-ranked type, or a name that reads as a centre), and
   *  named complexes win over mall-typed tenants («ТЦ Бисер» before «Кисми -
   *  Бисер», a shop inside it that Google also typed «Shopping mall»).
   *  Undefined when the shop is NOT inside one — the caller then drops it
   *  rather than serving a name nobody recognises. */
  enclosingComplex(lat: number, lon: number, maxM = 250): { name: string; lat: number; lon: number; distance_m: number; place_url?: string; place_id?: string } | undefined {
    if (!this.db || !Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
    // distanceOnly keeps the significance sort out of the way: the question here
    // is purely "which complex is this shop standing in", and buildings one
    // inside another are metres apart.
    const around = this.nearestPois(lat, lon, maxM, 60, { distanceOnly: true })
      .filter(po => !isShopLevelPlace(po.name, po.type))
      .filter(po => typeRank(po.type) >= typeRank('mall') || isComplexName(po.name))
      .filter(po => Number.isFinite(po.lat) && Number.isFinite(po.lon));
    if (around.length === 0) return undefined;
    const named = around.filter(po => isComplexName(po.name));
    const pool = named.length > 0 ? named : around;
    pool.sort((a, b) => a.distance_m - b.distance_m);
    const hit = pool[0];
    return { name: hit.name, lat: hit.lat as number, lon: hit.lon as number, distance_m: hit.distance_m, place_url: hit.place_url, place_id: hit.place_id };
  }

  /** The neighbourhood this point sits in, from the map's own OSM suburb
   *  rows (see nearestAreaLabel). Undefined when the map is unavailable or no
   *  quarter is tagged within maxM — the caller must then say it does not
   *  know, never invent a district. */
  areaAt(lat: number, lon: number, maxM = 2500): { name: string; distance_m: number } | undefined {
    if (!this.db) return undefined;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
    const rows = this.db.prepare(`
      SELECT name, lat, lon FROM pois
      WHERE type = 'suburb' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
    `).all(lat - maxM / 111000, lat + maxM / 111000,
           lon - maxM / 82000,  lon + maxM / 82000) as Array<{ name: string; lat: number; lon: number }>;
    return nearestAreaLabel(rows, lat, lon, maxM);
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

  /** Lazy normName cache of the pois table (for poiDistanceM). */
  private poisNormed: Array<{ norm: string; lat: number; lon: number }> | null = null;

  /** Distance (m) from (lat,lon) to the NEAREST address row of the street
   *  this query names (house number stripped), or null when the street is
   *  unknown to the map — the geocode trust guard's "your street is HERE but
   *  the pin is over THERE" check. Exact key only (no fuzzy): a cross-check
   *  must never compare against a street we merely guessed at.
   */
  streetDistanceM(query: string, lat: number, lon: number): number | null {
    if (!this.db) return null;
    const key = streetKey(query);
    if (!key) return null;
    const rows = this.db.prepare(
      'SELECT lat, lon FROM addresses WHERE key = ?'
    ).all(key) as Array<{ lat: number; lon: number }>;
    if (rows.length === 0) return null;
    let min = Infinity;
    for (const r of rows) {
      const d = meters({ lat, lon }, r);
      if (d < min) min = d;
    }
    return min;
  }

  /** Distance (m) from (lat,lon) to the NEAREST POI whose name contains the
   *  query (normName-folded), or null when no such POI exists or the query is
   *  too short to match safely — the guard's landmark cross-check (the TC
   *  Olimpiko lesson: pin on a tire shop 2.2 km from the mall).
   */
  poiDistanceM(query: string, lat: number, lon: number): number | null {
    if (!this.db) return null;
    const q = normName(query);
    if (q.length < 4) return null;
    if (!this.poisNormed) {
      const rows = this.db.prepare('SELECT name, lat, lon FROM pois').all() as Array<
        { name: string; lat: number; lon: number }
      >;
      this.poisNormed = rows.map(r => ({ norm: normName(r.name), lat: r.lat, lon: r.lon }));
    }
    let min = Infinity;
    for (const p of this.poisNormed) {
      if (!p.norm.includes(q)) continue;
      const d = meters({ lat, lon }, p);
      if (d < min) min = d;
    }
    return min === Infinity ? null : min;
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
    // A query echoed from a legacy artifact ("Kоце Mеталец") must key the same
    // as the healed street row.
    const rawKey = streetKey(cleanStreetName(street));
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
  private streetCentroid(key: string): { lat: number; lon: number; street: string; google: boolean } | undefined {
    if (!this.db) return undefined;
    const hit = this.db.prepare(
      `SELECT street, lat, lon, source FROM addresses WHERE key = ?
       AND (housenumber = 'ББ' OR housenumber = '')
       ORDER BY source DESC LIMIT 1`
    ).get(key) as { street: string; lat: number; lon: number; source?: string | null } | undefined;
    return hit ? { lat: hit.lat, lon: hit.lon, street: hit.street, google: hit.source === 'google_street' } : undefined;
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

    // Stage C: street centroid ("ББ" / no number). An OSM centroid row is a
    // cartographic label — NEVER trusted. A GOOGLE-VERIFIED street anchor
    // (learned by the teach loop) is: Google confirmed the street at that
    // point, so any house number on it gets an honest street-level fix and
    // the offline resolver serves the property trusted immediately.
    const centroid = this.streetCentroid(key);
    if (centroid) {
      if (centroid.google) return { lat: centroid.lat, lon: centroid.lon, street: centroid.street, trusted: true, source: 'osm_street_anchor' };
      return { lat: centroid.lat, lon: centroid.lon, street: centroid.street, trusted: false, source: 'osm_low_confidence' };
    }

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
      return { lat: hit.lat, lon: hit.lon, trusted: true as const, source: hit.source as 'osm_building' | 'osm_interpolated' | 'osm_street_anchor' };
    }
    return { lat: hit.lat, lon: hit.lon, trusted: false as const, source: 'osm_low_confidence' as const };
  }

  /** THE SELF-LEARNING MAP — write a Google-verified street+number → coords
   *  pair back into the LIVE map DB. Every time Google resolves a street the
   *  local snapshot lacks ("if I search it in Google Maps I find it"), the
   *  finding is PERSISTED here, so the next property on the same street
   *  resolves OFFLINE at import (trusted, exact-building stage) and never
   *  needs Google again. This is the growth mechanism that closes the
   *  "street not found" gap permanently:
   *    import-time miss → queued → monthly Google geocode → MAP LEARNS
   *    → every future property on that street resolves offline.
   *  Idempotent: re-learning the same address is a no-op (or refreshes
   *  coordinates). Learned rows carry source='google_learned' so a rebuild
   *  can distinguish and PRESERVE them. Refuses landmark-style addresses
   *  with no street ("БИСЕР") — nothing generalizable to learn.
   *  Returns true when a row was written. */
  learnAddress(address: string, lat: number, lon: number): boolean {
    if (!this.db || !address) return false;
    const src = cleanStreetName(address);
    const key = streetKey(src);
    const houseNum = extractHouseNum(src);
    // Display name: the original-case street without the trailing number
    // (normalizeStreet lowercases — fine for keys, ugly for display).
    const street = src.replace(/\s+\d+(?:[\s.\-/]*(?:\d+|[а-яa-z]+))*\s*$/i, '').trim();
    if (!key || key.length < 3 || !houseNum || !street) return false;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    // Writes need a READ-WRITE connection — open it lazily and keep it (a
    // cron drain teaches many streets in one run). On failure (read-only FS,
    // concurrent rebuild) learning degrades to a no-op: false, no crash.
    if (!this.rwDb) {
      try { this.rwDb = new Database(this.dbPath ?? '', { timeout: 5000 }); } catch { return false; }
    }
    const w = this.rwDb;
    if (!w) return false;
    try {
      // Upsert on (street, housenumber): re-learning refreshes coordinates.
      const existing = w.prepare(
        'SELECT rowid FROM addresses WHERE key = ? AND housenumber = ?'
      ).get(key, houseNum) as { rowid: number } | undefined;
      if (existing) {
        w.prepare('UPDATE addresses SET lat = ?, lon = ? WHERE rowid = ?').run(lat, lon, existing.rowid);
      } else {
        w.prepare(
          "INSERT INTO addresses (street, housenumber, lat, lon, key) VALUES (?, ?, ?, ?, ?)"
        ).run(street, houseNum, lat, lon, key);
      }
      // Invalidate the fuzzy-key cache so the new street is visible
      // to resolveKey()/fuzzyKey() immediately.
      this.keyCache = null;
      return true;
    } catch { return false; }
  }

  /** THE STREET-LEVEL LEARN (October's class (c)): plant a Google-verified
   *  STREET anchor — "one geocode teaches the whole street". The anchor is a
   *  centroid row (housenumber 'ББ') carrying source='google_street', which
   *  Stage C trusts (source 'osm_street_anchor'): every house number on the
   *  street resolves OFFLINE trusted from now on, even with a single learned
   *  point. A Google pin is a street's own door; the street exists around
   *  it. Number-level precision for a SPECIFIC number still goes through
   *  learnAddress(), which outranks the anchor (Stage A before Stage C).
   *  Idempotent: re-teaching refreshes the anchor's coordinates. Returns
   *  true when the anchor row was written. */
  learnStreet(street: string, lat: number, lon: number): boolean {
    if (!this.db || !street) return false;
    const src = cleanStreetName(street);
    const key = streetKey(src);
    // Display name: original case, no trailing house number (same rule as
    // learnAddress — normalizeStreet lowercases, fine for keys, ugly for
    // display and for later per-number learning on the same street).
    const name = src.replace(/\s+\d+(?:[\s.\-/]*(?:\d+|[а-яa-z]+))*\s*$/i, '').trim();
    if (!key || key.length < 3 || !name) return false;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    if (!this.rwDb) {
      try { this.rwDb = new Database(this.dbPath ?? '', { timeout: 5000 }); } catch { return false; }
    }
    const w = this.rwDb;
    if (!w) return false;
    try {
      ensureAddressSourceColumn(w);
      // Upsert on the anchor row: re-teaching refreshes coordinates.
      const existing = w.prepare(
        "SELECT rowid FROM addresses WHERE key = ? AND (housenumber = 'ББ' OR housenumber = '') AND source = 'google_street'"
      ).get(key) as { rowid: number } | undefined;
      if (existing) {
        w.prepare('UPDATE addresses SET lat = ?, lon = ? WHERE rowid = ?').run(lat, lon, existing.rowid);
      } else {
        // One anchor per street: ignore when a centroid row already exists
        // (an OSM ББ row) — UPDATE the OSM row instead of INSERTing a twin.
        const osmCentroid = w.prepare(
          "SELECT rowid FROM addresses WHERE key = ? AND (housenumber = 'ББ' OR housenumber = '')"
        ).get(key) as { rowid: number } | undefined;
        if (osmCentroid) {
          w.prepare("UPDATE addresses SET lat = ?, lon = ?, source = 'google_street' WHERE rowid = ?").run(lat, lon, osmCentroid.rowid);
        } else {
          w.prepare(
            "INSERT INTO addresses (street, housenumber, lat, lon, key, source) VALUES (?, 'ББ', ?, ?, ?, 'google_street')"
          ).run(name, lat, lon, key);
        }
        this.keyCache = null;
      }
      return true;
    } catch { return false; }
  }

  /** THE MAP KEEPS ITSELF HONEST: delete every POI row with coordinates
   *  outside the Skopje bbox. Google's fuzzy geographic expansion leaks
   *  far-away places into tile scrapes (a Skopje supermarket search returned
   *  "Walgreens Pharmacy" — California, and a New York hospital), and an
   *  Overpass mirror once pulled 428 foreign rows. A POI outside the city
   *  can never be honestly "во близина" of a property, so it is pure
   *  contamination. Called at the start of every monthly run (after the
   *  Phase A restore) so contamination of ANY origin cannot survive a run.
   *  Returns the number of rows deleted. */
  pruneOutsideBbox(): number {
    if (!this.db) return 0;
    if (!this.rwDb) {
      try { this.rwDb = new Database(this.dbPath ?? '', { timeout: 5000 }); } catch { return 0; }
    }
    const w = this.rwDb;
    if (!w) return 0;
    try {
      const res = w.prepare(
        `DELETE FROM pois WHERE lat IS NOT NULL AND lon IS NOT NULL
           AND (lat < 41.95 OR lat > 42.05 OR lon < 21.35 OR lon > 21.50)`
      ).run();
      // The cached index still holds the deleted rows.
      this.invalidatePoiIndex();
      return res.changes;
    } catch { return 0; }
  }

  /** True when the map knows this street key at all (any building rows). */
  knowsStreet(address: string): boolean {
    if (!this.db || !address) return false;
    const key = streetKey(address);
    if (!key) return false;
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM addresses WHERE key = ?').get(key) as { n: number };
    return row.n > 0;
  }

  /** How many NUMBERED building rows the street carries (excludes "ББ"/
    * blank-centroid rows). The census's class-(b) "thin" test: ≥2 numbered
    * rows make interpolation possible for any in-range number; 0–1 rows is
    * thin even when the street itself is known. Also the trust input for
    * taught-anchor streets (a street with ≥2 real numbers outranks its
    * Google anchor). */
  numberedRowCount(address: string): number {
    if (!this.db || !address) return 0;
    const key = streetKey(address);
    if (!key) return 0;
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM addresses
       WHERE key = ? AND housenumber != '' AND housenumber != 'ББ'`
    ).get(key) as { n: number };
    return row.n;
  }

  /** THE SCRAPER CONTRACT, applied to the LIVE map: add any missing capture
   *  columns (review_count, rating, plus_code, …) in one read-write pass.
   *  Old DBs keep working — every reader tolerates NULL. Returns the column
   *  names that were added (empty when the schema is current). */
  ensurePoiColumns(): string[] {
    if (!this.db) return [];
    const COLUMNS: Record<string, string> = {
      review_count: 'INTEGER', rating: 'REAL', plus_code: 'TEXT',
      phone: 'TEXT', website: 'TEXT', price_level: 'TEXT',
      closed: "INTEGER NOT NULL DEFAULT 0", types: 'TEXT',
    };
    const added: string[] = [];
    if (!this.rwDb) {
      try { this.rwDb = new Database(this.dbPath ?? '', { timeout: 5000 }); } catch { return []; }
    }
    try {
      const cols = (this.rwDb.prepare('PRAGMA table_info(pois)').all() as Array<{ name: string }>).map(c => c.name);
      for (const [col, ddl] of Object.entries(COLUMNS)) {
        if (!cols.includes(col)) {
          this.rwDb.exec(`ALTER TABLE pois ADD COLUMN ${col} ${ddl}`);
          added.push(col);
        }
      }
      return added;
    } catch { return []; }
  }

  /** The per-row POI index (cheap tier). Built once; see PoiIndexRow. */
  private poiRows(): PoiIndexRow[] {
    if (this.poiIndex) return this.poiIndex;
    if (!this.db) return [];
    const fold = (s: string): string =>
      s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
    this.poiIndex = (this.db.prepare(
      'SELECT name, type, lat, lon, place_url, place_id FROM pois'
    ).all() as Array<{ name: string; type: string; lat: number; lon: number; place_url?: string; place_id?: string }>)
      .map(r => {
        const low = cleanPoiName(r.name).toLowerCase();
        const latin = translitToLatin(low);
        return { ...r, low, latin, foldLow: fold(low), foldLatin: fold(latin) };
      });
    return this.poiIndex;
  }

  // ── Lazily derived row facts (each computed once per row, on first need) ──
  /** placeCategory(name), or undefined when the row names no institution. */
  private catOf(r: PoiIndexRow): string | undefined {
    if (r.cat === undefined) r.cat = placeCategory(r.name) ?? null;
    return r.cat ?? undefined;
  }
  private isShop(r: PoiIndexRow): boolean {
    return r.shop ??= isShopLevelPlace(r.name, r.type);
  }
  private isTransit(r: PoiIndexRow): boolean {
    return r.transit ??= isTransitPlace(r.type);
  }
  private isResidential(r: PoiIndexRow): boolean {
    return r.residential ??= RESIDENTIAL_POI_TYPES.has(normType(r.type));
  }
  /** placeLookupTokens of the row name — the token-set pass's vocabulary. */
  private tokensOf(r: PoiIndexRow): string[] {
    return r.tokens ??= placeLookupTokens(cleanPoiName(r.name));
  }
  private tokenSetOf(r: PoiIndexRow): Set<string> {
    return r.tokenSet ??= new Set(this.tokensOf(r));
  }
  /** phoneticWordKeys of the row name — the spelling-tolerant pass. */
  private phoneOf(r: PoiIndexRow): string[] {
    return r.phone ??= phoneticWordKeys(cleanPoiName(r.name));
  }
  private phoneSetOf(r: PoiIndexRow): Set<string> {
    return r.phoneSet ??= new Set(this.phoneOf(r));
  }
  /** Canonical (variant-folded) keys of the row name — the last deep pass. */
  private canonSetOf(r: PoiIndexRow): Set<string> {
    return r.canonSet ??= new Set(this.phoneOf(r).map(w => canonicalWordKey(w)));
  }
  private typoWordsOf(r: PoiIndexRow): string[] {
    return r.typoWords ??= cleanPoiName(r.name).split(/[^0-9\p{L}]+/u).filter(w => w.length >= 3);
  }
  private typoKeysOf(r: PoiIndexRow): string[] {
    return r.typoKeys ??= this.typoWordsOf(r).map(w => canonicalWordKey(w));
  }
  private idKeyOf(r: PoiIndexRow): string {
    return r.idKey ??= identityKey(r.name);
  }

  /** Drop the POI index and the memoized lookups — any writer of `pois` must
   *  call this, or a learned/pruned row stays invisible (or visible after it
   *  is gone). */
  private invalidatePoiIndex(): void {
    this.poiIndex = null;
    this.poiLookups.clear();
  }

  /** EVERY row the client's words APPEAR in, shortest name first — the second
   *  chance a single fuzzy hit cannot give.
   *
   *  WHY (the [23:26] «ZELEZNICKA STANICA» capture): findPoiByName answers with
   *  ONE best row, and the handler's name-coverage guard then decides whether
   *  that row may bind. When the best row hides the client's words behind a
   *  qualifier — «Стара Железничка Станица» for «zeleznicka stanica» — the guard
   *  rightly refuses it (that is the «ELS Novo Lisice» rule), and the client's
   *  words died there even though the map holds «Железничка станица Скопје»,
   *  literally starting with them. A single hit cannot express "not this row,
   *  the other one"; this can.
   *
   *  Same containment filter and the same tenant/stop rule as findPoiByName —
   *  it is the SAME place vocabulary, only unwrapped to a list. The caller still
   *  runs the coverage guard on every candidate, so a near-namesake that merely
   *  CONTAINS the words («Трговски Лисиче» for «trogvski») is never accepted
   *  here alone. */
  findPoisByName(name: string, limit = 8): Array<{ name: string; lat: number; lon: number; type?: string; place_url?: string; place_id?: string }> {
    if (!this.db || !name) return [];
    const clean = name.replace(/^(?:кај|спроти|как)\s+/i, '').trim();
    if (clean.length < 2) return [];
    // PUNCTUATION IS NOT PART OF A NAME (the coverage sweep found the family):
    // the map spells «Св. Пантелејмон», «Кафе „Дабов“», «ОУ „Блаже Конески“»,
    // «Технолошко-металуршкиот», «АМСМ-КОН ЦЕНТАР» — and a client types the same
    // words with none of it («sv pantelejmon», «kafe dabov», «ou blaze»).
    // Comparing raw strings made every one of those families unreachable, since
    // the folded needle is never a substring of the punctuated name. Both sides
    // are reduced to space-separated words first, exactly like placeLooseKey.
    // (The row side is pre-folded in the POI index — foldLow / foldLatin.)
    const fold = (s: string): string =>
      s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
    const needle = repairMixedScript(clean);
    const needleF = fold(needle);
    const needleCyrF = fold(/[\u0400-\u04FF]/u.test(needleF) ? needleF : toCyrillic(needleF));
    const needleLatF = fold(translitToLatin(needleCyrF));
    const rows = this.poiRows().filter(r =>
      r.foldLow.includes(needleF) || r.foldLow.includes(needleCyrF)
      || r.foldLatin.includes(needleF)
      || (needleLatF.length >= 3 && r.foldLatin.includes(needleLatF)));
    // A tenant or a transit stop never shadows the venue it sits in/next to.
    const venue = rows.filter(r => !this.isShop(r));
    const pool = venue.length > 0 ? venue : rows;
    return pool
      .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
      .slice(0, limit)
      // THE OSM TYPE TRAVELS WITH THE ROW (see the coverage guard's class
      // rule): a place filed as «Олимпико» with no class word in its name still
      // DECLARES what it is (mall), and a client who appends «мол» must bind
      // it. Dropping the column here made that impossible at every call site.
      .map(r => ({ name: r.name, lat: r.lat, lon: r.lon, type: r.type, place_url: r.place_url, place_id: r.place_id }));
  }

  /** Search POIs by name — for landmark-style addresses like "Кај Бранка"
   *  or "Палома Бјанка" where the address IS the landmark, not a street.
   *  Returns the best match (exact > starts-with > contains). */
  /** PUBLIC LOOKUP — the exact passes first, then the SCHOOL-NAME bridge.
   *  The bridge runs ONLY after the core missed, so it can never displace an
   *  exact, alias, prefix or substring hit (same contract as the typo pass). */
  findPoiByName(name: string, center?: { lat: number; lon: number }): PoiHit | undefined {
    if (!name) return undefined;
    // MEMOIZED: a turn asks for the same landmark several times (the stock-at-
    // place lane, the distance answer, the coverage sweep), and the answer is
    // deterministic while the map does not change. A remembered MISS is cached
    // too — a place the map does not hold stays a miss.
    const key = `${name.trim().toLowerCase()}|${center ? `${center.lat},${center.lon}` : ''}`;
    const memo = this.poiLookups.get(key);
    // A COPY, like the computed answer: the cached object must not be shared
    // mutable state between two callers that both got one hit.
    if (memo !== undefined) return memo ? { ...memo } : undefined;
    const hit = this.findPoiByNameUncached(name, center);
    if (this.poiLookups.size >= OfflineMapStore.POI_LOOKUP_CACHE_MAX) this.poiLookups.clear();
    this.poiLookups.set(key, hit ? { ...hit } : null);
    return hit;
  }

  private findPoiByNameUncached(name: string, center?: { lat: number; lon: number }): PoiHit | undefined {
    // GRAMMAR IS NOT A PLACE NAME (the [19:46] sweep): a query built only from
    // function words names nothing, and every pass below would be guessing —
    // and did, binding a different POI to each of them. Refuse before the map
    // is touched; real short names still arrive with their own noun attached.
    if (isGrammarOnlyQuery(name)) return undefined;
    // A RESIDENTIAL/LISTING ROW IS NEVER A PLACE (see PROPERTY_CATEGORY_WORD_RE):
    // the client asks for stock NEAR a landmark he can stand in front of; a
    // holiday flat or an apartment block is the thing being sold, not the place
    // it is near. The row-side veto is what keeps a listing out even when the
    // needle itself looked like a name.
    const place = (hit: PoiHit | undefined): PoiHit | undefined =>
      hit && !isListingPoiType(hit.type) ? hit : undefined;
    const direct = place(this.findPoiByNameCore(name, center));
    if (direct) return direct;
    // THE ALIAS'S SECOND NAME (see LOCAL_PLACE_ALIAS_FALLBACKS): the canonical
    // row is not in this snapshot, so the colloquial name is tried against the
    // institution's other filing. Never a stop — that is a place NAMED AFTER
    // the one the client meant.
    const official = officialPlaceName(name);
    for (const alt of (official ? LOCAL_PLACE_ALIAS_FALLBACKS[official] ?? [] : [])) {
      const hit = place(this.findPoiByNameCore(alt, center));
      if (hit && !TRANSIT_TYPES.has(normType(hit.type))) return hit;
    }
    for (const alt of schoolQueryForms(name)) {
      const hit = place(this.findPoiByNameCore(alt, center));
      if (hit) return hit;
    }
    return undefined;
  }

  private findPoiByNameCore(name: string, center?: { lat: number; lon: number }): PoiHit | undefined {
    if (!this.db || !name) return undefined;
    // Strip location prepositions AND feed typos of them ("как" for "кај").
    let clean = name.replace(/^(?:кај|спроти|как|кај штипски|кај скопски)\s+/i, '').trim();
    if (!clean || clean.length < 2) return undefined;
    // NOTHING IS NAMED «САЈТ» (see NOT_A_PLACE_ALONE): in front of the fuzzy
    // passes, or the everyday word comes back as a real bakery.
    //
    // A CENTERED LOOKUP IS EXEMPT, and that is the whole distinction: with a
    // center the caller is asking «which one is at MY side» — the surroundings
    // lane's definite shorthands («кај трговскиот», «пазарцето», «на која страна
    // е, кај молот?»), answered from the nearest branch inside a 900 m ring. With
    // no center the map would be GUESSING which hospital/mall the word means,
    // and that guess is what served «Болница за зависности» for «воена болница».
    if (!center && refusesGenericNeedle(clean)) return undefined;
    // A PROPERTY WORD IS A CATEGORY ANSWER, NEVER A PLACE (the [08:46] capture,
    // second half): «APARTMAN» / «APARTMANI SKOPJE» must miss here. The map
    // holds «Apartmani Skopje» — one holiday listing filed as a POI — and the
    // client's TYPE answer anchored the whole search on it: «Се наоѓа на 1,4 km
    // од Апартмани Скопје» under every card, and «во истата населба до
    // Апартмани Скопје» in the widen ask, which called a flat a naselba.
    if (PROPERTY_CATEGORY_WORD_RE.test(clean)) return undefined;
    // Colloquial names first: the client's words become the map's own name of
    // the SAME place, so no fuzzy pass can substitute a different one.
    for (const [re, official] of LOCAL_PLACE_ALIASES) {
      if (re.test(clean)) { clean = official; break; }
    }
    // EMBASSY ALIASES — clients say "Црногорска амбасада"; Google stores
    // "Embassy of Montenegro". Word-by-word matching can never bridge
    // country-adjective + амбасада to its English title, so a bounded
    // dictionary rewrites the needle. Only the амбасада family — no open-ended
    // translation, no false broadening.
    const embassy = clean.match(/(\S+)\s+амбасад[ау]/i);
    if (embassy) {
      const country = embassy[1].toLowerCase().replace(/(?:те|та|от|ов|ите)?$/, '');
      const en = EMBASSY_COUNTRY_EN[country];
      if (en) clean = `Embassy of ${en}`;
    }
    // Prefer SHORTER names ("ТЦ Бисер" > "Бисер Травел") — the shorter name
    // is the more precise landmark reference.
    // NOTE: SQL LIKE ... COLLATE NOCASE does NOT fold non-ASCII case, so
    // "тц олимпико" would never match "ТЦ Олимпико". Do the contains-test in
    // JS where toLowerCase() is Unicode-aware. Table is ~4k rows — trivial.
    // SCRIPT BRIDGE — clients type Latin ("skopjanka"), OSM stores Cyrillic
    // ("ТЦ Скопјанка"). Match in BOTH canonical scripts: the raw needle and
    // the transliterated one. The POI row's folded Latin form is precomputed
    // once per call from the already-loaded table (sub-ms at 4k rows).
    // Heal an artifact in the NEEDLE too (a client echoing a name we once
    // showed them wrong, or typing a homoglyph from a copy-paste).
    // CATEGORY GUARD — see placeCategory(): a phrase that names an institution
    // (hospital, academy, mall, church…) can only ever answer a row of the SAME
    // kind. A hospital never becomes an academy, a mall never becomes a church;
    // rows carrying no category word of their own are never vetoed, so the guard
    // can only reject a CONTRADICTION, never a genuine match.
    const wantCategory = placeCategory(clean);
    // The row's own category word is precomputed in the index (row.cat).
    const categoryOk = (row: PoiIndexRow): boolean => {
      if (!wantCategory) return true;
      const have = this.catOf(row);
      return !have || have === wantCategory;
    };
    const needle = repairMixedScript(clean).toLowerCase();
    const needleCyr = /[\\u0400-\\u04FF]/.test(needle) ? needle : toCyrillic(needle);
    // …and the FOLDED Latin form of the needle, so the bridge works in BOTH
    // directions: a Cyrillic query («бисер») must reach a Latin row
    // («Biser Shopping Center») exactly as the Latin query reaches the
    // Cyrillic one. Matching one way only left the same place unreachable
    // depending on the keyboard the client used.
    const needleLat = translitToLatin(needleCyr);
    // A row from an older build may still carry the artifact: the index holds
    // the HEALED form (row.low), so an honest Cyrillic query still finds it.
    // A PARTIAL MATCH MUST BE A WORD, NOT A FRAGMENT OF ONE (the [19:46]
    // capture): the contains pass compared raw substrings, so ordinary
    // grammar words became POIs — «ИМА»→«Image Plus», «НЕМА»→«Cinematheque of
    // Macedonia», «ИМАТЕ»→«Primatex», «ДА»→«ДАЛЕКС». The land request «А ВО
    // КОЈА НАСЕЛБА ИМА?» was answered «Image Plus се наоѓа во Шуто Оризари».
    // wordAlignedHit keeps exact/whole-word and word-prefix matches (real
    // acronyms and names still resolve) and refuses mid-word fragments.
    let rows = this.poiRows().filter(r =>
      categoryOk(r) && (wordAlignedHit(r.low, needle) || wordAlignedHit(r.low, needleCyr)
        || wordAlignedHit(r.latin, needle)
        || wordAlignedHit(r.latin, needleLat)));
    // A TENANT IS NEVER THE VENUE (the [21:45] «NESTO OKOLU DAJMOND MOL»
    // capture): the needle «дајмонд мол» matched ONLY the bookshop inside the
    // mall — its name carries the mall in parentheses — and the client was
    // told about a shop instead of the mall. When any candidate is a real
    // venue, the shop-level rows are dropped and the passes below (sound
    // variant, phonetic) get to answer with the mall itself.
    const nonShop = rows.filter(r => !this.isShop(r));
    let shopFallback: typeof rows = [];
    if (nonShop.length > 0) rows = nonShop;
    else if (rows.length > 0) { shopFallback = rows; rows = []; }
    // A STOP IS NEVER THE PLACE IT IS NAMED AFTER (the Лептокарија capture):
    // the map holds «Leptokarija» — a BUS STOP whose name is an exact match —
    // and «ТЦ Лептокарија», the mall the client means 400 m away. Exact-name
    // ranking handed the stop to the funnel, so the anchored serve measured its
    // distances from a bus stop and named it as the place. Transit rows step
    // aside whenever a real place also matches AND the client did not ask for
    // transit — the same contract as the tenant rule above and the park/bus-stop
    // rule in nearestPois. «кај автобуската» keeps its stop: the needle itself
    // names transit.
    if (!ASKS_TRANSIT_RE.test(clean)) {
      const nonTransit = rows.filter(r => !this.isTransit(r));
      if (nonTransit.length > 0) rows = nonTransit;
    }
    // A CASH MACHINE IS NOT THE PLACE IT STANDS IN (the [04:46] capture): with
    // the same `contains` match rank, the ATM 160 m nearer the flat answered
    // for the mall the client asked about. Same demotion as transit/residential:
    // a real place row wins, and a service point keeps its own answer when it
    // is the only match («кај Комерцијална банка»).
    const nonService = rows.filter(r => !SERVICE_POINT_TYPES.has(normType(r.type ?? '')));
    if (nonService.length > 0) rows = nonService;
    // A RESIDENTIAL BLOCK IS NOT THE VENUE (the Лептокарија capture): the map
    // holds «ТЦ Лептокарија» (the mall) and «Leptokarija Mall», a HOUSING
    // COMPLEX row whose name merely starts with the word. A client saying
    // «Лептокарија» means the centre, so a named residential/complex row yields
    // to a place row when both match — the same demotion the tenant and transit
    // rules above apply. A residential row with NO competing place stays, or
    // named complexes like Беверли Хилс would vanish from their own block.
    const nonResidential = rows.filter(r => !this.isResidential(r));
    if (nonResidential.length > 0) rows = nonResidential;
    // Progressive shortening: "Сити Мол ' Руските Згради" → "Сити Мол"
    // (head) and "Шампионче Как Кипер Маркет" → "кипер маркет" (tail).
    // Never fall to a SINGLE word — "народен" would match
    // "Македонски народен театар" for an unrelated address.
    const words = clean.split(/\s+/);
    if (rows.length === 0 && words.length > 2) {
      // Short candidates get the SAME script bridge as the full needle: the
      // client's Latin echo ("KADE TI E TOA 26 JULI TC ?") shortens to
      // "26 juli", which must still find the Cyrillic "ТЦ 26 Јули" row (the
      // [12:48] transcript — the unbridged shortening pass killed the hit).
      const candidates = [words.slice(0, 2).join(' '), words.slice(-2).join(' ')]
        .map(w => w.toLowerCase())
        .filter(w => w.length >= 3);
      const candidatesCyr = candidates.map(w => /[\u0400-\u04FF]/.test(w) ? w : toCyrillic(w));
      for (const short of [...candidates, ...candidatesCyr]) {
        rows = this.poiRows().filter(r =>
          categoryOk(r) && (r.low.includes(short) || r.latin.includes(short)));
        if (rows.length > 0) break;
      }
    }
    // ORDER-INDEPENDENT / TRANSLATED FALLBACK — the last resort before MISS.
    // Only runs when every character-level pass above found nothing, so it can
    // never displace an exact, alias, prefix or substring hit. A row matches
    // when it carries EVERY token the client typed (venue words included, see
    // placeLookupTokens):
    //   "Bunjakovec trgovski" → ['bunjakovec','shopping']
    //   map row "Shopping Center Bunjakovec" → ['shopping','center','bunjakovec'] ✔
    // Word order, script and language no longer matter; a wrong place cannot
    // slip in, because the DISTINCTIVE token (the place name) must be present.
    if (rows.length === 0) {
      const want = placeLookupTokens(clean);
      // A WHICH-word is required. identityTokens() is the distinctive part of
      // the name (venue words dropped), so a bare "centarot" / "trgovskiot"
      // can never turn a deliberate MISS into an arbitrary nearby venue — the
      // fallback only fires when the client named a place as well. The
      // definite article comes off first, or „centarot“ would survive as a
      // distinctive word of its own.
      const distinctive = identityTokens(
        clean.split(/\s+/).map(stripDefinite).join(' '));
      // …and it must contain a PROPER NOUN. A phrase built entirely from the
      // lexicon („Црногорска амбасада“ = montenegro + embassy) is generic
      // vocabulary that already has its own, tighter bridges (the embassy
      // alias rewrite, the identity tiers) — letting the order-free pass
      // answer it here changes WHICH property those lanes bind, which is not
      // this fallback's job. A real place name always contributes at least one
      // word the lexicon does not know („bunjakovec“).
      const hasProperNoun = translitToLatin(clean)
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .some(w => !LEXICON_WORDS[w] && !LEXICON_WORDS[stripDefinite(w)]
          && !STOPWORDS.has(w) && !STOPWORDS.has(stripDefinite(w)));
      if (want.length > 0 && distinctive.length > 0 && hasProperNoun
        && want.every(w => w.length >= 3)) {
        const wantSet = new Set(want);
        let tokenRows = this.poiRows()
          .filter(r => categoryOk(r) && [...wantSet].every(w => this.tokenSetOf(r).has(w)));
        // Prefer the row that matches the query EXACTLY as a token set (fewest
        // extra words: "Shopping Center Bunjakovec" beats "KAM Market -
        // Bunjakovec Shopping Center" for „Bunjakovec trgovski“), then the
        // SIGNIFICANT row over a same-named lesser one (the OSM rows called
        // „Трговски Центар Буњаковец“ are BUS STOPS 300 m up the boulevard;
        // the mall itself ranks 5 and must win, exactly as in nearestPois),
        // then the nearest branch to the client's context.
        //
        // The answer is returned HERE, not handed to the substring ranking
        // below: that ranking is distance-first, and the nearest same-named row
        // is precisely the transit stop rather than the place.
        // A TENANT NEVER ANSWERS FOR ITS VENUE (the [21:45] «NESTO OKOLU
        // DAJMOND MOL» capture): this pass matched the bookshop INSIDE the
        // mall — „Literatura.mk Superstore - Diamond mall (… Дајмонд мол)“ —
        // because the mall's own words ride in its parentheses. Shop-level
        // rows step aside whenever a real venue matches; if ONLY shops match,
        // the pass declines and the typo/variant passes get to name the venue
        // (and the shop fallback at the end still answers a genuine shop query).
        const venueTokenRows = tokenRows.filter(r => !this.isShop(r));
        if (venueTokenRows.length > 0) tokenRows = venueTokenRows;
        else tokenRows = [];
        if (tokenRows.length > 0) {
          const extra = (r: PoiIndexRow): number => this.tokensOf(r).length - wantSet.size;
          tokenRows.sort((a, b) =>
            extra(a) - extra(b)
            || typeRank(b.type) - typeRank(a.type)
            || (center
              ? distM(center.lat, center.lon, a.lat, a.lon) - distM(center.lat, center.lon, b.lat, b.lon)
              : a.name.length - b.name.length));
          const best = tokenRows[0];
          try { traceLandmark(
            `[${new Date().toISOString()}] findPoiByName(${clean}): TOKEN-SET ${tokenRows.length} matches → ${best.name} (${best.lat},${best.lon})\n`); } catch {}
          return { lat: best.lat, lon: best.lon, name: best.name, type: best.type, place_url: best.place_url ?? undefined, place_id: best.place_id ?? undefined };
        }
      }
    }
    if (rows.length > 0) {
      // MATCH QUALITY FIRST — the documented contract (exact > alias >
      // starts-with > contains) that the filter alone never enforced. A client
      // asking about "Diamond Mall" got "Civil - Diamond Mall" (the nearest
      // containing row) although the map holds the EXACT place; "ГТЦ" matched
      // "ГТЦ Кула 1" (a tower) instead of the mall whose own name carries the
      // acronym in parentheses. Distance then picks the branch.
      const latinNeedle = translitToLatin(needle);
      // A PARENTHETICAL ALIAS is the map's own statement that this row IS the
      // acronym: "City Trade Center Skopje (GTC)", "Градски трговски центар
      // (ГТЦ)". It must beat a longer row that merely starts with the letters
      // ("ГТЦ Кула 1", "GTC Apart Hotel") — those are PARTS of the place.
      const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const aliasRank = (name: string, n: string): number =>
        new RegExp(`[（(]\\s*${esc(n)}\\s*[)）]`, 'iu').test(name) ? 1 : 0;
      // The row's healed/folded forms are the index's (low / latin); only the
      // PARENTHETICAL alias test needs the raw name the client would see.
      const matchRank = (row: PoiIndexRow): number => {
        if (row.low === needle || row.low === needleCyr || row.latin === latinNeedle) return 0;
        if (aliasRank(row.name, needle) || aliasRank(row.name, needleCyr)) return 1;
        if (row.low.startsWith(needle) || row.low.startsWith(needleCyr) || row.latin.startsWith(latinNeedle)) return 2;
        return 3;
      };
      // …and a row that is a PART of the venue (food court, parking, apteka)
      // never outranks the venue itself.
      const needleWords = new Set(placeLookupTokens(cleanPoiName(clean)));
      const partOfVenue = (row: PoiIndexRow): number =>
        this.tokensOf(row).some(t => !needleWords.has(t) && VENUE_PART_WORDS.has(t)) ? 1 : 0;
      // A HEAD-ONLY HIT ANSWERS WITH THE LANDMARK (the [00:46] capture):
      // „ZDRAVO SAKAM DA KUPAM STANCE KAJ BISER“ was answered «Имам две
      // недвижности близу Бисер Травел» — a travel AGENCY. The client's word
      // started the name of two different map places, and the old shortest-name
      // rule picked «Бисер Травел» (13 chars) over «Biser Shopping Center» (the
      // mall, 21 chars). Nobody navigates by an office; the landmark people
      // know is the reading. Significance (typeRank) therefore decides among
      // rows the needle merely STARTS (matchRank 2) — never among exact or
      // contains hits, where the name itself is the answer. Every place stays a
      // candidate; the ladder only decides the ORDER.
      //
      // Only when there is NO center. With a center the client's own context
      // decides which branch they mean — the property's LOCAL mall beats a
      // farther one with a fancier type (the [01:29] side-answer rule).
      //
      // BOTH RANKS ARE ROW WIDE, NOT PAIRWISE: scoring them inside the
      // comparator re-tokenized and re-transliterated every candidate O(n log n)
      // times over (dozens of rows match «Капитол Мол»), which WAS the 2.2 s a
      // single lookup cost. They are computed once per row here.
      const scored = rows.map(r => ({ r, pv: partOfVenue(r), mr: matchRank(r) }));
      // Branch disambiguation: chains (TTK Banka, Tinex, Kipper…) have many
      // rows sharing one name. "Nearest to the client's context" (the shown
      // property) is the branch they mean — NEVER a global shortest-name
      // pick, which sent a Капиштец client to a Ново Лисиче branch.
      scored.sort((a, b) =>
        a.pv - b.pv
        || a.mr - b.mr
        || (!center && a.mr === 2 && b.mr === 2 ? typeRank(b.r.type) - typeRank(a.r.type) : 0)
        || (center
          ? distM(center.lat, center.lon, a.r.lat, a.r.lon) - distM(center.lat, center.lon, b.r.lat, b.r.lon)
          : a.r.name.length - b.r.name.length)
        || a.r.name.length - b.r.name.length);
      const best = scored[0].r;
      traceLandmark(
        `[${new Date().toISOString()}] findPoiByName(${clean}): ${rows.length} matches → ${best.name} (${best.name.length} chars)\n`);
      return { lat: best.lat, lon: best.lon, name: best.name, type: best.type, place_url: best.place_url ?? undefined, place_id: best.place_id ?? undefined };
    }
    // PHONETIC SPELLING PASS — the last resort before a MISS, and the one the
    // [16:11] capture needed: „VO BLIZINA NA KATOLICKA“ named the city's
    // Католичка, and every character-level pass above compared the client's
    // own «katolicka» against the map's «katolichka» and MISSed. Both sides
    // are folded through phoneticWordKeys() instead (see its note), word by
    // word. Two guards keep it honest:
    //   • it fires ONLY when every pass above found nothing, so it can never
    //     displace an exact / alias / starts-with / substring / token-set hit;
    //   • EVERY typed word must be a word of the row (the same "no guessing a
    //     different place" contract as the token-set pass — „Bunjakovec
    //     pekara“ stays a MISS), and the query must carry a word of its OWN
    //     („црква“ / „katedrala“ are venue vocabulary, and alone they would
    //     resolve to whichever church is nearest).
    // The last-resort passes only run for a needle long enough to be a NAME:
    // «moze» (4 letters) was phonetically bound to «Mezzo» by this block, and a
    // four-letter fold is pure guessing. Real short names are answered by the
    // exact/whole-word passes above.
    if (rows.length === 0 && clean.length >= FUZZY_NAME_MIN_LEN) {
      const want = phoneticWordKeys(clean);
      const distinctive = want.filter(w => !LEXICON_WORDS[w] && !STOPWORDS.has(w));
      if (want.length > 0 && distinctive.length > 0) {
        const wantSet = new Set(want);
        const phoneticRows = this.poiRows()
          .filter(r => categoryOk(r) && [...wantSet].every(w => this.phoneSetOf(r).has(w)))
          // A tenant must not answer for its venue (see the token-set pass).
          .filter(r => !this.isShop(r));
        if (phoneticRows.length > 0) {
          const extra = (r: PoiIndexRow): number => this.phoneOf(r).length - wantSet.size;
          // Same tie-breaks as the substring pass above (fewest extra words,
          // then the nearest branch, then the SHORTER name), so the SAME place
          // answers for either spelling: «Католичка» (the map's own letters)
          // and «KATOLICKA» (the client's) must not name two different
          // churches.
          phoneticRows.sort((a, b) =>
            extra(a) - extra(b)
            || (center
              ? distM(center.lat, center.lon, a.lat, a.lon) - distM(center.lat, center.lon, b.lat, b.lon)
              : a.name.length - b.name.length));
          const best = phoneticRows[0];
          traceLandmark(
            `[${new Date().toISOString()}] findPoiByName(${clean}): PHONETIC ${phoneticRows.length} matches → ${best.name} (${best.lat},${best.lon})\n`);
          return { lat: best.lat, lon: best.lon, name: best.name, type: best.type, place_url: best.place_url ?? undefined, place_id: best.place_id ?? undefined };
        }
      }
      // SPELLING-VARIANT PASS — the same last-resort contract as the phonetic
      // pass above, one level deeper: both sides fold through the harvested
      // name-variant table, so «mol» ≡ «mall», «siti» ≡ «city», «паркинг» ≡
      // «parking» (see NAME_VARIANT_SEED / loadNameVariants). The checks are
      // identical: every typed word must be a word of the row, and the query
      // must carry at least one DISTINCTIVE word (venue vocabulary alone —
      // „parking“, „mall“ — would otherwise resolve to the nearest one).
      // TYPO PASS — the last resort of all (see typoBest).
      const typoHit = this.typoBest(clean, center);
      if (typoHit) {
        traceLandmark(
          `[${new Date().toISOString()}] findPoiByName(${clean}): TYPO → ${typoHit.name}\n`);
        return { lat: typoHit.lat, lon: typoHit.lon, name: typoHit.name, type: typoHit.type, place_url: typoHit.place_url ?? undefined, place_id: typoHit.place_id ?? undefined };
      }
      const wantCanon = phoneticWordKeys(clean).map(w => canonicalWordKey(w));
      const canonDistinctive = wantCanon.filter(w => !LEXICON_WORDS[w] && !STOPWORDS.has(w));
      if (wantCanon.length > 0 && canonDistinctive.length > 0) {
        const wantSet = new Set(wantCanon);
        const variantRows = this.poiRows()
          .filter(r => categoryOk(r) && [...wantSet].every(w => this.canonSetOf(r).has(w)))
          .filter(r => !this.isShop(r));
        if (variantRows.length > 0) {
          const extra = (r: PoiIndexRow): number => this.phoneOf(r).length - wantSet.size;
          variantRows.sort((a, b) =>
            extra(a) - extra(b)
            || (center
              ? distM(center.lat, center.lon, a.lat, a.lon) - distM(center.lat, center.lon, b.lat, b.lon)
              : a.name.length - b.name.length));
          const best = variantRows[0];
          traceLandmark(
            `[${new Date().toISOString()}] findPoiByName(${clean}): VARIANT ${variantRows.length} matches → ${best.name} (${best.lat},${best.lon})\n`);
          return { lat: best.lat, lon: best.lon, name: best.name, type: best.type, place_url: best.place_url ?? undefined, place_id: best.place_id ?? undefined };
        }
      }
    }
    // NOTHING BUT TENANTS MATCHED: answer with the tenant after all. A client
    // who names «Kipper Market» must still find the shop — the venue-first
    // rule above only decides WHICH row wins when a real venue is available.
    if (shopFallback.length > 0) {
      const best = shopFallback.sort((a, b) => a.name.length - b.name.length)[0];
      return { lat: best.lat, lon: best.lon, name: best.name, type: best.type, place_url: best.place_url ?? undefined, place_id: best.place_id ?? undefined };
    }
    return undefined;
  }

  /** TYPO-TOLERANT LOOKUP — one slipped letter inside a long word.
   *  Tolerant by design (the owner's call): the row carrying the FEWEST extra
   *  words wins („Diamond Mall“ beats „Vero Market - Diamond Mall“), the slip
   *  budget is one per name, digits/short words stay exact, and a true tie
   *  returns undefined — two places equally close to the client's words is
   *  exactly when we ask instead of guess.
   *
   *  It runs at the END of findPoiByName (never displacing an exact hit) and is
   *  exposed on its own for callers that already know the exact lookup failed:
   *  the handler asks for it after its coverage guard refused a fuzzy hit. */
  private typoBest(clean: string, center?: { lat: number; lon: number }): { name: string; type: string; lat: number; lon: number; place_url?: string; place_id?: string } | undefined {
    if (!this.db) return undefined;
    // The same CATEGORY veto the exact passes use: a hospital can never become
    // an academy because one letter slipped.
    const wantCategory = placeCategory(clean);
    const categoryOk = (row: PoiIndexRow): boolean => {
      if (!wantCategory) return true;
      const have = this.catOf(row);
      return !have || have === wantCategory;
    };
    const qWords = clean.split(/[^0-9\p{L}]+/u).filter(w => w.length >= 3);
    if (qWords.length === 0) return undefined;
    const qKeys = qWords.map(w => canonicalWordKey(w));
    const rows = this.poiRows()
      .filter(r => {
        if (!categoryOk(r) || this.isShop(r)) return false;
        const rWords = this.typoWordsOf(r);
        const rKeys = this.typoKeysOf(r);
        const used = new Set<number>();
        for (let qi = 0; qi < qKeys.length; qi++) {
          let at = rKeys.findIndex((k, i) => !used.has(i) && k === qKeys[qi]);
          // THE SLIP IS PER WORD (the same "more tolerant" call the handler's
          // coverage guard follows): every typed word may carry its own one
          // slip, while the WORD COUNT still has to fit — a typo can misspell
          // a word, never add, drop or re-order one.
          if (at === -1) {
            at = rKeys.findIndex((k, i) => !used.has(i)
              && qWords[qi].length >= 5 && rWords[i].length >= 5
              && wordsAlmostEqual(qWords[qi], rWords[i]));
          }
          if (at === -1) return false;
          used.add(at);
        }
        return true;
      });
    if (rows.length === 0) return undefined;
    const extras = (r: PoiIndexRow): number => this.typoWordsOf(r).length;
    rows.sort((a, b) => extras(a) - extras(b)
      || (center
        ? distM(center.lat, center.lon, a.lat, a.lon) - distM(center.lat, center.lon, b.lat, b.lon)
        : a.name.length - b.name.length));
    // A TIE BETWEEN BRANCHES OF ONE PLACE IS NOT A TIE: «Еурофарм» has a dozen
    // branches, all the same name — the nearest one answers. A tie between
    // DIFFERENT places one letter apart («KAM» / «KAN») stays a MISS.
    if (rows.length > 1 && extras(rows[0]) === extras(rows[1])) {
      if (this.idKeyOf(rows[0]) !== this.idKeyOf(rows[1])) return undefined;
    }
    return rows[0];
  }

  /** The typo-tolerant lookup as a MISS-RECOVERY call: the client's words, one
   *  slip allowed, the best row — or undefined. Never used before the exact
   *  passes; see typoBest(). */
  findPoiByNameLoose(name: string, center?: { lat: number; lon: number }): { lat: number; lon: number; name: string; type?: string; place_url?: string; place_id?: string } | undefined {
    // The same generic-word veto as findPoiByName: the typo pass must never
    // rescue the word the exact lookup just refused.
    if (refusesGenericNeedle((name ?? '').replace(/^(?:кај|спроти|как)\s+/i, '').trim())) return undefined;
    const best = this.typoBest((name ?? '').trim(), center);
    return best ? { lat: best.lat, lon: best.lon, name: best.name, type: best.type, place_url: best.place_url ?? undefined, place_id: best.place_id ?? undefined } : undefined;
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
    db.prepare(`INSERT INTO pois (name, type, lat, lon, source, place_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(place_id) DO UPDATE SET name = excluded.name, lat = excluded.lat, lon = excluded.lon`)
      .run(cleanPoiName(p.name), p.type, p.lat, p.lon, 'osm', p.place_id ?? null);
    added++;
  }

  // --- Replaces (fix wrong coords — phantom embassy etc.) ---
  for (const r of ov.replaces ?? []) {
    if (!r.name || !r.type || !Number.isFinite(r.lat ?? NaN) || !Number.isFinite(r.lon ?? NaN)) continue;
    const del = db.prepare('DELETE FROM pois WHERE name = ?').run(r.name);
    db.prepare(`INSERT INTO pois (name, type, lat, lon, source, place_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(place_id) DO UPDATE SET name = excluded.name, lat = excluded.lat, lon = excluded.lon`)
      .run(cleanPoiName(r.name), r.type, r.lat, r.lon, 'osm', r.place_id ?? null);
    added += del.changes + 1;
  }

  // --- Addresses (exact house numbers OSM never mapped, e.g. Стефановски 16) ---
  for (const a of ov.addresses ?? []) {
    if (!a.street || !Number.isFinite(a.lat ?? NaN) || !Number.isFinite(a.lon ?? NaN)) continue;
    const street = cleanStreetName(a.street);
    const key = streetKey(street);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM addresses WHERE key = ? AND housenumber = ?')
      .get(key, a.housenumber ?? '') as { n: number }).n;
    if (n > 0) continue;
    db.prepare('INSERT INTO addresses (street, housenumber, lat, lon, key) VALUES (?, ?, ?, ?, ?)')
      .run(street, a.housenumber ?? '', a.lat, a.lon, key);
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
  pois: Array<{
    name: string; type: string; lat: number; lon: number; source?: string;
    place_url?: string; place_id?: string;
    // THE SCRAPER CONTRACT: full SerpApi capture (all optional — OSM rows
    // carry none of these).
    review_count?: number | null; rating?: number | null; plus_code?: string | null;
    phone?: string | null; website?: string | null; price_level?: string | null;
    closed?: number | null; types?: string | null;
  }>,
  addresses: Array<{ street: string; housenumber: string; lat: number; lon: number; source?: string }>,
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
        place_id TEXT,
        review_count INTEGER,
        rating REAL,
        plus_code TEXT,
        phone TEXT,
        website TEXT,
        price_level TEXT,
        closed INTEGER NOT NULL DEFAULT 0,
        types TEXT,
        UNIQUE (place_id)
      );
      CREATE INDEX idx_pois_lat ON pois(lat);
      CREATE TABLE addresses (
        street      TEXT NOT NULL,
        housenumber TEXT NOT NULL DEFAULT '',
        lat         REAL NOT NULL,
        lon         REAL NOT NULL,
        key         TEXT NOT NULL,
        source      TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_addr_key ON addresses(key);
    `);

    // Wrap ALL inserts in a single transaction — 10-100x faster than
    // auto-commit per row.
    const insertAll = db.transaction(() => {
      // Upsert by place_id: re-scrapes UPDATE the existing Google row
      // instead of INSERT OR IGNORE-ing a duplicate. OSM rows (place_id=NULL)
      // are NOT affected — they still INSERT normally.
      // Uses ON CONFLICT(place_id) which maps to the table's UNIQUE(place_id)
      // constraint. SQLite's standard UNIQUE allows multiple NULLs, so OSM
      // rows (NULL place_id) never conflict.
      const insPoi = db.prepare(`INSERT INTO pois (
        name, type, lat, lon, source, place_url, place_id,
        review_count, rating, plus_code, phone, website, price_level, closed, types
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(place_id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        lat = excluded.lat,
        lon = excluded.lon,
        source = excluded.source,
        place_url = COALESCE(excluded.place_url, pois.place_url),
        review_count = excluded.review_count,
        rating = excluded.rating,
        types = excluded.types,
        closed = excluded.closed`);
      for (const p of pois) insPoi.run(
        cleanPoiName(p.name), p.type, p.lat, p.lon, p.source ?? 'osm', p.place_url ?? null, p.place_id ?? null,
        p.review_count ?? null, p.rating ?? null, p.plus_code ?? null, p.phone ?? null,
        p.website ?? null, p.price_level ?? null, p.closed ?? 0, p.types ?? null,
      );
      console.log(`[skopje-map] inserted ${pois.length} POIs`);

      const insAddr = db.prepare('INSERT INTO addresses (street, housenumber, lat, lon, key, source) VALUES (?, ?, ?, ?, ?, ?)');
      for (const a of addresses) {
        const street = cleanStreetName(a.street);
        insAddr.run(street, a.housenumber, a.lat, a.lon, streetKey(street), a.source ?? '');
      }
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
 *  failed pull never leaves a half-written map for the resolver.
 *
 *  Fix E — REBUILD PROTECTION: before writing, carry Google-enriched rows
 *  (place_id + review/rating data) from the existing DB into the rebuild.
 *  Without this, writeMap() would wipe the ~3,200 Google-anchored rows every
 *  time buildSkopjeDb runs, since it creates a fresh DB from OSM-only fetchPois.
 *  Merging Google rows into the pois array + the ON CONFLICT upsert in writeMap
 *  makes the map rebuild-safe WITHOUT a cron or internet dependency: Google
 *  data persists forever unless the place_id row is explicitly removed.
 */
export async function buildSkopjeDb(dbPath: string): Promise<MapStats> {
  const [pois, addresses] = await Promise.all([fetchPois(), fetchAddresses()]);

  // Carry Google-enriched rows through the rebuild.
  try {
    if (existsSync(dbPath)) {
      const existing = new Database(dbPath, { readonly: true });
      const googlePois = existing.prepare(
        `SELECT name, type, lat, lon, source, place_url, place_id,
           review_count, rating, plus_code, phone, website, price_level, closed, types
           FROM pois WHERE place_id IS NOT NULL`
      ).all() as Array<{
        name: string; type: string; lat: number; lon: number; source?: string;
        place_url?: string; place_id?: string;
        review_count?: number | null; rating?: number | null; plus_code?: string | null;
        phone?: string | null; website?: string | null; price_level?: string | null;
        closed?: number | null; types?: string | null;
      }>;
      existing.close();
      if (googlePois.length > 0) {
        console.log(`[skopje-map] carrying ${googlePois.length} Google-enriched POIs through rebuild`);
        pois.push(...googlePois);
      }
    }
  } catch {
    // Existing DB missing or unreadable — fresh build (e.g., first run).
  }

  return writeMap(dbPath, pois, addresses);
}
