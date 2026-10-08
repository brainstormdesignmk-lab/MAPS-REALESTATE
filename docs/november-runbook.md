# NOVEMBER RUNBOOK — "Close the grid, then ship it"

**Goal:** finish the POI coverage grid (the last **510** tile×category pairs), run the
free tail to completion (B2 → B3 → C → D), and ship the finished map to the bots.

**Supersedes** `october-runbook.md`. October's expensive steps (teach unknown
streets, teach thin numbers ≈ 500–1,000 searches) turned out **unnecessary** — the
census came back **813 known / 1 thin / 0 unknown**, so there is nothing to teach.
The only work left is the grid.

**Where it runs:** this dev machine (Lenovo). The bot machines only ever receive
files.

**Design rule for every step:** idempotent. Re-running after an interruption
re-spends nothing already done.

---

## 0. Where the map actually stands (verified 2026-10-08, not estimated)

| Fact | Value | How it was measured |
|---|---|---|
| Grid | **135 tiles × 15 categories = 2,025 pairs** | `planCoverage()` |
| Ledger scanned | **1,515** | `SELECT COUNT(*) FROM tile_scans` |
| **Pairs still unscanned** | **510** | `planCoverage().uncoveredPairs` |
| Tiles with a gap | 36 of 135 | same |
| POIs | **6,248** (google 1,622 / osm 4,626) | `SELECT COUNT(*)` |
| Google rows with coordinates | 1,660 | `place_id IS NOT NULL` |
| OSM rows carrying a rating | **147** (was 61 before the merge) | rating backfilled by B2 |
| Keys | **8** (free plan, 250/month each) | `GOOGLEMAPS_API_KEY.txt` |
| Budget now | 20 searches (exhausted until the November reset) | `/account` probe |

**Budget for November: 8 × 250 = 2,000 searches. Needed: 510 (+ a few for the
drain). That is ~2.1 keys — the pass is trivially affordable.**

---

## 1. THE `--full` MODE — read this first or the run silently does nothing

`categoriesForRun()` decides by calendar: **full pass only in Jan/Apr/Jul/Oct**
(`getUTCMonth() % 3 === 0`). Measured for real:

```
month 10/2026  auto → 15 categories   (October = a full quarter month)
month 11/2026  auto →  2 categories   (supermarket, pharmacy)
month 12/2026  auto →  2 categories
```

**A plain `npm run refresh` in November considers only 135 × 2 = 270 pairs, works
on just 66 of the 510 gaps, and leaves 444 open — while printing a successful
summary.** That is the silent-failure mode that must never happen again.

> **November MUST be run as:**
> ```bash
> npx tsx scripts/refresh-monthly.ts --full
> ```

---

## 2. Preconditions (no budget)

```bash
cd ~/Documents/maps-realestate

# 1. Keys present — expect 8:
grep -cE '^[0-9A-Fa-f]{40,}$' GOOGLEMAPS_API_KEY.txt

# 2. Backup the map (rollback anchor for everything):
cp data/skopje-pois.db "data/skopje-pois.db.pre-november"

# 3. Prove the budget actually reset (FREE — /account consumes nothing):
node tmp/probe-keys.js | tail -5          # expect ~2,000 total searches left

# 4. Confirm the DB is healthy before spending anything:
node -e "const D=require('better-sqlite3');const db=new D('data/skopje-pois.db',{readonly:true});console.log('integrity',db.prepare('PRAGMA integrity_check').get().integrity_check,'| pois',db.prepare('SELECT COUNT(*) c FROM pois').get().c,'| ledger',db.prepare('SELECT COUNT(*) c FROM tile_scans').get().c);db.close()"
```

**Abort if:** keys < 6, the backup file is missing, or the budget probe shows less
than ~600 searches (the reset didn't happen — re-key before running).

---

## 3. DECISION GATE — the free dry run (0 searches)

```bash
npx tsx scripts/refresh-monthly.ts --full --dry-run 2>&1 | tee data/logs/nov-dryrun.log
```

Read these two lines and **do not proceed until they look right**:

```
Cadence: --full — 15 categories          ← must say 15, never 2
ESTIMATED SEARCHES to finish the pass: N ← the authoritative number to spend
```

`N` is computed from the ledger and existing Google evidence (it also *seeds* the
ledger from tiles that already hold a real Google POI of that category — that is
honest evidence, not a phantom scan). On 2026-10-08 it reported **510**.

**Abort if** the cadence line says 2 categories, or `N` exceeds ~1,600 (budget).

---

## 4. THE MERGE PRINCIPLE — why the remaining scrapes must run through B2

This is the single most important thing to preserve on every future scrape.

### What the merge is

An OSM row and a Google row often describe **the same physical place**: OSM has the
bilingual (Cyrillic) name, Google has the exact pin plus rating/reviews/phone.
Serving both is a duplicate; serving only the Google one loses the Cyrillic name.

The merge makes **one row** out of the pair, keeping the **OSM survivor** so the
Cyrillic name lives on, and pulling Google's data onto it:

```
mergePair(osmRowid, anchor):
  1. dropAnchor    DELETE FROM pois WHERE rowid = <anchor> AND place_id = <pid>
  2. mergeIntoOsm  UPDATE pois SET lat, lon, place_id,
                     review_count = COALESCE(?, review_count),
                     rating       = COALESCE(?, rating),
                     plus_code    = COALESCE(?, plus_code),
                     phone        = COALESCE(?, phone),
                     website      = COALESCE(?, website),
                     price_level  = COALESCE(?, price_level),
                     place_url    = COALESCE(?, place_url),
                     types        = COALESCE(?, types)
                   WHERE rowid = <osmRowid>
```

**Three rules that must not be broken:**

1. **Order matters.** The anchor releases the identity *before* the OSM row takes
   it. Doing it the other way round makes the pair momentarily share a `place_id`
   and `idx_pois_place_id_unique` rejects the UPDATE
   (`SQLITE_CONSTRAINT_UNIQUE`). Both statements are one transaction, so a failure
   rolls back — the anchor is never lost.
2. **`COALESCE` everywhere.** A merge must never erase a value the row already has.
3. **Only merge a pair the anchor solely owns.** Guard:
   `SELECT rowid FROM pois WHERE place_id = ?` must return the anchor's own rowid.
   Otherwise adopt the exact pin only and leave identity alone (never throw).

Identity is decided by `identityHeal` (tier 3 embassy uniqueness → tiers 1+2
proximity + bilingual name agreement), preceded by `stripBlindFusions`, which
undoes any pre-guard fusion to a *wrong* anchor so the row can be healed correctly.

### Proof the principle works (measured, not asserted)

| | before merge | after merge |
|---|---|---|
| OSM rows carrying a rating | 61 | **147** |
| OSM rows carrying a phone | 53 | **102** |
| OSM rows carrying types | 63 | **157** |
| duplicate `place_id` | 0 | **0** |
| POIs | 6,342 | 6,248 (94 absorbed anchors) |

Served output after the merge — **one** entry per place, Cyrillic name + Google data:

```json
{"name":"Македонско село","place_id":"0x13541152214d7bf9:…","review_count":1132,"rating":4.4}
{"name":"Маркет зур","place_id":"0x135413691c3cb4b5:…","review_count":124,"rating":4.1}
```

A second pass merges **0** rows — it is idempotent.

### How this applies to the remaining scrapes

Every tile×category scan in November will insert **new Google POIs**, and each of
those can create a fresh OSM/Google twin. Therefore:

- **Never skip Phase B2.** It is the step that folds the new twins in. Phase B2
  costs **0 searches**.
- **Never widen the unique index** or delete it — the merge above is what makes it
  compatible. Relaxing it would let both rows survive, and the map reader's
  `place_id` collapse keeps the **Google** name (proven by
  `tests/dedupe.test.ts`: *"google anchor wins even when OSM row is closer"*), so
  the Cyrillic name would be **lost from the map**.
- After the run, confirm the merge did its job (§6 checks) rather than assuming it.

---

## 5. THE RUN — one command

```bash
npx tsx scripts/refresh-monthly.ts --full 2>&1 | tee data/logs/november-refresh.log
```

Phases, in order, with their real cost:

| Phase | What it does | Searches |
|---|---|---|
| A | Overpass OSM restore (POIs + named bus/tram stops) | 0 |
| B | SerpApi top-up — **135 tiles × 15 categories**, full capture (place_id, review_count, rating, plus_code, phone, website, price_level, closed, types), bbox-gated at insert, every formatted address harvested into `learnAddress` | **~510** |
| B2 | `stripBlindFusions` → `identityHeal` — **the merge** | 0 |
| B3 | batch-teach feed-property streets the map can't resolve | 0–5 |
| C | queue drain — `geo_reresolve_queue` (5 rows: EB 76, 78, 89, 90, 91) geocoded, patched to Supabase, map taught | 0–5 |
| D | poison sweep — re-check low-confidence landmarks | 0 |

**Wall time:** measured at **4.4 s per real search** (not the 1.1 s sleep — HTTP
latency dominates), so ~510 searches ≈ **38 minutes**. Budget for ~1 hour.

### The two spending traps that broke the October run — both now fixed, do not undo them

1. **A throttled/rejected response must never count as a scan.** SerpApi enforces
   **250 searches per HOUR per account** on top of the monthly 250. On 2026-10-08
   the code paced at 1.1 s (~3,270/hour) and wrote every rejection into the ledger
   as "scanned": **730 pairs were marked done with no data behind them**, and the
   ledger's own promise ("never repeated") meant they would never be retried. They
   were found by the timing signature (4.41 s median for real searches vs 1.37 s
   for rejects, cut at record 500) and re-scanned.
   Now: a rejection returns `null` — no spend, **no ledger write** — a throttled key
   is blocked for the rolling hour and **rotated past**, and successful searches
   round-robin across keys.
2. **The spend guard must re-probe `/account` before giving up.** A stale local
   counter once reported "19 left" while the truth was ~770, abandoning the pass.
   `/account` is free; the guard now re-probes.

**Abort and resume rule:** if keys throttle, let the run stop cleanly — it leaves
everything unscanned, unspent, and the ledger truthful. Re-run the same command the
next hour or day; it resumes exactly where it stopped.

> `--rescan=<file.json>` exists ONLY for repairing an explicit list of pairs
> (the 730-hole repair). It bypasses the ledger's "already scanned" filter on
> purpose. **Never use it casually** — it re-spends on paired tiles. A normal
> run never needs it.

---

## 6. VERIFY — the deliverable (all free)

```bash
# a) Coverage is closed
npx tsx scripts/refresh-monthly.ts --full --dry-run   # expect: ESTIMATED SEARCHES: 0
                                                      # (a handful is fine only if budget ran out)

# b) The merge did its job and the DB is sound
node -e "const D=require('better-sqlite3');const db=new D('data/skopje-pois.db',{readonly:true});
console.log('integrity   :',db.prepare('PRAGMA integrity_check').get().integrity_check);
console.log('dup place_id:',db.prepare('SELECT COUNT(*) c FROM (SELECT place_id FROM pois WHERE place_id IS NOT NULL GROUP BY place_id HAVING COUNT(*)>1)').get().c);
console.log('osm rated   :',db.prepare(\"SELECT COUNT(*) c FROM pois WHERE source='osm' AND rating IS NOT NULL\").get().c);
console.log('osm phone   :',db.prepare(\"SELECT COUNT(*) c FROM pois WHERE source='osm' AND phone IS NOT NULL\").get().c);
console.log('pos/ledger  :',db.prepare('SELECT COUNT(*) c FROM pois').get().c,'/',db.prepare('SELECT COUNT(*) c FROM tile_scans').get().c);
console.log('queue       :',db.prepare('SELECT COUNT(*) c FROM geo_reresolve_queue').get().c);db.close()"

# c) Streets still complete (nothing regressed)
npm run census -- --verify

# d) Contamination / suspect rotation pairs
npm run suspect-pairs

# e) The test suite
npm run typecheck && npm test
```

**Pass criteria:**

| Check | Expected |
|---|---|
| `ESTIMATED SEARCHES` | **0** |
| ledger rows | **2,025** (= 135 × 15) |
| duplicate `place_id` | **0** |
| `integrity_check` | **ok** |
| OSM rows carrying a rating | **≥ 147** (grows with the merge) |
| `geo_reresolve_queue` | **0** (Phase C drained it) |
| census | still ~813 known, 0 unknown |
| tests | all green |

**Rollback:** `cp data/skopje-pois.db.pre-november data/skopje-pois.db` reverts
everything.

---

## 7. SHIP IT — Atom 1 and the data hub

The map is produced here; the bots only ever receive the file. Ship **after** §6
passes, and never copy SQLite hot.

```bash
# 1. A consistent snapshot (safe even while something reads the DB):
sqlite3 data/skopje-pois.db ".backup '/tmp/skopje-pois.db.november'"

# 2. Ship to Atom 1 with checksum verification (refuses a broken map):
#    <remote-dir> = the bot's inbound_final directory ON THE ATOM (confirm once with
#    `ssh atom01 'ls -d ~/*/secretaries/inbound_final ~/inbound_final 2>/dev/null'`).
scripts/deploy_map.sh atom01 <remote-dir>
```

`deploy_map.sh` verifies the DB opens and has >1,000 POIs, writes a sha256 sidecar,
backs up the target's old copy to `skopje-pois.db.bak-<stamp>`, extracts, and
compares checksums — a mismatch restores the backup automatically.

Then restart the bot on the target and confirm the printed `[db:xxxxxxxx]` matches.

> **Known blocker (2026-10-08):** `ssh atom01` fails with
> `atom02@192.168.1.11: Permission denied (publickey,password)`. The host is up and
> `~/.ssh/id_ed25519_atom01` exists locally, but its public key is not in the
> atom's `authorized_keys`. **Fix before November** (one command on the atom):
> ```bash
> # from this machine
> ssh-copy-id -i ~/.ssh/id_ed25519_atom01.pub atom01
> # verify
> ssh atom01 'hostname && node -v'
> ```
> `T60` (`t60hermes`, 192.168.1.20) authenticates fine and can be used meanwhile.

---

## 8. FLOWLESS-CLOSE THE LOOP — the LINA-side deployment (do not skip)

The map is worthless to the bots if the assistant cannot read the fields. On
2026-10-08 LINA answered *"КАЈ СЕ НАОЃА 76?"* with
**"Тоа се наоѓа во населбата Центар."** while the row already held
`lat 41.996 / lon 21.4172`, `geo_source: google_cached`, and **4 resolved
landmarks**. Cause: the feed function `public-properties` had stopped emitting
`lat`, `lon`, `geo_source`, `geocoded_at` **and** never emitted `landmarks` at all.

**Which Supabase project is real (verified by row counts, do not guess):**

| Project | Ref | State |
|---|---|---|
| **QKGIO — LIVE** | `qkgioqotxjxffiaufgwd` | 45 properties, 45 with `lat`, 39 with `landmarks`, `public-properties` **v8-20261008** |
| FREEBUFF — **EMPTY** | `euuaycmxfqiruspwjxhd` | `properties 0 rows`, `property_images 0`, `hermes_events 0`, `landmarks 0`, function **v7-20250202, count 0** |

> **LINA reads QKGIO.** The worked-on repo has `supabase link` pointed at the
> **empty FREEBUFF** project, and `.env.example` calls FREEBUFF "the properties
> feed" — both are misleading. **Deploying the edge function while linked to
> FREEBUFF publishes into the void.** Re-link first:
> ```bash
> cd ~/Documents/real-estate-atoms/secretaries/inbound_final
> supabase link --project-ref qkgioqotxjxffiaufgwd
> supabase functions deploy public-properties --no-verify-jwt
> ```
> Note `scripts/deploy-supabase.sh` does **not** deploy `public-properties` at all —
> that omission is exactly how the function drifted. The corrected source lives at
> `supabase/functions/public-properties/index.ts` (version `v9-20261008-landmarks`,
> now selecting `landmarks,landmarks_resolved_at` plus the geo columns).
> **Verify** the live payload's `version` reads `v9-20261008-landmarks` and its
> rows carry `lat/lon/landmarks` — do not trust the deploy command's exit code.

**The bot also needs a rebuild** — `ecosystem.config.js` runs `./dist/index.js`
under pm2, so a `src/` fix does nothing until:
```bash
cd ~/Documents/real-estate-atoms/secretaries/inbound_final
npm run build && pm2 restart metropolis-lina
```

**Acceptance test (the whole point of the map):** ask the bot
**"КАЈ СЕ НАОЃА 76?"**. Expected, with no network:

> Тоа се наоѓа во близина на Trgovski centar „Kapištec.
> https://maps.google.com/?cid=779770506876171031

i.e. a **nearby landmark with a coordinate place-card link** — never the bare
neighborhood, and never a `maps/search/?api=1&query=` name-search URL (banned; the
feed's stored `maps_url` is that banned form, so the pin is re-resolved from the
offline POI table by `place_id`).

---

## 9. ONE-PAGE CHECKLIST

```
[ ]  1  keys = 8;  /account probe shows ~2,000 left
[ ]  2  cp data/skopje-pois.db data/skopje-pois.db.pre-november
[ ]  3  DB health: integrity ok, pois 6,248, ledger 1,515
[ ]  4  --full --dry-run  →  "15 categories"  AND  "~510 searches"
[ ]  5  --full            →  ~38 min, ~510 searches, ends cleanly
[ ]  6  --full --dry-run  →  "ESTIMATED SEARCHES: 0"
[ ]  7  ledger = 2,025 ; dup place_id = 0 ; integrity ok
[ ]  8  osm rated ≥ 147  (the merge ran) ; queue = 0 (Phase C ran)
[ ]  9  census --verify green ; suspect-pairs ; typecheck + tests
[ ] 10  sqlite3 .backup → /tmp/skopje-pois.db.november
[ ] 11  scripts/deploy_map.sh atom01 <path>  → checksum match
[ ] 12  atom: [db:xxxxxxxx] matches ; bot answers "76" with a landmark + pin
[ ] 13  deploy public-properties v9 to QKGIO (NOT FREEBUFF) ; npm run build + pm2 restart
```

**Expected totals for November:** ~510–520 searches (**~2.1 keys** of the 2,000
available), ~40 minutes wall time, 0 searches for the whole B2→B3→C→D tail.

---

## 10. What is NOT part of this run (so nobody chases them)

- **`plus_code` and `closed` are structurally empty** — verified with a live
  response: the `google_maps` list engine returns them for **0/20** places. They
  need a per-place call (one search each); not worth it.
- **`place_url` is 0/1,600** — `scripts/capture-place-urls.ts` has never been run
  over the map (it needs headless Chrome). Links therefore use `place_id` → `cid`
  or a coordinate pin, which is what the bot already does.
- **"Visits" does not exist** in this API or the schema. Nothing to scrape.
- **Ranking intentionally ignores `rating`.** Prominence is
  `log10(review_count + 1)` (fame, not quality): people say *"кај Рамстор"*. A
  rating-weighted ladder would flip **14.6%** of nearby same-type pairs and demote
  the 2.8★/566-review bus station. `rating` is now **served** as display data.
