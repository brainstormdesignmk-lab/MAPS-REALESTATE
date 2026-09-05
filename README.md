# maps-realestate

Standalone Skopje maps/geo stack for the Metropolis real-estate cluster.
Extracted from LINA (`secretaries/inbound_final`) so any machine with the
**maps role** can run it: build/refresh the offline map, host the Supabase
backup, watch for new properties and resolve their locations instantly.

Redeploy rule: **Lenovo (workstation) → GitHub master → every maps-role machine.**
Bots never edit geo code; they receive `src/geo` from this master.

## Layout

```
src/geo/           the geo engine (BYTE-IDENTICAL to LINA's src/geo — sync contract)
src/store/db.ts    geo-only DB shim: landmarks cache + re-resolve queue (LINA v7 schema)
src/compat/        Node-16 polyfill (fetch/undici) — atoms run Node 16
src/data/          type-only shim (FeedLandmark) so src/geo needs zero rewrites
scripts/           all network + cron jobs (the ONLY place network lives)
data/              skopje-pois.db (offline map), address-overrides.json
tests/             the geo test suite (73 tests)
GEO_VERSION.txt    md5 stamps of src/geo — bots assert this after sync
```

## The sync contract (read before touching anything)

1. **`src/geo` is the single source of truth in THIS repo.** Every change to
   landmark/offline-map/queue code is made here, tested here, pushed to GitHub.
2. Bots (LINA on lenovo/atom) never carry their own geo edits. After every
   master change: rsync `src/geo/` from a clone of this repo into the bot
   checkout, then compare `GEO_VERSION.txt` stamps — they must match, or the
   deploy is invalid.
3. `src/geo` files must stay byte-identical after a sync. The bot's
   `../store/db` and `../data/properties` are richer versions of the shims in
   this repo — the import paths are identical on purpose.
4. Schema: `landmarks` (property_id PK, tier, upgrade-only writes) and
   `geo_reresolve_queue` are IDENTICAL in both repos. A `data/lina.db` written
   by either side is readable by the other.

## Machine roles

| Machine | Role | Runs |
|---|---|---|
| **Lenovo** | workstation / dev master | tests, map build, git push |
| **T60** (`t60hermes`) | DATA HUB: map + Supabase backup + images | map build, crons (below), backup/serve |
| **T620** (`192.168.1.101`) | failover hub | same code, crons guarded by reachability check |
| **LINA bots** (lenovo, atom01) | consume geo, never edit it | rsync `src/geo` from master only |
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
