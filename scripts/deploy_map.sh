#!/usr/bin/env bash
# Ship the offline map DB to production — with checksum verification.
#
# WHY: ops drift bit us twice — production ran an old skopje-pois.db while
# dev had the rebuilt one, so landmarks differed per machine. This script
# packages the DB WITH a sha256 sidecar; the boot self-check on the target
# prints [db:xxxxxxxx] so mismatch is visible in the first second.
#
# Usage:
#   scripts/deploy_map.sh user@host /path/to/inbound_final
#
# Steps on THIS machine: verify DB opens → write checksum → tar → scp.
# Steps on TARGET (run automatically via ssh): backup old db, extract,
# verify checksum, print new [db:] identity.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 user@host /path/to/inbound_final"
  exit 1
fi
TARGET="$1"
REMOTE_DIR="$2"

DB="data/skopje-pois.db"
[[ -f "$DB" ]] || { echo "✗ $DB not found — run scripts/update_map.sh first"; exit 1; }

echo "→ verifying local DB opens and has data…"
ROWCOUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pois;")
ADDRS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM addresses;" 2>/dev/null || echo 0)
[[ "$ROWCOUNT" -gt 1000 ]] || { echo "✗ only $ROWCOUNT POIs — refusing to ship a broken map"; exit 1; }
SUM=$(sha256sum "$DB" | cut -c1-8)
echo "  ok: $ROWCOUNT POIs / $ADDRS addresses [db:$SUM]"

# ── manual fixes must be IN the DB that ships ───────────────────────────────
# data/address-overrides.json holds POIs OSM/Google do not have (KAM Market,
# ТЦ Олимпико, schools, embassy corrections…). The DB is a build artifact: any
# run of scripts/rebuild_map.ts REGENERATES it and silently drops every manual
# fix, and only update_map.sh re-applies them — so "the single supported entry
# point" was a convention, not a guarantee. That is exactly how the shipped map
# was found missing all 5 override POIs on 2026-10-11. The deploy is the last
# gate before production, so the invariant is enforced HERE: re-apply the
# overrides, then prove every one is present. Nothing bypasses a deploy.
OVERRIDES="data/address-overrides.json"
if [[ -f "$OVERRIDES" ]]; then
  MISSING=$(node -e '
    const fs=require("fs"),D=require("better-sqlite3");
    const ov=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const db=new D(process.argv[2],{readonly:true});
    const miss=(ov.pois||[]).filter(p=>
      db.prepare("SELECT COUNT(*) n FROM pois WHERE name=? AND lat=? AND lon=?").get(p.name,p.lat,p.lon).n===0
    ).map(p=>p.name);
    db.close(); if(miss.length) console.log(miss.join(" | "));
  ' "$OVERRIDES" "$DB")
  if [[ -n "$MISSING" ]]; then
    echo "  ⚠ DB is missing manual fix(es): $MISSING"
    echo "  → re-applying $OVERRIDES…"
    npx tsx scripts/apply_overrides.ts >/dev/null
    MISSING=$(node -e '
      const fs=require("fs"),D=require("better-sqlite3");
      const ov=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const db=new D(process.argv[2],{readonly:true});
      const miss=(ov.pois||[]).filter(p=>
        db.prepare("SELECT COUNT(*) n FROM pois WHERE name=? AND lat=? AND lon=?").get(p.name,p.lat,p.lon).n===0
      ).map(p=>p.name);
      db.close(); if(miss.length) console.log(miss.join(" | "));
    ' "$OVERRIDES" "$DB")
    if [[ -n "$MISSING" ]]; then
      echo "  ❌ STILL missing after re-apply: $MISSING — refusing to ship a map without its manual fixes"
      exit 1
    fi
    # The DB changed (fixes restored) — recompute the shipped checksum.
    SUM=$(sha256sum "$DB" | cut -c1-8)
    ROWCOUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pois;")
    echo "  ✓ fixes restored: $ROWCOUNT POIs [db:$SUM]"
  else
    echo "  ✓ all manual fixes present in the DB"
  fi
fi

STAMP=$(date +%Y%m%d-%H%M%S)
PKG="map-deploy-$STAMP.tar.gz"
tar czf "$PKG" "$DB" "$DB.sha256" 2>/dev/null || {
  echo "$SUM  $(basename "$DB")" > "$DB.sha256"
  tar czf "$PKG" "$DB" "$DB.sha256"
}

echo "→ uploading $PKG…"
scp -q "$PKG" "$TARGET:/tmp/"

echo "→ deploying on target (old DB backed up to skopje-pois.db.bak-$STAMP)…"
ssh "$TARGET" "cd '$REMOTE_DIR' && \
  cp data/skopje-pois.db data/skopje-pois.db.bak-$STAMP 2>/dev/null || true && \
  tar xzf /tmp/$PKG && \
  sha256sum -c <(sed 's|.*  |'\"$DB\"' |' /dev/null) >/dev/null 2>&1 || true; \
  ACTUAL=\$(sha256sum \"$DB\" | cut -c1-8); \
  echo \"  deployed [db:\$ACTUAL] (expected [db:$SUM])\"; \
  rm -f /tmp/$PKG; \
  [[ \"\$ACTUAL\" == \"$SUM\" ]] && echo '  ✅ checksum match' || { echo '  ❌ CHECKSUM MISMATCH — restoring backup'; cp data/skopje-pois.db.bak-$STAMP data/skopje-pois.db; exit 1; }"

# ── restart the CONSUMER, don't just suggest it ────────────────────────────
# The map DB is opened once at TUI startup and held for the session. Shipping a
# new DB while the old process keeps running is a HALF deploy: every surface
# reads the fresh map, the TUI keeps serving the old one, and nothing says so.
# That is exactly how the workstation TUI served the pre-fix map after the last
# deploy (pid 1151). So the deploy restarts it here, path-anchored the same way
# deploy-atoms.sh does, and FAILS if a stale process survives.
#
# Only a TUI that is already running is restarted — it is an interactive tool,
# and a deploy must not conjure one on a machine that was not using it.
echo ""
echo "→ restarting the TUI on target so it reopens the fresh DB (if one is running)…"
# `if ! ssh` — the script runs under `set -e`, so a bare failing ssh would abort
# before any check could report WHY. The heredoc carries the remote logic; the
# remote exit status is what decides success here.
if ! ssh "$TARGET" bash -s "$REMOTE_DIR" <<'REMOTE'
set -u
REMOTE_DIR="$1"
cd "$REMOTE_DIR"
mkdir -p logs data
# Find TUIs whose cwd is THIS project — never touch another project's process.
tui_pids() {
  for pid in $(pgrep -f 'tsx src/tui/run.ts' 2>/dev/null); do
    [ "$(readlink /proc/$pid/cwd 2>/dev/null)" = "$REMOTE_DIR" ] && echo "$pid"
  done
}
# Remember the launch environment of the running TUI so the restart is identical.
old=$(tui_pids | head -1)
if [ -z "$old" ]; then
  echo "  no TUI running — nothing to restart (a deploy never starts one)"
  exit 0
fi
ENVLINE="$(tr '\0' '\n' < /proc/$old/environ 2>/dev/null \
  | grep -E '^(GOOGLE_MAPS_ENABLED|OSM_ENABLED|SKOPJE_POIS_DB)=' | tr '\n' ' ' || true)"
echo "  stopping TUI pid $old"
for pid in $(tui_pids); do kill "$pid" 2>/dev/null || true; done
for _ in $(seq 1 10); do
  [ -z "$(tui_pids)" ] && break
  sleep 1
done
if [ -n "$(tui_pids)" ]; then
  echo "  ✗ stale TUI pid $(tui_pids | tr '\n' ' ') still alive — NOT starting a second one"
  exit 1
fi
# Relaunch with the same DB/env it had. The old process held the DB it was
# started with; using SKOPJE_POIS_DB= (if set) keeps that contract explicit.
: > logs/tui-stdout.log
if [ -n "$ENVLINE" ]; then
  env $ENVLINE nohup npx tsx src/tui/run.ts >> logs/tui-stdout.log 2>&1 &
else
  GOOGLE_MAPS_ENABLED=false OSM_ENABLED=false nohup npx tsx src/tui/run.ts >> logs/tui-stdout.log 2>&1 &
fi
sleep 2
# Record the pid that ACTUALLY came up, not `$!`: npx is a wrapper that execs
# into node, so the shell job pid goes stale the moment it starts.
new=$(tui_pids | head -1)
if [ -n "$new" ]; then
  echo "$new" > data/tui.pid
  echo "  ✓ TUI restarted (pid $new)"
else
  echo "  ✗ TUI did not come back — inspect logs/tui-stdout.log"
  exit 1
fi
REMOTE
then
  echo "✗ deploy completed but the TUI restart FAILED — fix it before trusting the map."
  exit 1
fi
