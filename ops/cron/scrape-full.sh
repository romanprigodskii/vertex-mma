#!/bin/bash
# WEEKLY full backfill (Sun): --phase all = events + fighters (A-Z) +
# bouts + enrich-fighters (career stats) + enrich-bouts (per-round stats)
# + scorecards, then the full recompute chain. This is the comprehensive
# pass; the daily scrape-stats job keeps things fresh in between. ~60-90 min.
# flock-guarded so it never overlaps the 6h/daily scrapers.
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
  exec 9>/var/lock/vertex-scrape.lock
  if ! flock -n 9; then echo "===== $(ts) scrape-full: scrape lock busy, skipping ====="; exit 0; fi

  echo "===== $(ts) scrape-full start ====="
  cd /opt/vertex-cron/vertex-mma || exit 1
  git_sync
  VENV=scripts/scraper/venv
  [ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install --quiet --upgrade pip; }
  "$VENV/bin/pip" install --quiet -r scripts/scraper/requirements.txt || echo "$(ts) pip warned"
  cd scripts/scraper
  echo "$(ts) run_all --phase all (events+fighters+bouts+enrich-fighters+enrich-bouts+scorecards)"
  venv/bin/python scripts/run_all.py --phase all || echo "$(ts) scrape all FAILED (non-fatal, recompute still runs)"

  cd /opt/vertex-cron/vertex-mma
  echo "$(ts) recompute chain"
  /opt/vertex-cron/recompute.sh || echo "$(ts) recompute FAILED"
  echo "===== $(ts) scrape-full done ====="
} >> "$LOG" 2>&1
