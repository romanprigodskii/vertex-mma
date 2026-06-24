#!/bin/bash
# DAILY incremental stats refresh (the gap this fixes):
#   1. enrich-bouts   — per-round bout statistics for any completed bout
#                       that still lacks them (sig strikes, TDs, control...).
#   2. scorecards     — judge scorecards for decision bouts missing them.
#   3. recompute.sh   — rebuild scores / score-history / divisional / catalog
#                       so the new fights actually move the ratings.
#
# enrich-bouts + scorecards only target bouts WITHOUT data, so once caught
# up this is cheap (a handful of bouts per event week). Whole job ~5-15 min.
# flock-guarded against the 6h refresh + weekly full so scrapers never
# overlap (rude to ufcstats + avoids DB contention).
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
  # Shared scrape lock: skip this tick if another scrape job is running.
  exec 9>/var/lock/vertex-scrape.lock
  if ! flock -n 9; then echo "===== $(ts) scrape-stats: scrape lock busy, skipping ====="; exit 0; fi

  echo "===== $(ts) scrape-stats start ====="
  cd /opt/vertex-cron/vertex-mma || { echo "$(ts) checkout missing"; exit 1; }
  git_sync
  # Keep node deps in sync with the checked-out code (fast no-op when satisfied).
  pnpm install --frozen-lockfile --prefer-offline --silent || echo "$(ts) pnpm install warned"
  VENV=scripts/scraper/venv
  [ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install --quiet --upgrade pip; }
  "$VENV/bin/pip" install --quiet -r scripts/scraper/requirements.txt || echo "$(ts) pip warned"

  cd scripts/scraper
  echo "$(ts) enrich-bouts (per-round stats)"
  venv/bin/python scripts/run_all.py --phase enrich-bouts || echo "$(ts) enrich-bouts FAILED (non-fatal)"
  # Newest-first + a checkpoint that records every attempt (incl. "no card
  # exists"), so the backlog drains permanently. --limit bounds a single run
  # so a fresh backlog can never hold the scrape lock for hours.
  echo "$(ts) scorecards (limit 120, newest first)"
  venv/bin/python scripts/07_scrape_scorecards.py --limit 120 || echo "$(ts) scorecards FAILED (non-fatal)"

  cd /opt/vertex-cron/vertex-mma
  echo "$(ts) recompute chain"
  /opt/vertex-cron/recompute.sh || echo "$(ts) recompute FAILED"
  echo "===== $(ts) scrape-stats done ====="
} >> "$LOG" 2>&1
