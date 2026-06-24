#!/bin/bash
# Weekly UFC rankings refresh (Sun 03:30, before the daily recompute at 04:30
# so new ranks propagate into scores the same day).
#
#   1. scrape_ufc_rankings.py  — Wayback CDX → imports/ufc_rankings_raw/*.html
#                                (idempotent: only downloads new 14-day windows)
#   2. parse_ufc_rankings.py   — raw HTML → imports/ufc_rankings_parsed.csv
#   3. import_ufc_rankings.ts  — CSV → ranking_snapshot (idempotent upsert)
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
  echo "$(ts) wayback scrape"
  python3 scripts/scrape_ufc_rankings.py || echo "$(ts) rankings scrape FAILED (non-fatal)"
  echo "$(ts) parse"
  python3 scripts/parse_ufc_rankings.py || echo "$(ts) rankings parse FAILED (non-fatal)"
  echo "$(ts) import -> ranking_snapshot"
  node_modules/.bin/tsx scripts/import_ufc_rankings.ts || echo "$(ts) rankings import FAILED (non-fatal)"
  echo "===== $(ts) rankings done ====="
} >> "$LOG" 2>&1
