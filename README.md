# maps-realestate

Standalone Skopje maps/geo stack for the Metropolis real-estate cluster.
Extracted from LINA (`secretaries/inbound_final`) so any machine with the
**maps role** can run it: build/refresh the offline map, host the Supabase
backup, watch for new properties and resolve their locations instantly.

Redeploy rule: **Lenovo (workstation) → GitHub master → every maps-role machine.**
Bots never edit geo code — LINA has no copy of `src/geo` at all: it **links** to
this repo, so this repo is the only place geo code exists in the cluster.

## Layout

```
src/geo/           the geo engine — the ONLY copy (LINA links here)
src/store/db.ts    geo-only DB shim: landmarks cache + re-resolve queue (LINA v7 schema)
src/compat/        Node-16 polyfill (fetch/undici) — atoms run Node 16
src/data/          type-only shim (FeedLandmark) so src/geo needs zero rewrites
scripts/           all network + cron jobs (the ONLY place network lives)
data/              skopje-pois.db (offline map), address-overrides.json
tests/             the geo test suite (`npm test`)
GEO_VERSION.txt    md5 stamps of src/geo — assert after any geo change
```

## Ownership contract (read before touching anything)

This used to be a byte-identical *sync* contract between two copies of the
engine. Two copies drifted (LINA's `landmarks.ts` gained the pin fix while this
repo's `offlineMap.ts` gained the semantic lexicon) and nothing could detect it,
so the second copy was deleted in 2026-10.

1. **`src/geo` is the only copy of the geo engine in the cluster.** Every change
   to landmark/offline-map/queue code is made here, tested here (`npm test`,
   the whole suite), pushed to GitHub.
2. **LINA never carries a copy.** Its `src/geo` is a machine-local symlink made
   by `inbound_final/scripts/link-geo.js` (`npm run link:geo`, also wired into
   `postinstall` and `deploy-atoms.sh`). LINA compiles the linked tree into its
   own `dist/` with `preserveSymlinks: true`, so its 53 import sites are
   unchanged and it still needs no service or network at request time.
   The link is gitignored and never rsynced — the path differs per machine.
3. **`GEO_VERSION.txt` stamps this repo's own `src/geo`.** Assert it after any
   geo change with `md5sum -c GEO_VERSION.txt`. It is no longer a cross-repo
   comparison, because there is no second copy to disagree with.
4. **Redeploy order:** this project to each machine, then LINA (so the target
   has the engine before `link-geo.js` points at it).
5. Schema: `landmarks` (property_id PK, tier, upgrade-only writes) and
   `geo_reresolve_queue` keep the shape LINA v7 uses. A `data/lina.db` written
   by either side is readable by the other.

## Machine roles

| Machine | Role | Runs |
|---|---|---|
| **Lenovo** | workstation / dev master | tests, map build, git push |
| **T60** (`t60hermes`) | DATA HUB: map + Supabase backup + images | map build, crons (below), backup/serve |
| **T620** (`192.168.1.101`) | failover hub | same code, crons guarded by reachability check |
| **LINA bots** (lenovo, atom01) | consume geo, never edit it | link to this repo's `src/geo` via `link-geo.js` |
| **ATOM** (`192.168.1.11`, Node 16 i686) | LINA runtime | geo-watcher is optional here; T60 stays the hub |

## NO MAP JOB IS SCHEDULED — and the owner sync always is

**The map is a FIXED ARTIFACT.** It is finished and deployed by a human, and it
stays exactly that until a human decides to run the SerpApi pass again. No timer
may change the map, rebuild it, resolve a landmark, spend a search or enrich a
reply.

There used to be a monthly refresh and a daily healthcheck installed here (plus
a nightly landmark resolver, a weekly map pull and an enrichment pass elsewhere).
All of those are gone, and the installer is now the ENFORCER:

```bash
npm run cron:check     # exit 0 = COMPLIANT; exit 1 = a MAP job is scheduled
npm run cron:remove    # strips every forbidden line (idempotent)
npm run cron:install   # REFUSES, and prints the manual commands instead
```

**One job is required and must never be swept away:** `*/5 * * * * hermes-price.sh`
on the bot atom. It is not map work — Lina asks owners for the current price and
confirms the address with them before a visit, and that one job carries BOTH
corrections (`price_changes`, `address_changes`) through the hub to the app. A
no-cron sweep deleted it once (2026-10-14): every published price froze and every
corrected address was stranded, so its absence is now its own failure:

```bash
npm run cron:check -- --require-sync   # on an atom: exit 1 if the owner sync is missing
```

Run `cron:check` on every machine you have an account on — hub, workstation,
each atom — and after any restore from an old image. The atom fleet is covered
automatically by `npm run atoms:deploy` in the bot repo.

The one non-job line, `@reboot … # LINA_ATOM`, is KEPT by default: it spends
nothing, learns nothing and only brings the bot back after a power cut. Drop it
with `npm run cron:remove -- --remove-reboot`.

What used to be scheduled is now a command you run:

```bash
npm run refresh    # the map pass — spends SerpApi only because YOU asked
npm run health     # read-only state snapshot
npm run census     # street coverage
```

`refresh` is the same one command it always was — OSM restore + SerpApi top-up
(COMPLETE pass; the ledger decides the spend) + queue harvest and drain + poison
sweep, then **VERIFY**. The exit code is the verdict: `0` shippable ·
`1` VERIFY failed · `2` no map at the resolved path. The full procedure lives in
`docs/november-runbook.md`.

`geo-watcher` runs wherever LINA runs that owns a fresh map (lenovo/atom):
polls Supabase for `geo_source IS NULL` rows every 60s and resolves them
OFFLINE (exact building → interpolation → honest low-trust + queue). Zero
SerpApi per property. As a service: `npm run watch` (or cron `--once`).

## Pipeline (what each job does)

- `npm run map:build` — rebuild `data/skopje-pois.db` from Overpass (POIs +
  addresses), then fold `data/address-overrides.json` in. Fresh = ~4060 POIs.
- `npm run map:google` — SerpApi Google Maps tiles → merged `pois` table rows
  (`source='google'`, place_id stored) — run from the hub, budget-guarded.
- `npm run refresh` — monthly: OSM restore → Google top-up (complete pass;
  ledger-gated) → queue harvest + drain (bbox- and trust-guard-validated
  `google_cached` upgrades) → poison sweep → VERIFY. The exit code is the
  verdict; see `docs/november-runbook.md`.
- `npm run health` — read-only: POI counts by source, cache tiers, queue depth.
- `npm run backup` / `backup:serve` / `backup:restore` — Supabase → local
  SQLite/images snapshot + HTTP serve (hub role).

## Deploy to a new maps machine

```bash
git clone <github-maps-url> && cd maps-realestate
npm ci                 # Node 16: better-sqlite3 8.7.0, tsx 3.13.0 pinned
npm test               # the geo suite (exit 0 = green)
npm run map:build      # fresh offline map
npm run cron:check     # verify crons (install with --install on the hub)
```

Env: copy `.env.example` → `.env` (or source `~/.lina/lina.env` like the bots
do) — `SERPAPI_KEY`, `SUPABASE_*`, optional `DB_PATH`/`SKOPJE_POIS_DB`.

## Invariants (violating any = bug, not a shortcut)

- No network during a client request — network lives ONLY in `scripts/`.
- Stored/URL coords at 5 decimals; only `propertyAreaLink` fizzes to 3 (±110 m).
- Cache writes are upgrade-only, keyed by `property.id`.
- `osm_low_confidence` never serves a landmark name or coordinate link.
- Type matching is case-insensitive + whitespace-normalized everywhere.
- **Every path is absolute and repo-anchored.** The map (`resolveMapDb`), the
  queue (`resolveRuntimeDb`) and the key files never resolve against
  `process.cwd()` — a cron `cd`, an ssh'd shell or a symlinked cwd cannot make a
  run read or write a different file than the operator expects.
- **One queue.** `geo_reresolve_queue` has exactly one drained copy; every stray
  sibling is merged into it before the drain, and a collected atom snapshot is
  merged through an import ledger so re-collection never re-spends.
- **A run's exit code means the invariants held.** VERIFY (`src/geo/runVerify.ts`)
  enforces integrity, POI count, one row per `place_id`, and coverage closed (or
  provably budget-bound). A silent under-run is a failed run.
