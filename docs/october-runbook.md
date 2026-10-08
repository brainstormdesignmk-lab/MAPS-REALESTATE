# OCTOBER RUNBOOK — "Every street Google knows, in one go"

**Goal:** after this run, every street we can *name* (feed history + local map + OSM)
resolves **trusted, offline, forever**. Street-level gaps go from a recurring bug
class to a permanently closed set.

**Where it runs:** the dev machine (not the T60). Fresh `skopje-pois.db` is
transferred to the T60 at the end (Step 8).

**Design rule for every step:** idempotent. Already-known streets are skipped,
failed geocodes leave rows as-is, and the whole runbook can be re-run after an
interruption without double-spending.

---

## 0. What is already wired (verified in code) vs. what must be built first

**Already in `refresh-monthly.ts` — nothing to build:**

| Mechanism | Where |
|---|---|
| Live-DB schema self-upgrade (8 capture columns) | `ensurePoiColumns` |
| Self-prune of out-of-bbox contamination (runs every start) | `pruneOutsideBbox` |
| Phase A: Overpass POI top-up + named bus/tram stops | Phase A |
| Phase B: quarterly full pass, 15 categories, every SerpApi field captured, bbox-gated | `categoriesForRun`, `capturePoi`, `insideSkopjeBbox` |
| Phase B3: batch-teach every feed property street the map can't resolve trusted | Phase B3 |
| Phase C: queue drain — geocodes queued properties AND teaches the map on every valid hit | `drainQueue` + `learnAddress` |
| Contamination report | `scripts/suspect-pairs.ts` |

**Must be built before October (small, unit-tested, ~1 day):**

1. `scripts/street-census.ts` — the **probe** (Step 2). Free: classifies every
   candidate street known / thin / unknown. No SerpApi calls.
2. `scripts/street-teach.ts` — the **teacher** (Step 3). One geocode per gap →
   bbox-validate → `learnAddress`. Flags: `--unknowns`, `--thin`, `--cap=N`, `--dry`.
3. **Phase B address harvest** — parse street+number from the formatted address of
   every captured place and `learnAddress` it. Zero extra searches; plugged into
   the Phase B insert loop.
4. `scripts/street-census.ts --verify` — the **coverage report** (Step 7).

---

## 1. Preconditions (15 min, no budget)

```bash
# 1. Fresh keys in place — count them, expect 7–8:
grep -cE '^[0-9a-f]{32}' GOOGLEMAPS_API_KEY.txt

# 2. Backup the map (rollback anchor for everything):
cp data/skopje-pois.db data/skopje-pois.db.pre-october

# 3. Fresh feed pull so the street census sees all current properties.
# 4. Sanity: the live DB is currently clean (0 rows outside bbox):
sqlite3 data/skopje-pois.db \
  "SELECT COUNT(*) FROM pois WHERE lat<41.95 OR lat>42.05 OR lon<21.35 OR lon>21.5;"
```

**Abort if:** keys < 6 (budget margin gone) or the backup file doesn't exist.

---

## 2. PROBE — the street census (free)

Builds the candidate set = **union** of:
- distinct streets in the local map's addresses table (the 7,674 backbone),
- every street ever seen in a feed address (incl. removed properties — this is
  where "Мирче Оровчанец" came from),
- OSM street list from Phase A data.

Each candidate runs through the **local** resolver and is classified:

| Class | Meaning | Action | Est. count |
|---|---|---|---|
| (a) known | street resolves trusted with numbers | skip | ~700–900 |
| (b) thin | street known, numbers missing/thin | geocode **only feed-carried numbers** | ~100–200 streets |
| (c) unknown | street not in the map at all | one geocode `"<street>, Скопје"` | ~200–400 |

```bash
npx tsx scripts/street-census.ts          # prints the three lists + projected cost
```

**DECISION GATE — do not spend before reading this output.** The census prints:

```
projected searches: class (c) = 312, class (b) = 447  →  total 759  (~3.5 keys)
```

If the projection exceeds **800 searches for streets** (Steps 3+4 together),
trim in this order: class (b) numbers → only numbers the feed carried ≥2 times;
then class (b) entirely (numbers arrive anyway via Phase B harvest + the monthly
B3 loop). Class (c) is never trimmed — it is the whole point.

---

## 3. TEACH unknown streets — class (c)

```bash
npx tsx scripts/street-teach.ts --unknowns --cap=400 --dry   # read the plan first
npx tsx scripts/street-teach.ts --unknowns --cap=400
```

Per street: one SerpApi geocode of `"<street>, Скопје, Северна Македонија"` →
`insideSkopjeBbox` validation → **`learnAddress(street, lat, lon)`** → the map
serves it trusted offline immediately. Rejected (outside bbox / miss) → stays
in the census residue, re-attempted by the standing monthly loop, never retried
in-run.

**Budget stop (local):** after every call, if total spend this session crosses
the session cap (Step 6 table), stop and jump to Step 4 — never below the
engine's `BUDGET_STOP = 20` anyway (hard stop in `queueDrain`).
**Pacing:** 1100 ms between calls (SerpApi 1 req/s) — 400 streets ≈ 8 min.
**429 storm:** abort the step, keep the residue, resume next day. One calm
retry per day, never a tight loop (the Sep 3 NIM lesson).

Expected: **200–400 searches (~1–2 keys).**

---

## 4. TEACH thin streets — class (b)

```bash
npx tsx scripts/street-teach.ts --thin --cap=600 --dry
npx tsx scripts/street-teach.ts --thin --cap=600
```

Geocode only the house numbers the feed has actually carried on each thin
street — not all numbers in existence. `learnAddress("Улица Број, Скопје", lat, lon)`
plants verified number-level points along the street.

**Budget stop:** same session cap; this class is first to be dropped if the
cap is threatened. Expected: **300–600 searches (~1.5–2.5 keys).**

---

## 5. HARVEST — the monthly script, one command

Now the map is street-rich; the quarterly pass layers POIs, identity, and the
free address harvest on top. **October is auto-full** (month index 9 →
`isFullPassMonth() = true`), so no flag is needed — but pass it explicitly so
the log states the cadence:

```bash
npx tsx scripts/refresh-monthly.ts --full 2>&1 | tee data/logs/october-refresh.log
```

What the run does, in order (all verified wired):

1. `ensurePoiColumns` — live DB gains the 8 capture columns
2. `pruneOutsideBbox` — map self-cleans (should report 0; Step 1 verified)
3. **Phase A** — Overpass restore: POIs + named bus/tram stops over the bbox (free)
4. **Phase B** — 36 tiles × **15 categories** (supermarket, mall, pharmacy, bank,
   school, hospital, embassy, hotel, museum, gas station, **bus station, post
   office, kindergarten, atm, fuel**), full capture: place_id, review_count,
   rating, plus_code, phone, website, price_level, closed, types — every row
   bbox-gated at insert, **every row's formatted address harvested** into
   `learnAddress` (zero extra searches; this is why class (b) can be trimmed)
5. **Phase B3** — batch-teach any feed-property street still unresolved
   (mostly no-ops after Steps 3–4; that's the loop closing)
6. **Phase C** — queue drain: EB 77 + the Sep-6 backlog (89/78/76) geocode,
   patch Supabase permanently (`google_cached`), teach the map

**Budget stops (engine-level, already in code):**
- `BUDGET_STOP = 20` — hard stop below 20 searches left; remaining tiles stay
  queued for a follow-up run, nothing is half-written
- keys rotate automatically; a run stops cleanly when all keys are exhausted
- 1100 ms pacing throughout — full run ≈ 45–60 min wall time

Expected: **~540–700 searches** (Phase B) + ~0–50 (B3+drain after teaching).

---

## 6. Budget ledger — the whole day

| Step | Searches | Keys (250/searches) |
|---|---|---|
| 3. teach (c) unknown streets | 200–400 | 1–2 |
| 4. teach (b) thin-street numbers | 300–600 | 1.5–2.5 |
| 5. Phase B full 15-cat | 540–700 | 2–3 |
| 5. B3 + drain | 0–50 | ~0 |
| **Total** | **~1,050–1,750** | **~4.5–7** |

**Session cap: 1,700 searches (7 keys).** Trip order when cap threatens:
drop class (b) numbers → switch Phase B to `--light` (rescues ~470 searches,
POIs re-topped next month) → class (c) is never dropped.
With 7–8 keys the expected total lands at ~5–6 keys — one clean pass, margin intact.

---

## 7. VERIFY — the coverage report (free)

```bash
npx tsx scripts/street-census.ts --verify   # re-runs the probe, prints before/after
npx tsx scripts/suspect-pairs.ts            # contamination + suspect rotation pairs
```

The report is the deliverable — archive it next to the backup:

```
STREET COVERAGE — October 2026
  candidate streets (feed ∪ map ∪ OSM):        1,204
  trusted before:                                791   (65.7%)
  trusted after:                               1,187   (98.6%)
  residue (Google miss / feed typo / outside bbox):  17
    → queued for the standing monthly loop (B3 + drain), no action needed
learned this run: 396 streets, 447 numbers, 512 Phase-B harvests
budget spent: 1,412 searches (5.6 keys), 0 rejected-by-bbox stored
```

Also verify three runtime behaviors offline (no network): EB 77 resolves trusted
with the full 3-landmark rotation (grace window no longer needed); a
`--pilot 3 --dry-run` map rebuild reports no suspect pairs; the test suite is
green.

**Rollback:** the whole run is one file —
`cp data/skopje-pois.db.pre-october data/skopje-pois.db` reverts everything.

---

## 8. TRANSFER to the T60

The update is produced here; the T60 only ever receives files:

```bash
# On the T60: stop the bot first (SQLite files must not be copied hot)
sqlite3 data/skopje-pois.db ".backup '/tmp/skopje-pois.db.october'"   # here: safe snapshot
scp /tmp/skopje-pois.db.october t60:~/.../secretaries/inbound_final/data/skopje-pois.db
```

Then on the T60: restart the bot, confirm in the log the map loaded, and ask it
"kade tocno se naogja?" for EB 77 — the answer should name a nearby landmark
with the map pin, straight from the new map, zero network.

The two existing cron lines (`30 0 * * *` enrich, `17 3 * * *` hermes) need
nothing — they operate on the transferred files and on Supabase, and the
standing monthly loop (B3 + drain) keeps the street set closed from here on.
