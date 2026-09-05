#!/usr/bin/env bash
# Weekly offline-map pull (Sunday cron wrapper) — Hermes machine (T60 plan).
#
# Refreshes data/skopje-pois.db: Skopje's NAMED POIs + address rows from OSM
# (Overpass), the local geo engine the landmark resolver reads instead of live
# Nominatim/Overpass. Atomic build — if the pull fails, the previous map keeps
# serving. Output goes to data/logs/skopje-map.log, rotated at ~2 MB (2 old
# copies), same pattern as hermes-nightly.sh.
#
# Usage:
#   scripts/skopje-map-weekly.sh   # the cron entry
#
# Cron line (Sunday 03:17 — off-peak, same hour as the nightly):
#   17 3 * * 0 /abs/path/to/scripts/skopje-map-weekly.sh
set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/data/logs"
LOG_FILE="$LOG_DIR/skopje-map.log"
MAX_BYTES=$((2 * 1024 * 1024))

mkdir -p "$LOG_DIR"

# Rotate when over ~2 MB: drop .2, shift .1 -> .2, log -> .1.
if [ -f "$LOG_FILE" ] && [ "$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$MAX_BYTES" ]; then
  rm -f "$LOG_FILE.2"
  mv -f "$LOG_FILE.1" "$LOG_FILE.2" 2>/dev/null || true
  mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || true
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

log "=== skopje-map weekly pull ==="

cd "$PROJECT_DIR" || { log "ERROR: cannot cd $PROJECT_DIR"; exit 1; }

if ! npm run map:pull >> "$LOG_FILE" 2>&1; then
  log "ERROR: map:pull failed — the PREVIOUS map is still serving (atomic build)."
  exit 1
fi

log "=== done ==="
exit 0
