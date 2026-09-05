#!/usr/bin/env bash
# Manual offline-map update — run ONLY when you decide to refresh.
# Nothing in the system updates the map automatically; this script is the
# single supported entry point so the manual fixes can never be forgotten.
#
# Steps:
#   1. OSM rebuild   — fresh address data from OpenStreetMap
#   2. Google build  — replace POIs with Google Maps coordinates (SerpApi)
#   3. overrides     — re-apply every manual fix from data/address-overrides.json
#   4. audit         — coverage report over all feed properties
#
# Usage:  bash scripts/update_map.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== [1/4] Rebuilding map from OSM (for addresses) ==="
npx tsx scripts/rebuild_map.ts

echo ""
echo "=== [2/4] Replacing POIs with Google Maps data (SerpApi) ==="
echo "(Requires SERPAPI_KEY env var or data/serpapi-key.txt)"
npx tsx scripts/buildGoogleMap.ts

echo ""
echo "=== [3/4] Re-applying manual overrides ==="
npx tsx scripts/apply_overrides.ts

echo ""
echo "=== [4/4] Healthcheck (POI counts by source, cache tiers, queue) ==="
npx tsx scripts/healthcheck.ts

echo ""
echo "DONE. Ship the map with: scripts/deploy_map.sh user@host /path/to/bot"
