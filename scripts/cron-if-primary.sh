#!/usr/bin/env bash
# cron-if-primary.sh — FAILOVER GUARD for the secondary hub (T620).
#
# The cluster has TWO map hubs: PRIMARY = T60 (192.168.1.20), SECONDARY = T620
# (192.168.1.101). Both run the same crons; the secondary runs its job ONLY
# while the primary is unreachable. Result: whichever machine is alive does
# the work — no double SerpApi spend, no double Overpass load, crons stay
# fire-and-forget with zero coordination infrastructure.
#
# Reachability = ICMP ping (1 packet, 2s timeout). Ping is used instead of ssh
# so the guard needs NO ssh keys on the secondary: a dead primary must never
# depend on credentials to be detected.
#
# Usage (from crontab):
#   0 4 1 * * /path/to/scripts/cron-if-primary.sh 192.168.1.20 \
#       /path/to/repo /path/to/repo/.node/bin/npx tsx scripts/refresh-monthly.ts \
#       >> /path/to/repo/logs/refresh.log 2>&1
set -u

PRIMARY="${1:?usage: cron-if-primary.sh <primary-host> <workdir> <command...>}"
WORKDIR="${2:?usage: cron-if-primary.sh <primary-host> <workdir> <command...>}"
shift 2

if ping -c 1 -W 2 "$PRIMARY" >/dev/null 2>&1; then
  echo "[$(date -Is)] primary $PRIMARY reachable — skipping: $*"
  exit 0
fi

echo "[$(date -Is)] primary $PRIMARY DOWN — FAILOVER RUN: $*"
cd "$WORKDIR"
exec "$@"
