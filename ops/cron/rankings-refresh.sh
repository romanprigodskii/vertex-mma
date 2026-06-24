#!/bin/bash
# DAILY UFC rankings refresh (03:30, before the daily recompute at 04:30 so
# fresh ranks propagate into scores the same day).
#
#   1. fetch_ufc_rankings_live.py — GET live ufc.com/rankings (server-rendered)
#                                   → imports/ufc_rankings_raw/{today}.html
#   2. parse_ufc_rankings.py      — all raw HTML → imports/ufc_rankings_parsed.csv
#   3. import_ufc_rankings.ts     — CSV → ranking_snapshot (idempotent upsert)
#
# Live fetch = no Archive.org lag (was the Wayback scraper, which only had
# biweekly snapshots 1-3 days stale). The Wayback scraper
# (scripts/scrape_ufc_rankings.py) is kept for one-time HISTORY backfill but is
# not on the regular schedule — history doesn't change.
#
# ranking_snapshot feeds compute_opponent_quality (opponent tier by rank at
# bout date); the recompute chain then propagates it into the scores.
# Pure stdlib python + tsx — no scraper venv needed. Best-effort code sync.
export PATH=/usr/local/bin:/usr/bin:/bin
LOG=/var/log/vertex-cron.log
ts() { date "+%Y-%m-%d %H:%M:%S"; }
git_sync() {
  ( cd /opt/vertex-cron/vertex-mma \
    && git fetch --quiet origin main 2>/dev/null \
    && git reset --quiet --hard origin/main 2>/dev/null \
    && echo "$(ts) git: synced to $(git rev-parse --short HEAD)" \
    || echo "$(ts) git: sync skipped — staying on pinned $(git -C /opt/vertex-cron/vertex-mma rev-parse --short HEAD 2>/dev/null)" )
}
{
  exec 7>/var/lock/vertex-rankings.lock
  if ! flock -n 7; then echo "===== $(ts) rankings: lock busy, skipping ====="; exit 0; fi

  echo "===== $(ts) rankings start ====="
  cd /opt/vertex-cron/vertex-mma || { echo "$(ts) checkout missing"; exit 1; }
  git_sync
  echo "$(ts) live fetch ufc.com/rankings"
  python3 scripts/fetch_ufc_rankings_live.py || echo "$(ts) live fetch FAILED (non-fatal — parse/import still run on prior snapshots)"
  echo "$(ts) parse"
  python3 scripts/parse_ufc_rankings.py || echo "$(ts) rankings parse FAILED (non-fatal)"
  echo "$(ts) import -> ranking_snapshot"
  node_modules/.bin/tsx scripts/import_ufc_rankings.ts || echo "$(ts) rankings import FAILED (non-fatal)"
  echo "===== $(ts) rankings done ====="
} >> "$LOG" 2>&1
