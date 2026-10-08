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

echo ""
echo "Done. Restart the TUI on target so it reopens the fresh DB:"
echo "  pkill -f 'tsx src/tui/run.ts'"
echo "  GOOGLE_MAPS_ENABLED=false OSM_ENABLED=false npx tsx src/tui/run.ts"
