#!/bin/bash
# Frequent UFCStats refresh (every 6h): re-list events + re-scrape the
# upcoming/recent window of bouts (cheap) + pull odds + refresh the
# fighter_with_stats matview. Best-effort code sync first.
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
MATVIEW='from src.db import get_connection; c=get_connection(); c.autocommit=True; c.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY fighter_with_stats"); c.close()'
{
  # Shared scrape lock: skip if a heavier scrape job (daily stats / weekly
  # full) is currently running. Light refresh will catch up next tick.
  exec 9>/var/lock/vertex-scrape.lock
  if ! flock -n 9; then echo "===== $(ts) scrape-refresh: scrape lock busy, skipping ====="; exit 0; fi

  echo "===== $(ts) scrape-refresh start ====="
  cd /opt/vertex-cron/vertex-mma || { echo "$(ts) checkout missing"; exit 1; }
  git_sync
  VENV=scripts/scraper/venv
  [ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install --quiet --upgrade pip; }
  "$VENV/bin/pip" install --quiet -r scripts/scraper/requirements.txt || echo "$(ts) pip warned"
  cd scripts/scraper
  echo "$(ts) run_all --phase refresh (since_days=21)"
  SCRAPE_BOUTS_SINCE_DAYS=21 venv/bin/python scripts/run_all.py --phase refresh || echo "$(ts) refresh phase FAILED"
  echo "$(ts) bestfightodds odds"
  venv/bin/python scripts/08_scrape_bestfightodds.py || echo "$(ts) odds step failed (non-fatal)"
  echo "$(ts) refresh fighter_with_stats matview"
  venv/bin/python -c "$MATVIEW" || echo "$(ts) matview refresh failed (non-fatal)"
  echo "===== $(ts) scrape-refresh done ====="
} >> "$LOG" 2>&1
