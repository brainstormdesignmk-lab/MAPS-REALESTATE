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
  cathedral: 3, place_of_worship: 3, church: 3, mosque: 3,
  pharmacy: 3, supermarket: 3, museum: 3, stadium: 3,
  bank: 2, park: 2, gallery: 2, theatre: 2, library: 2,
  hotel: 2, cafe: 1, restaurant: 1,
};

/** Rank of a raw POI type (normalized first). Unknown/empty → 0.
 *  Multi-word Google types normalize BEFORE lookup: "Shopping mall" →
 *  "shopping mall" → mall rank (5). Without this, the largest shopping
 *  center of a neighborhood (Beverly Hills) ranked 0 and lost to every
 *  bank/pharmacy — fixed by canonicalizing the compound forms. */
const TYPE_ALIASES: Record<string, string> = {
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