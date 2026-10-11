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
  mall: 5, school: 4, university: 4, hospital: 4, clinic: 4,
  police: 4, fire_station: 4,
  // Parks live with the institutions: "спроти паркот"/"кај паркот" is how
  // people locate a building, and a PARK IS THE PLACE ITSELF while a bus stop is
  // merely named after one. Ranking transit above it produced the 2026-10-11
  // answer at Бул. АСНОМ 134: the reply said "во близина на Парк Аеродром" —
  // which is a BUS STOP 95m away — while „Парк Авионче“ (the park actually
  // across the boulevard, 180m, the neighbourhood's best-known place) never
  // appeared. A client reads that name as the park and walks to the wrong spot.
  park: 4, kindergarten: 3, fuel: 2, atm: 2,
  cathedral: 3, place_of_worship: 3, church: 3, mosque: 3,
  pharmacy: 3, supermarket: 3, museum: 3, stadium: 3,
  artwork: 3, monument: 3, memorial: 3,
  // Transit stops — below the places they are named after, above nothing more
  // than shops: "спроти автобуската" is common speech, but a stop is never the
  // landmark the neighbourhood is known by. Named stops only enter the map.
  bus_station: 3, tram_station: 3, tram_stop: 3,
  bank: 2, gallery: 2, theatre: 2, library: 2,
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
};
export function typeRank(type: string | null | undefined): number {
  const t = normType(type);
  return LANDMARK_PREFERENCE[TYPE_ALIASES[t] ?? t] ?? 0;
}