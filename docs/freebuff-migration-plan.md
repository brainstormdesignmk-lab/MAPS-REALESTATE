# Migration plan — move LINA off "METROPOLIS TEST 1" onto "METROPOLIS 2 FREEBUFF"

**Status:** PLAN ONLY. Nothing has been migrated. No production data has been touched.
Written 2026-10-08 after a read-only survey of both projects.

## Why

The live production data currently sits in a project literally named
**`METROPOLIS TEST 1`** (`qkgioqotxjxffiaufgwd`). The intended production project,
**`METROPOLIS 2 FREEBUFF`** (`euuaycmxfqiruspwjxhd`), is provisioned (same 10 tables,
same bucket, same function names) but **empty**. LINA reads TEST 1 today.

Both projects are in org `METROPOLIS` (`abmlggpajsucoqkhgngv`), so one account owns
both and the management token can drive the whole migration.

## Survey (verified, read-only)

| | TEST 1 (live source) | FREEBUFF (target) |
|---|---|---|
| properties | **47** | 0 |
| property_images | **374** | 0 |
| property_contacts | **51** | 0 |
| customer_leads | **13** | 0 |
| owner_lookup_log | **8** | 0 |
| profiles | **2** | 0 |
| price_changes | **1** | 0 |
| price_change_log | **5** | 0 |
| landmark_resolution_log | **949** | 0 |
| hermes_events | **976** | 1 (stray test row) |
| **total rows** | **2,426** | 1 |
| auth users | **1** | 0 |
| storage bucket | `property-images` (public) | `property-images` (public) |
| edge functions | 9 (`public-properties@34`) | 11 (`public-properties@6`, +2 junk: `test-hello`, `edge-runtime-test`) |
| secrets | 9 | 10 (+`ADMIN_TOKEN`) |

**Total migration scope: 2,426 rows + 1 auth user + 374 storage objects + 9 functions.**

## The five hard parts (do not under-estimate these)

1. **Auth user.** `profiles` (2 rows) hangs off an auth user (1 exists in TEST 1).
   Migrating a user is **not** a plain REST insert — it needs the Admin API
   (`POST /auth/v1/admin/users`) **with the same `id`**, or the profiles rows will
   be orphaned and logins will fail. This is the step most likely to be skipped.
2. **Storage objects.** 374 `property_images` rows reference objects in the
   `property-images` bucket. Row migration alone leaves **broken images**. Objects
   must be copied bucket→bucket and the count verified against the table.
3. **Function sources.** FREEBUFF runs older function versions. Redeploying from
   this repo requires every function's source to be present — the repo has all 9
   names, but **confirm each file matches the deployed version 28/34/15/12…** before
   trusting it. Anything with no source must be pulled from the live deployment
   first. `public-properties` is already correct (`v9-20261008-landmarks` in git).
4. **RLS policies and grants.** Tables can exist with no policies — the app would
   read zero rows while looking healthy. Compare policies per table between the two
   projects (`pg_policies`) before cutover.
5. **Secrets values.** FREEBUFF has the secret *names*; the *values* may differ
   (`HERMES_API_KEY`, `LOVABLE_API_KEY` is missing on FREEBUFF). Any function that
   calls an LLM/API will fail until the values are set.

## Execution order

```
PHASE 0  FREEZE + SNAPSHOT
   - announce a write-freeze window (bot replies only; no creates/edits)
   - full backup of TEST 1 to disk:  npx tsx scripts/backup.ts   (maps-realestate)
   - record row counts + sha of every table as the "source of truth" baseline

PHASE 1  SCHEMA PARITY (no data)
   - apply all migrations to FREEBUFF (supabase/migrations/*.sql)
   - diff columns, types, indexes, constraints, RLS policies, grants per table
   - create the auth user with the SAME id

PHASE 2  REFERENCE + OWNED DATA (order matters, FK-safe)
   properties            (47)     ← parents first
   property_images       (374)
   property_contacts     (51)
   price_changes          (1)
   price_change_log       (5)
   landmark_resolution_log(949)
   owner_lookup_log       (8)
   customer_leads        (13)     ← PII
   profiles               (2)     ← after the auth user exists
   hermes_events         (976)    ← event log; lowest risk, migrate last
   (delete FREEBUFF's 1 stray hermes_events row first)

PHASE 3  STORAGE
   - copy all 374 objects bucket→bucket
   - verify object count == property_images count, and spot-check 5 URLs return 200

PHASE 4  FUNCTIONS + SECRETS
   - set secret VALUES on FREEBUFF (verify HERMES_API_KEY actually works)
   - deploy all 9 functions to FREEBUFF; delete test-hello + edge-runtime-test
   - verify public-properties returns version v9-20261008-landmarks with 45+ rows

PHASE 5  VERIFY (before switching anything)
   - row counts match per table; FK orphans = 0
   - one end-to-end request per function against FREEBUFF
   - the acceptance test: ask LINA "КАЈ СЕ НАОЃА 76?" (after the switch)

PHASE 6  SWITCH (the only irreversible-feeling step)
   - point LINA at FREEBUFF: src/config.ts URL + the bundled anon key,
     plus every script that hardcodes the old ref
     (scripts/backfill-geo.ts, geo-watcher.ts, refresh-monthly.ts, street-census.ts,
      street-teach.ts in maps-realestate; and inbound_final's config + env)
   - restart the bot; confirm the boot log shows the new project
   - re-apply the freeze-release: new writes must go ONLY to FREEBUFF

PHASE 7  ROLLBACK WINDOW
   - keep TEST 1 read-only and untouched for 30 days
   - document the exact revert (config + restart), one command each
```

## Acceptance criteria

- [ ] row counts equal for all 10 tables; 0 FK orphans
- [ ] 374/374 storage objects present; 5 sampled URLs return HTTP 200
- [ ] auth user exists with the same id; `profiles` join resolves
- [ ] all 9 functions respond; `public-properties` reports v9-20261008-landmarks
- [ ] LINA answers "КАЈ СЕ НАОЃА 76?" with a landmark **and** a coordinate pin
- [ ] no writes reach TEST 1 after the switch (verified over 24 h)
- [ ] TEST 1 backup on disk + 30-day retention agreed

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Auth user id differs | logins break, orphaned profiles | create via Admin API with the explicit id, verify before Phase 6 |
| Images not copied | silent broken photos in the app | count + HTTP 200 spot-check (Phase 3) |
| RLS missing on FREEBUFF | app sees 0 rows, looks "empty" | diff `pg_policies` in Phase 1 |
| Secret values wrong | LLM/Hermes functions fail | test one call per function in Phase 4 |
| Function source drift | deployed behaviour ≠ repo | diff against the live version before redeploying |
| Writes during migration | data loss between snapshot and cutover | freeze window + final delta re-sync |

## What this plan does NOT do

- It does not delete or modify anything in TEST 1.
- It does not touch LINA's running config until Phase 6, which is a separate,
  explicitly-approved step.
- It does not attempt the migration while the bot is taking writes.

**Decision needed before Phase 0:** approve the write-freeze window and the runtime
switch. Everything up to and including Phase 5 is additive and reversible; Phase 6
is the point of no easy return.
