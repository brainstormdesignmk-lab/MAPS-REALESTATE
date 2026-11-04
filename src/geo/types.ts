// Shared POI-type normalization + landmark preference ranking.
//
// The pois table mixes source taxonomies: Google types are capitalized
// ("Pharmacy", "Supermarket", "Discount supermarket") while OSM types are
// lowercase snake_case ("pharmacy", "supermarket"), plus junk rows ("yes",
// "place", "residential"). All type comparisons go through normType() +
// typeRank() so a mall typed "Mall" / "MALL" / " mall " ranks identically.

/** Case-insensitive, whitespace-normalized type key. Empty input → ''. */
export function normType(t: string | null | undefined): string {
  if (!t) return '';
  return t.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Landmark quality rank — higher = better navigation anchor. */
export const LANDMARK_PREFERENCE: Record<string, number> = {
  // State/institutional anchors first: embassies, government, hospitals,
  // schools and malls are what people actually navigate by ("кај Амбасадата",
  // "кај Клинички"). A 30m embassy must beat a 100m pharmacy — rank sorts
  // BEFORE distance in nearestPois, so leaving diplomatic/embassy unranked
  // (→ 0) let pharmacies win every time.
  diplomatic: 5, embassy: 5, government: 5, townhall: 5,
  // Squares are THE city reference ("кај плоштадот") — the offline map's own
  // POI_PRIORITY ranks them first, and leaving them unranked here made the
  // rank-aware paths treat Македонија square as an unknown shop.
  square: 5, plaza: 5,
  mall: 5, school: 4, university: 4, hospital: 4, clinic: 4,
  // PUBLIC PLACES PEOPLE NAVIGATE BY (owner rule, 2026-10-29): markets,
  // theatres, cinemas, schools/universities, dormitories, hospitals and the
  // rest of the big public buildings are the landmarks a client means. Every
  // map row may still serve as a search anchor — the ladder only orders them,
  // so a travel agency at the door never answers ahead of the mall 200 m away.
  // Market/theatre/cinema sat at 0 or 2 and lost to banks and pharmacies.
  market: 4, cinema: 4, theatre: 4,
  // The rest of the big PUBLIC buildings people give directions by: the
  // courthouse, the cultural/community centre („кај Дом на култура“), and the
  // city's attractions — a fortress, the Old Bazaar, a museum quarter. They
  // rank with the institutions, never above the square/mall/dormitory tier.
  courthouse: 4, cultural_center: 4, community_centre: 4, attraction: 4,
  // Objects that anchor a spot but are not destinations in themselves.
  bridge: 3, post_office: 2,
  // Dormitories are BLOCK-level anchors: a student campus is a big public
  // building people navigate by ("кај Студентскиот дом Пелагонија"), and at
  // EB 94 it is the one nearby place a client actually recognises. Left
  // unranked (→ 0), that 63 m dorm lost to a 7 m supermarket AND to an
  // unranked "Inn" with Google review prominence — rank sorts BEFORE distance
  // here, so a missing type silently erased the most useful landmark. They sit
  // at the mall/town-hall tier so a 250 m+ suburban mall cannot push a campus
  // at the door out of the conversation. student_accommodation is the same
  // institution under its OSM label (Студентски дом Стив Наумов).
  dormitory: 5, student_accommodation: 5,
  police: 4, fire_station: 4,
  // Churches/cathedrals are the anchors people give directions by ("кај
  // Католичка црква"), yet they shared rank 3 with a pharmacy — inside the
  // 200 m ring the significance-first ranking then served the pharmacy. A
  // cathedral outranks a small shop, always.
  // Parks live with the institutions: "спроти паркот"/"кај паркот" is how
  // people locate a building, and a PARK IS THE PLACE ITSELF while a bus stop is
  // merely named after one. Ranking transit above it produced the 2026-10-11
  // answer at Бул. АСНОМ 134: the reply said "во близина на Парк Аеродром" —
  // which is a BUS STOP 95m away — while „Парк Авионче“ (the park actually
  // across the boulevard, 180m, the neighbourhood's best-known place) never
  // appeared. A client reads that name as the park and walks to the wrong spot.
  park: 4, kindergarten: 3, fuel: 2, atm: 2,
  cathedral: 4, place_of_worship: 4, church: 4, mosque: 4,
  pharmacy: 3, supermarket: 3, museum: 3, stadium: 3,
  artwork: 3, monument: 3, memorial: 3,
  // Transit stops — below the places they are named after, above nothing more
  // than shops: "спроти автобуската" is common speech, but a stop is never the
  // landmark the neighbourhood is known by. Named stops only enter the map.
  bus_station: 3, tram_station: 3, tram_stop: 3,
  bank: 2, gallery: 2, library: 2,
  hotel: 2, cafe: 1, restaurant: 1,
};

/** Rank of a raw POI type (normalized first). Unknown/empty → 0.
 *  Multi-word Google types normalize BEFORE lookup: "Shopping mall" →
 *  "shopping mall" → mall rank (5). Without this, the largest shopping
 *  center of a neighborhood (Beverly Hills) ranked 0 and lost to every
 *  bank/pharmacy — fixed by canonicalizing the compound forms. */
const TYPE_ALIASES: Record<string, string> = {
  // Google spells transit stops with spaces ("Bus stop", "Bus station"), OSM
  // uses bus_station. Left unaliased, the Google rows ranked 0 while the OSM
  // row for the SAME stop ranked 3 — the same stop twice, at two ranks.
  'bus stop': 'bus_station',
  'bus station': 'bus_station',
  'tram stop': 'tram_stop',
  'shopping mall': 'mall',
  'shopping centre': 'mall',
  'shopping center': 'mall',
  'shopping center complex': 'mall',
  'trade center': 'mall',
  'city district': 'subdistrict',
  // OSM/Google name the small-guesthouse class "Inn"; unaliased it ranked 0
  // and used its Google prominence to outrank real institutional anchors
  // (EB 94: "Accommodation Ara" beat Студентски дом Пелагонија). It is a
  // hotel-class place, so it ranks as one.
  inn: 'hotel',
  'boarding school': 'school',
  // The Google spellings of the same public classes. Unaliased, «Elementary
  // school», «High school», «General hospital», «Movie theater», «Market» and
  // «marketplace» all ranked 0 — i.e. BELOW a bank — while the OSM rows of the
  // same institution ranked 4. One institution, two ranks: the alias makes the
  // class rank the same whichever source wrote the row.
  'elementary school': 'school',
  'high school': 'school',
  'primary school': 'school',
  'secondary school': 'school',
  'school center': 'school',
  'educational institution': 'school',
  'general hospital': 'hospital',
  'movie theater': 'cinema',
  'marketplace': 'market',
  'green_market': 'market',
  'flower market': 'market',
  college: 'university',
  // Public-school spellings beyond the elementary/high pair, so a special or
  // international school is still a school (4) and never a rank-0 building.
  'international school': 'school',
  'special education school': 'school',
  'school for the deaf': 'school',
  'school for the visually impaired': 'school',
  prep_school: 'school',
  'sports school': 'school',
  // Small public-green and visitor classes from the same two taxonomies.
  preschool: 'kindergarten',
  'pre-school': 'kindergarten',
  'nursery school': 'kindergarten',
  'tourist attraction': 'attraction',
  'point of interest': 'attraction',
  'historical landmark': 'attraction',
  'cultural center': 'cultural_center',
  'cultural centre': 'cultural_center',
  'community center': 'community_centre',
  'community centre': 'community_centre',
  'post office': 'post_office',
  'outlet mall': 'mall',
  'bus depot': 'bus_station',
  'art gallery': 'gallery',
  'sports centre': 'stadium',
  'sports_hall': 'stadium',
  'art museum': 'museum',
  'history museum': 'museum',
  'archaeological museum': 'museum',
  'local history museum': 'museum',
  // A discount supermarket IS a supermarket: two ranks for one shop put the
  // neighbourhood's grocery below a cafe (0 vs 3).
  'discount supermarket': 'supermarket',
  'government office': 'government',
};
export function typeRank(type: string | null | undefined): number {
  const t = normType(type);
  // OSM writes multi-purpose buildings as "marketplace;fire_station". Left
  // whole, the compound ranked 0 and the public market inside it vanished
  // from the ladder — the best of the listed classes is what the place is.
  if (t.includes(';')) {
    return Math.max(...t.split(';').map(part => typeRank(part)));
  }
  return LANDMARK_PREFERENCE[canonicalType(type)] ?? 0;
}

/** The canonical class of a raw type, after normalization + aliasing.
 *  Audits and diagnostics use this to ask "is this class on the map?" without
 *  re-implementing the alias table. */
export function canonicalType(type: string | null | undefined): string {
  const t = normType(type);
  return TYPE_ALIASES[t] ?? t;
}