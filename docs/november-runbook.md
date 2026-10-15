# NOVEMBER RUNBOOK — "one command, and the exit code means something"

**Goal:** close the last **510** tile×category pairs, run the free tail
(B2 → B3 → C → D), and ship a map whose correctness is *enforced*, not eyeballed.

**Supersedes** `october-runbook.md`. October's expensive steps (teach unknown
streets, teach thin numbers ≈ 500–1,000 searches) turned out **unnecessary** —
the census came back **813 known / 1 thin / 0 unknown**, so there is nothing to
teach. The only work left is the grid.**Where it runs:** the box that OWNS the map — the workstation checkout whose
`data/skopje-pois.db` is the authoritative copy. **Verified 2026-10-15**, because
the old wording sent the operator to the wrong machine:

| machine | what its map is |
|---|---|
| **workstation** (`~/Documents/maps-realestate`) | **the authority** — 5,991 POIs, sha256 `09069dbc3899…` after the 2026-10-15 repair (§11) |
| **atom01** | the bot's map: `SKOPJE_POIS_DB=/home/atom/Documents/PROJECTS/maps-realestate/data/skopje-pois.db`. It is a **copy**; it only changes when you ship one |
| **T60** | **not the map hub.** It has no `/srv` at all, its `SKOPJE_POIS_DB` is empty, and its two copies are stale (`inbound_final/data` = 2026-10-08 sha `148b42f8460b…`; `maps-realestate/data` = 2026-09-05, **1 MB**, sha `4b9cddf284a5…`) |

Running the pass on T60 would work on a 1 MB map from September. Don't. Every
path is repo-anchored, and the run **prints the map path and its sha256 as its
first two lines**, so the log always names the file that was produced. Ship that
file (§8), and only to the path §8 gives.

**Design rule for every step:** idempotent. Re-running after an interruption
re-spends nothing already done.

---

## 0. What changed since October — the appliance-grade contract

These are the things that made a monthly run a source of surprise. Each is now
code, not tribal knowledge:

| Was | Now |
|---|---|
| `process.cwd()` decided which `skopje-pois.db` a run opened (and `new Database()` **created** a wrong-path map instead of failing) | `resolveMapDb()` — one absolute answer, repo-anchored; the run **refuses to start** if the map is missing (exit 2) |
| `DB_PATH=data/lina.db` resolved against each script's own cwd → four queue files, one drained | `resolveRuntimeDb()` — one canonical queue; `harvestQueues()` merges every stray copy into it first |
| The **calendar** picked the categories: full only in Jan/Apr/Jul/Oct, else 2 | **The complete pass is the default in every month.** The ledger decides what is actually spent, so "complete" is cheap |
| A timer decided when the map changed: monthly refresh, daily healthcheck, nightly landmark resolver, weekly map pull | **NO MAP JOB IS SCHEDULED (2026-10-14).** Every one of those lines is gone, and `install-cron.ts` is now the ENFORCER — `--check` fails while any MAP schedule exists, `--remove` strips it, `--install` refuses. The map is a fixed artifact until a human runs the pass. **The 5-minute owner price sync is NOT one of them**: it is required, never stripped, and checked with `--require-sync` |
| "The map is correct" was a §6 checklist a human read off a one-liner | `verifyMapDb()` runs inside the run; the **exit code is the verdict** |
| An atom's `geo_reresolve_queue` was write-only state (nothing collected it) | `harvestQueues()` reads the collected snapshot; `import-atom-queue.ts` merges it, with an **import ledger** so re-collection cannot re-spend |
| A feed deploy into the wrong Supabase project "succeeded" and published into the void (this checkout is linked to the **empty** FREEBUFF, not the live QKGIO) | `deploy-supabase.sh` **asserts the linked ref is the live one and refuses otherwise**, deploys `public-properties` (which it used to omit entirely), then runs `verify:feed` — a read-only check of the LIVE payload against the source's own `DEPLOY_VERSION` |

**The exit code — read this before you read the log:**

```
0  every invariant held; the map is shippable
1  VERIFY failed (or the dry run's pre-flight says the pass cannot fit the keys
   on disk) — this map is NOT shippable
2  environment error (no map at the resolved path) — nothing was done
```

---

## 1. Where the map actually stands

`--dry-run` is the authority (it measures, it does not guess). Measured here on
**2026-10-14**:

| Fact | Value |
|---|---|
| Grid | **135 tiles × 15 categories = 2,025 pairs** |
| Ledger scanned | **1,515** |
| **Pairs still unscanned** | **510** (36 tiles touched) |
| POIs | **5,990** |
| OSM rows carrying a rating | **147** |
| Keys | **8** (free plan, 250/month each) |

**Budget for November: 8 × 250 = 2,000 searches. Needed: ~510 (+ a few for the
drain). That is ~2.1 keys — the pass is trivially affordable.**

> Do **not** copy these numbers into a decision. Run the dry run and read them
> live; §0's table is what the log said when this file was written.

---

## 2. Preconditions (no budget)

```bash
cd <the map-owning checkout>          # repo-anchored, but cd anyway: it keeps you honest

# 2a. The geo engine is what you think it is (any geo change invalidates it):
md5sum -c GEO_VERSION.txt | grep -v ': OK$'   # expect NO output

# 2b. Keys present — expect 8:
grep -cE '^[0-9A-Fa-f]{40,}$' GOOGLEMAPS_API_KEY.txt

# 2c. Backup the map (the rollback anchor for everything below):
cp data/skopje-pois.db "data/skopje-pois.db.pre-november"

# 2d. Prove the budget actually reset (FREE — /account consumes nothing):
node tmp/probe-keys.js | tail -5          # expect ~2,000 total searches left

# 2e. DB health before spending anything:
node -e "const D=require('better-sqlite3');const db=new D('data/skopje-pois.db',{readonly:true});console.log('integrity',db.prepare('PRAGMA integrity_check').get().integrity_check,'| pois',db.prepare('SELECT COUNT(*) c FROM pois').get().c,'| ledger',db.prepare('SELECT COUNT(*) c FROM tile_scans').get().c);db.close()"
```

**Abort if:** `GEO_VERSION.txt` mismatches, keys < 6, the backup file is missing,
or the budget probe shows less than ~600.

---

## 3. THE DECISION GATE — the free dry run (0 searches)

```bash
npx tsx scripts/refresh-monthly.ts --dry-run 2>&1 | tee data/logs/nov-dryrun.log
echo "gate exit=$?"        # ← 0 = GO, 1 = DO NOT START
```

The dry run is no longer something you *read*; it is a **gate**. It refuses
(exit 1) when the pass cannot fit **what the accounts actually hold** — it now
probes `/account` (free, 0 searches) instead of trusting the nominal
`keys × 250`, which is the check that used to pass with 13 searches left and let
a run exit 0 with 510 pairs open. Read the first three lines to confirm which map
you are about to change, then the plan:

```
Cadence: COMPLETE pass (the default) — 15 categories
Canonical queue: …/data/lina.db (repo-anchored)
Map: …/data/skopje-pois.db (absolute) sha256:09069dbc3899 3.9MB
  Cadence: COMPLETE pass (the default) — 15 categories
  Unscanned pairs (tiles touched: 36): 510
  ESTIMATED SEARCHES to finish the pass: 510
  Keys loaded: 8 (free plan = 250 each)
  Budget now (free /account probe): 2000 search(es) left across 8 key(s)
  Budget ceiling (keys on disk × 250): 2000
  Budget floor per run: 20 searches (hard stop)
  ✓ This pass fits: 510 of 2000 available now
```

**Abort if:** the cadence line does not say **COMPLETE pass**, the `Map:` path is
not the file you expect, the probe line says **UNVERIFIED** (offline — no reading
was possible), or there is no `✓ This pass fits` line. The gate already exits 1
on all of those, and its refusal names both numbers:

```
  ✗ This pass needs 510 search(es); the accounts hold 13.
    Re-key first, wait for the monthly reset, or size a partial pass explicitly with --limit=N.
```

> There is no `--full` to remember any more. If you find yourself typing it, you
> are following an older runbook — it is harmless but unnecessary.

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

A second pass merges **0** rows — it is idempotent.

### How this applies to the remaining scrapes

Every tile×category scan in November will insert **new Google POIs**, and each of
those can create a fresh OSM/Google twin. Therefore:

- **Never skip Phase B2.** It is the step that folds the new twins in, and it
  costs **0 searches**. (VERIFY now fails the run if it did not happen — a
  duplicate `place_id` is a hard violation.)
- **Never widen the unique index** or delete it — the merge above is what makes it
  compatible. Relaxing it would let both rows survive, and the map reader's
  `place_id` collapse keeps the **Google** name (proven by
  `tests/dedupe.test.ts`: *"google anchor wins even when OSM row is closer"*), so
  the Cyrillic name would be **lost from the map**.

---

## 5. THE RUN — one command, no flags

```bash
npx tsx scripts/refresh-monthly.ts 2>&1 | tee data/logs/november-refresh.log
echo "run exit=$?"        # ← 0 = shippable. Anything else: STOP and read §5b.
```

| Phase | What it does | Searches |
|---|---|---|
| A | Overpass OSM restore (POIs + named bus/tram stops) | 0 |
| B | SerpApi top-up — **135 tiles × 15 categories**, full capture, bbox-gated at insert, every formatted address harvested into `learnAddress` | **~510** |
| B2 | `stripBlindFusions` → `identityHeal` — **the merge** | 0 |
| B3 | batch-teach feed-property streets the map can't resolve | 0–5 |
| C | **harvest every stray queue → drain `geo_reresolve_queue`** (workstation rows + any collected atom snapshot), patch Supabase, teach the map | 0–5 |
| D | poison sweep — re-check low-confidence landmarks | 0 |
| **VERIFY** | integrity · POI count · one row per `place_id` · coverage closed or budget-bound | 0 |

**Wall time:** measured at **4.4 s per real search** (not the 1.1 s sleep — HTTP
latency dominates), so ~510 searches ≈ **38 minutes**. Budget for ~1 hour.

### 5b. Reading the end of the log

```
=== VERIFY ===
  ⚠ 12 of 2025 pairs unscanned (ledger 2013, 0 searches left) — budget exhausted; they resume on the next run
  ✓ integrity ok · pois 6123 · one row per place_id · coverage 2013/2025 pairs
=== RUN OK — the map is shippable ===
```

- A **⚠** line is carry-over, not a defect: the budget ran out, the ledger keeps
  those pairs, and the next run resumes on exactly them.
- A **✗** line means the run exited **1** and the map must not ship. The three
  things that produce one: `integrity_check != ok`, `pois < 1000` (the wrong-map
  signature), a duplicate `place_id` (B2 did not merge), and open pairs while
  budget remained (the old silent-under-run).

### The two spending traps that broke the October run — both fixed, do not undo them

1. **A throttled/rejected response must never count as a scan.** SerpApi enforces
   **250 searches per HOUR per account** on top of the monthly 250. On 2026-10-08
   the code paced at 1.1 s (~3,270/hour) and wrote every rejection into the ledger
   as "scanned": **730 pairs were marked done with no data behind them**, and the
   ledger's own promise ("never repeated") meant they would never be retried.
   Now: a rejection returns `null` — no spend, **no ledger write** — a throttled key
   is blocked for the rolling hour and **rotated past**, and successful searches
   round-robin across keys.
2. **The spend guard must re-probe `/account` before giving up.** A stale local
   counter once reported "19 left" while the truth was ~770, abandoning the pass.
   `/account` is free; the guard now re-probes.

**Abort and resume rule:** if keys throttle, let the run stop cleanly — it leaves
everything unscanned, unspent, and the ledger truthful. Re-run the same command the
next hour or day; it resumes exactly where it stopped.

> `--rescan=<file.json>` exists ONLY for repairing an explicit list of pairs (the
> 730-hole repair). It bypasses the ledger's "already scanned" filter on purpose.
> **Never use it casually** — it re-spends on paired tiles. A normal run never needs
> it. `--light` exists for a deliberately cheap month; it is not the default and it
> is not a way to be "complete".

---

## 6. VERIFY (the run already did the hard part)

The run asserted the invariants itself (§5b). These are the extras a machine
cannot judge — run them, they are all free:

```bash
# a) Coverage really is closed (re-run the gate):
npx tsx scripts/refresh-monthly.ts --dry-run    # exit 0, ESTIMATED SEARCHES: 0
                                                # (a handful is fine only if the budget ran out)

# b) The deliverable, by hand — the same numbers the run printed:
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

# e) The suite, and the geo engine stamp
npm run typecheck && npm test && md5sum -c GEO_VERSION.txt | grep -v ': OK$'
```

**Pass criteria:**

| Check | Expected |
|---|---|
| `--dry-run` exit code | **0** |
| `ESTIMATED SEARCHES` | **0** (a handful only if the budget ran out) |
| ledger rows | **2,025** (= 135 × 15) |
| duplicate `place_id` | **0** |
| `integrity_check` | **ok** |
| OSM rows carrying a rating | **≥ 147** |
| `geo_reresolve_queue` | **0**, or only `poison_sweep` rows (Phase D queues next month's work on purpose) |
| census | still ~813 known, 0 unknown |
| `md5sum -c GEO_VERSION.txt` | no failures |

**Rollback:** `cp data/skopje-pois.db.pre-november data/skopje-pois.db` reverts
everything.

---

## 7. THE ATOM'S QUEUE — the up-path (new; do not skip)

An atom's `geo_reresolve_queue` is written by *its* runtime when live traffic
hits a property it cannot place offline. **Nothing on an atom ever drains it** —
the drain lives on the map hub, which owns the SerpApi budget — and atoms never
push. Until now those rows were write-only state: EB 74 sat in a queue from
13 September and no amount of running the hub would ever see it.

The chain, in full:

```bash
# On the workstation, in the BOT repo (real-estate-atoms/secretaries/inbound_final):
npm run atoms:collect                                   # pulls data/atoms/<id>/lina.db.copy
                                                        # the summary now prints "geo queue: N"
npx tsx scripts/import-atom-queue.ts data/atoms/atom01/lina.db.copy
#   → imports the enrichment queue AND merges the geo queue into the canonical
#     runtime DB that Phase C drains. The import ledger makes re-collecting an
#     unchanged snapshot free: the same event is never imported twice, so it can
#     never buy the same geocode twice.
```

Then November's Phase C drains those rows like any other. Nothing else to do —
and it is safe to run `import-atom-queue` every month, or to leave it in the
collect habit: a snapshot with nothing new prints `+0 row(s)`.

---

## 8. SHIP IT — the bots only ever receive the file

Ship **after** §6 passes, and never copy SQLite hot.

```bash
# 1. A consistent snapshot (safe even while something reads the DB):
sqlite3 data/skopje-pois.db ".backup '/tmp/skopje-pois.db.november'"

# 2. Ship with checksum verification (refuses a broken map).
#    <remote-dir> = the directory the BOT READS, i.e. the maps checkout — NOT
#    inbound_final. Verified 2026-10-15 on atom01:
#      $ grep '^SKOPJE_POIS_DB' /home/atom/.lina/lina.env
#      SKOPJE_POIS_DB=/home/atom/Documents/PROJECTS/maps-realestate/data/skopje-pois.db
#    Shipping to the bot's inbound_final/data puts the map where nothing reads
#    it; the old `ls -d ~/*/secretaries/inbound_final` probe finds nothing on
#    atom01 (its layout is PROJECTS/LINA + PROJECTS/maps-realestate).
scripts/deploy_map.sh --key ~/.ssh/id_ed25519_atom01 atom01 /home/atom/Documents/PROJECTS/maps-realestate/data

# 3. Confirm the atom is serving THE map you just verified: the sha256 prefix
#    deploy_map.sh prints must equal the `sha256:` prefix the run logged in §5.
```

`deploy_map.sh` verifies the DB opens and has >1,000 POIs, writes a sha256 sidecar,
backs up the target's old copy to `skopje-pois.db.bak-<stamp>`, extracts, and
compares checksums — a mismatch restores the backup automatically.

Then restart the bot on the target and confirm the printed `[db:xxxxxxxx]` matches.

> **Resolved (2026-10-12):** the 2026-10-08 blocker below no longer applies —
> `~/.ssh/id_ed25519_atom01` is in the atom's `authorized_keys` and
> `ssh -o BatchMode=yes atom01 'hostname'` returns `ATOM1`. The `Host atom01`
> entry in `~/.ssh/config` also points at that key, but never rely on it:
> `deploy_map.sh` now takes the key explicitly.
>
> *(Historical, kept for context)* 2026-10-08: `ssh atom01` failed with
> `Permission denied (publickey,password)` because the public key was not yet on
> the atom; the fix was `ssh-copy-id -i ~/.ssh/id_ed25519_atom01.pub atom01`.
> `T60` (`t60hermes`, 192.168.1.20) authenticated fine throughout.

---

## 9. FLOWLESS-CLOSE THE LOOP — the LINA-side deployment (do not skip)

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

> **LINA reads QKGIO.** This checkout is `supabase link`ed to the **empty
> FREEBUFF** project, and `.env.example` calls FREEBUFF "the properties feed" —
> both are misleading. **Deploying while linked to FREEBUFF publishes into the
> void.** This is now guarded in code, not in prose (below).
>
> **The deploy is one guarded command, and the guard runs first:**
> ```bash
> cd ~/Documents/real-estate-atoms/secretaries/inbound_final
> supabase link --project-ref qkgioqotxjxffiaufgwd    # required once
> HERMES_API_KEY=nvapi-xxx npm run deploy:supabase     # refuses a wrong-linked checkout
> ```
> `deploy-supabase.sh` now (a) **fails closed** when the linked project ref is not
> the live one — printing both refs and the re-link command, before touching
> anything — (b) deploys `public-properties`, which it previously **omitted
> entirely** (that omission is exactly how the function drifted into a build with
> no `landmarks`), and (c) ends by running the read-only feed verifier.
>
> **Verify, do not trust the exit code:**
> ```bash
> npm run verify:feed
> ```
> It compares the SERVED `version` against `DEPLOY_VERSION` in the source (so the
> check can never go stale), then asserts the payload really carries what Lina
> needs. Measured on the live feed, 2026-10-14:
> ```
> served version   : v9-20261008-landmarks
> properties       : 45
> with lat/lon     : 45
> with landmarks   : 42
> geo_source       : {"osm_low_confidence":19,"osm_building":5,"osm_street_anchor":3,"google_cached":18}
> ✓ every property carries the geo columns and the landmarks Lina reads
> ```
> The 19 `osm_low_confidence` rows are the ones November's Phase C/B3 work exists
> to upgrade — read them as the current backlog, not as a failure.
> (Aside, not part of this run: `scripts/backup.ts`, `scripts/restore.ts` and
> `scripts/backup.sh` default to the FREEBUFF ref. Check that is deliberate before
> relying on the backup path.)

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

## 10. NO MAP JOB IS SCHEDULED — the map is FIXED until you say otherwise

**No MAP job is scheduled. Anywhere.** The map is a fixed artifact: finished and
deployed by a human, unchanged until that human runs the SerpApi pass again.
Nothing may change it, rebuild it, resolve a landmark on it, spend a search or
enrich a reply on a timer.

**And exactly one job MUST stay scheduled.** `*/5 * * * * hermes-price.sh` on the
bot atom is **not** map work. Despite the wrapper's name it carries BOTH queues
of owner-dictated facts, and it is the only thing that gets them to the app:

| queue | what it carries |
|---|---|
| `price_changes` | Lina asks the owner the CURRENT price; a different one becomes the public price |
| `address_changes` | Lina confirms the ADDRESS with the owner before a visit (Turn 0); when the owner names a different street, the owner owns the building and the listing learns the real one |

Both go through the T60 Hub (`/ingest/price`, `/ingest/address`) → the
`update-property-price` / `update-property-address` edge functions. A no-cron
sweep removed this job on 2026-10-14: every published price silently stopped
following the owner's word, and every corrected address stayed stranded in a
local table. So it is classified `sync` (required, never stripped), and its
absence is its own failure:

```bash
npm run cron:check -- --require-sync   # on an atom: exit 1 when the owner sync is missing
```

This is enforced, not requested:

```bash
npm run cron:check     # exit 0 = COMPLIANT; exit 1 = a MAP job is installed (and it says which)
npm run cron:remove    # strips every forbidden line; idempotent
npm run cron:install   # REFUSES, and prints the manual commands instead
```

Run `cron:check` on **every** machine you have an account on — workspace, each
atom — and after any restore from an old image. **`--require-sync` only means
something on a BOT.** It asserts the 5-minute owner sync is installed, and that
job deliberately lives on the atom (it is the only writer that reaches the app),
so running it on the workstation correctly reports `MISSING` and exits 1:
verified 2026-10-15 — workstation fails `--require-sync`, atom01 carries the line
and passes. Use plain `cron:check` (exit 0 = COMPLIANT) on non-bot machines; use
`cron:check --require-sync` on the bots. On the fleet it is automatic:
`npm run atoms:deploy` (bot repo) removes MAP jobs from every atom **and
re-installs the owner sync if it is missing** — that is the one line a deploy may
write, because its absence is the defect.

The lines that used to exist, and what replaces each one:

| was scheduled | now |
|---|---|
| `0 4 1 * * refresh-monthly.ts` (SerpApi) | `npm run refresh` — you decide the day |
| `0 5 * * * healthcheck.ts` | `npm run health` |
| `17 3 * * * hermes-nightly.sh` | `bash scripts/hermes-nightly.sh` (bot repo) |
| `*/5 * * * * hermes-price.sh` | **KEPT — required, every 5 min.** It carries the owner's price corrections AND their address corrections (`price_changes` + `address_changes` → hub → app). Never remove it: without it the app learns neither |
| `17 3 * * 0 skopje-map-weekly.sh` | manual, and **only on the machine that owns the map** |
| `30 0 * * * enrich-cron.sh` | `bash scripts/enrich-cron.sh [--gapfill]` after review |
| `0 4 1 * * cron-if-primary.sh` | retired — it only scheduled other jobs |

### The one line that is NOT a job

`@reboot` lines are **kept, by decision (2026-10-14)** — on atom01 (the bot),
atom4 (the relay) and T60 (the supervisor). They run no map work, spend nothing
and learn nothing; they only bring a service back after a power cut, and
dropping them means a rebooted box stays dead until somebody notices. If you
want them gone anyway, that is one flag (not a code change):

```bash
npm run cron:remove -- --remove-reboot
```

### The deliberate exceptions on T60 (audited 2026-10-14)

T60 (`t60hermes`) **owns the map** (`PROJECTS/maps-realestate/data/skopje-pois.db`)
and still runs three live jobs. They were read line by line and **kept on
purpose** — none of them touches the map, SerpApi, a landmark or a reply:

| job | what it is | why it stays |
|---|---|---|
| `*/5 supervise.sh` | process keeper for the images server / Hub | T60 has **no systemd** (PID 1 = init), so this line *is* `Restart=always` — without it a crashed service stays down until somebody notices |
| `backup-if-stale.sh` ×5 slots | Supabase → local disk, at most one per 20h | remove the slots and the backups simply stop |
| `40 22 nightly-scrape.sh` | the apartment scraper → Ana's CSVs | unrelated to the map; it never reads `skopje-pois.db` |

`cron:check` classifies all three as `other` (unrecognised → left untouched),
because the policy flags **map work**, not supervision. The day one of them
grows a `skopje-pois` / SerpApi / landmark step, delete that line — that is the
whole trigger.

### What "fixed" costs (know it before November)

With nothing scheduled, the map changes only when you run `npm run refresh`.
That means the queue drain (Phase C), street teaching (B3) and the poison sweep
(D) also wait for you: atom-side `geo_reresolve_queue` rows accumulate in the
collected snapshots and are merged and drained on your next manual run. That is
the intended trade — a property that cannot be placed stays honestly labelled
`osm_low_confidence` instead of being repaired at 04:00 by a job nobody watched.

---

## 11. OPEN REPAIRS CARRIED INTO NOVEMBER — do these; they are why the run is not yet flawless

All four come from the 2026-10-15 repair session and the live chat it diagnosed:
a client asking about EB 76 was told "во близина на Амбасада на Црна Гора" **with
a raw `?q=` pin**, and given three different landmarks for one flat across three
questions. **A, B and C are done and verified on the workstation** — A still has
to be SHIPPED (§8), which is why the run is not flawless yet. **D is still open**:
the diagnostic that should have caught this cannot see it.

> **The artifact changed on 2026-10-15:** one row restored (§11.A), so §1's
> measured table (5,990 POIs, sha `7f8554e9c670`) is the **2026-10-14** reading.
> Today's live map is **5,991 POIs, sha `09069dbc3899…`**, and `data/skopje-pois.db.pre-embassy-fix`
> is the rollback anchor for that one change.

### A. The embassy place card — DONE on the workstation, NOT YET SHIPPED

**What happened.** The Google anchor `Embassy of Montenegro`
(`place_id 0x1354144841501047:0x71a2f884c5dc3050`, cid `8188380321651896400`)
had been deleted from the map by the October identity repair; what survived were
two pid-less OSM twins at the same coordinates. The reader therefore served
`Амбасада на Црна Гора` with a coordinate pin, and the row lost its prominence
too (no reviews → rotation slot 8 instead of 3).

**Fixed 2026-10-15** by restoring that exact row from our own
`data/skopje-pois.db.pre-fusion-strip.bak` (identity only — no invented fields).
Proved on a copy, then applied. Verified after: `nearestPois` near
`41.996,21.4172` serves **one** Montenegro entry with `pid=yes` and
`?cid=8188380321651896400`; `integrity_check ok`; duplicate `place_id` **0**;
POIs 5,990 → 5,991.

**What is left is shipping it** — nothing on the atom changes until §8 runs.
Note the atom (sha `7f8554e9c670…`) is now *older* than the workstation
(`09069dbc3899…`). Ship once, **after** the November pass, and check the sha.

### B. Re-scan that pair to get the embassy's reviews/rating back (1 search)

The restore had no capture data, so the row carries a card but **no
`review_count`/`rating`** — and prominence is `log10(reviews+1)`, which is why
the 80 m embassy still ranks below the 252 m Bulgarian one. One search fixes it:

```bash
printf '[{"tile":"42.00,21.42","category":"embassy"}]' > /tmp/embassy-pair.json
npx tsx scripts/refresh-monthly.ts --rescan=/tmp/embassy-pair.json
```

**DONE 2026-10-15** (1 search, after §11.C.1 landed). The pair was re-scanned and
`backfilled 20 rows`, including the anchor itself:

```
rowid 21044  Embassy of Montenegro  place_id 0x1354144841501047:0x71a2f884c5dc3050
             review_count 7   rating 4.1   phone +389 2 322 7277   types ["Embassy"]
paired entry served for EB 76:  Амбасада на Црна Гора  80m  pid=yes
                                ?cid=8188380321651896400   reviews 7
```

Acceptance met: `review_count`/`rating` are non-NULL (they were the whole
point), the pair serves ONE entry with a place card, `duplicate place_id` stayed
**0**, `integrity_check ok`, POIs still 5,991, and the ledger pair went `scans 1 → 2`.

**Correction to this runbook's own prediction:** the earlier text here said the
embassy would climb to rotation **slot 3** — that was measured with a
*simulated* 106 reviews. Its real count is **7**, so prominence puts it at slot
**8 → 6** (ahead of Bosnia ×5 and Feng Shui ×4, behind the 106-review Bulgarian
embassy 172 m further out). That ordering is the prominence rule working
correctly: the 80 m embassy is not the most famous thing in that block. Do not
"fix" it by boosting the row.

### C. Two code defects this exposed — **FIXED 2026-10-15** (0 searches)

1. **`BUDGET_FLOOR` blocked explicit repairs.** A `--rescan` list is explicit and
   bounded (one search per named pair), so it now gets a floor of **1**; the
   20-search floor stays for the GRID pass, where stopping early is correct.
   Verified: with **13** searches left, the 1-pair embassy rescan ran
   (`Pairs actually searched: 1`, SerpApi 13 → 12) — the same command had been a
   silent no-op an hour earlier.
2. **A no-op repair exited 0.** A repair that repaired nothing now exits **1**
   from two doors, both verified live and both spending nothing:
   ```
   --rescan=[]                          → RESCAN DID NOTHING … (exit 1)
   --rescan=[{category:"not-a-category"}] → RESCAN DID NOTHING … (exit 1)
   ```
   (Also: the summary now prints `Pairs actually searched: N`, so a run's own log
   says whether anything happened.)

### D. `suspect-pairs` is blind to the bug that reached the client

Its buckets are same-name **>50 m**, same-phone **>50 m**, and dual-identified
**<30 m with two `place_id`s** (`scripts/suspect-pairs.ts`). A Google anchor
plus a pid-less twin at **identical** coordinates (d = 0) matches **none** of
them — which is precisely the Embassy of Montenegro case.

Evidence: after the repair, `tests/place-identity.test.ts`'s audit (which samples
the live map at `41.9959869,21.418169`) passes — no twin takes two rotation
slots — while `suspect-pairs` reported **134 suspects and named Montenegro zero
times**. Add a bucket: *same normalized name within ~50 m where exactly one side
carries a `place_id`* (the identity-blind twin), so this cannot recur unseen.

### E. A probe can no longer start a pass — **FIXED 2026-10-15** (0 searches)

`scripts/refresh-monthly.ts` ran `main()` at import time, so **any** `tmp/` probe
that imported it launched the whole pipeline: on 2026-10-15 a supposedly
read-only probe did Phase A and then **drained the runtime queue for real** — and
in a month with budget it would have spent the pass. Two things were wrong:

- the CLI now runs **only when the file is the entry point** (`require.main ===
  module`); importing it is inert and silent;
- `phaseB2` **was never exported**, so those probes were calling `undefined(db)` —
their only real effect was that accidental pass. It is exported now.

`tmp/run-b2.ts` is the reference probe: it heals a **copy** by default and needs
an explicit `--write` to touch the live map.

**Verified:** importing the module leaves the map sha **and** the queue row count
unchanged (idle); `npx tsx tmp/run-b2.ts` healed a copy (39 rows) with the live
map's sha unchanged. Any future probe that needs the map must follow that shape —
copy first, `--write` to mean it.

---

## 12. ONE-PAGE CHECKLIST

```
[ ]  1  md5sum -c GEO_VERSION.txt       → no failures
[ ]  2  keys = 8 ; /account probe shows ~2,000 left
[ ]  3  cp data/skopje-pois.db data/skopje-pois.db.pre-november
[ ]  4  --dry-run → exit 0, "COMPLETE pass — 15 categories", Map: path+sha256, ~510 searches
[ ]  5  <one command> → ~38 min, ~510 searches, "RUN OK", exit 0
[ ]  6  --dry-run again → exit 0, ESTIMATED SEARCHES: 0
[ ]  7  ledger = 2,025 ; dup place_id = 0 ; integrity ok ; osm rated ≥ 147
[ ]  8  census --verify green ; suspect-pairs ; typecheck + tests + md5sum -c
[ ]  9  atoms:collect → import-atom-queue <snapshot> (the geo rows, §7)
[ ] 10  sqlite3 .backup → /tmp/skopje-pois.db.november
[ ] 11  scripts/deploy_map.sh --key ~/.ssh/id_ed25519_atom01 atom01 /home/atom/Documents/PROJECTS/maps-realestate/data → checksum match
[ ] 12  atom: [db:xxxxxxxx] matches the §5 run's sha256 prefix ; bot answers "76" with a landmark + pin
[ ] 13  HERMES_API_KEY=… npm run deploy:supabase (refuses a wrong-linked checkout) → npm run verify:feed green
[ ] 14  bot: npm run build + pm2 restart
[x] 15  §11.B  DONE 2026-10-15 (1 search) — reviews 7 / rating 4.1 captured, card served
[x] 16  §11.C  DONE 2026-10-15 — --rescan floor 1 ; both 0-pair doors exit 1 (verified free)
[ ] 17  §11.D  suspect-pairs flags identity-blind twins (one pid, one pid-less, same coords)
[x] 18  §11.E  DONE 2026-10-15 — importing refresh-monthly starts nothing; probes heal a copy only
```

**Expected totals for November:** ~510–520 searches (**~2.1 keys** of the 2,000
available), ~40 minutes wall time, 0 searches for the whole B2→B3→C→D tail.

---

## 13. What is NOT part of this run (so nobody chases them)

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
