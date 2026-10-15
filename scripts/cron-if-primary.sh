#!/usr/bin/env bash
# cron-if-primary.sh — RETIRED. Do not schedule this; nothing is scheduled.
#
# NO CRONS (2026-10-14): this file exists ONLY to coordinate which machine's
# crontab runs the monthly job — i.e. it is a scheduler for a scheduler. With
# every schedule removed it has no job left to guard, and `cron-if-primary` is
# one of the patterns install-cron.ts strips from any crontab it finds.
#
# Kept (not deleted) so that an old note or an old crontab line finds an
# explanation here instead of a missing file. The failover question it solved is
# now answered by hand: you run the pass on the machine that owns the map.
#
# If it were ever revived, the original contract was: PRIMARY = T60
# (192.168.1.20), SECONDARY = T620 (192.168.1.101); the secondary ran its job
# only while the primary was unreachable (ICMP ping, 1 packet, 2s timeout — no
# ssh keys needed on the secondary), so exactly one machine did the work with no
# double SerpApi spend. That is, it was a good solution to a problem the no-cron
# decision deletes.
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
