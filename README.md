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
tests/             the geo test suite (121 tests)
GEO_VERSION.txt    md5 stamps of src/geo — assert after any geo change
```

## Ownership contract (read before touching anything)

This used to be a byte-identical *sync* contract between two copies of the
engine. Two copies drifted (LINA's `landmarks.ts` gained the pin fix while this
repo's `offlineMap.ts` gained the semantic lexicon) and nothing could detect it,
so the second copy was deleted in 2026-10.

1. **`src/geo` is the only copy of the geo engine in the cluster.** Every change
   to landmark/offline-map/queue code is made here, tested here (`npm test`,
   121 tests), pushed to GitHub.
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

## Crons (install on the hub with `npm run cron:install`, T60 only)

```
0 4 1 * *  monthly refresh — POI restore (Overpass, free) + SerpApi top-up
           (budget ≤ 80/mo, STOP at 20 left) + queue drain + poison sweep
0 5 * * *  daily healthcheck — read-only snapshot into logs/health.log
```

`geo-watcher` runs wherever LINA runs that owns a fresh map (lenovo/atom):
polls Supabase for `geo_source IS NULL` rows every 60s and resolves them
OFFLINE (exact building → interpolation → honest low-trust + queue). Zero
SerpApi per property. As a service: `npm run watch` (or cron `--once`).

## Pipeline (what each job does)

- `npm run map:build` — rebuild `data/skopje-pois.db` from Overpass (POIs +
  addresses), then fold `data/address-overrides.json` in. Fresh = ~4060 POIs.
- `npm run map:google` — SerpApi Google Maps tiles → merged `pois` table rows
  (`source='google'`, place_id stored) — run from the hub, budget-guarded.
- `npm run refresh` — monthly: OSM restore → Google top-up → queue drain
  (bbox-validated google_cached upgrades) → poison sweep (downgrades stale
  osm rows; `osm_low_confidence` never serves a landmark).
- `npm run health` — read-only: POI counts by source, cache tiers, queue depth.
- `npm run backup` / `backup:serve` / `backup:restore` — Supabase → local
  SQLite/images snapshot + HTTP serve (hub role).

## Deploy to a new maps machine

```bash
git clone <github-maps-url> && cd maps-realestate
npm ci                 # Node 16: better-sqlite3 8.7.0, tsx 3.13.0 pinned
npm test               # 73 tests
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
