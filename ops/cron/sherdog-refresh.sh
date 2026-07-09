#!/bin/bash
# DAILY Sherdog pre-UFC fight-history sync (04:00 — after rankings 03:30,
# before scrape-stats 04:30 and predict 05:15, so a late-notice debutant's
# regional record reaches the model the same morning).
#
# Incremental step 17 targets only:
#   * fighters never attempted (new roster additions / DWCS signings),
#   * upcoming-bout fighters that are unmatched (retry before fight day —
#     the opponent-history fallback resolves more as opponents sync),
#   * upcoming-bout fighters whose history is older than 7 days.
# Once the one-time backfill is done this is a handful of fighters per
# day (~2 requests each at 1 req/s) — minutes, not hours.
#
# Own lock (fd 6, /var/lock/vertex-sherdog.lock) — deliberately NOT the
# shared scrape lock: scrape-stats/scrape-full use non-blocking flock and
# would silently skip their entire run if we held the shared lock past
# 04:30. Sherdog traffic doesn't touch ufcstats.com, so overlap is fine.
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
  exec 6>/var/lock/vertex-sherdog.lock
  if ! flock -n 6; then echo "===== $(ts) sherdog: lock busy, skipping ====="; exit 0; fi

  echo "===== $(ts) sherdog start ====="
  cd /opt/vertex-cron/vertex-mma || { echo "$(ts) checkout missing"; exit 1; }
  git_sync
  VENV=scripts/scraper/venv
  [ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install --quiet --upgrade pip; }
  "$VENV/bin/pip" install --quiet -r scripts/scraper/requirements.txt || echo "$(ts) pip warned"

  cd scripts/scraper
  echo "$(ts) sherdog incremental sync (new + upcoming-bout fighters)"
  venv/bin/python scripts/17_scrape_sherdog.py || echo "$(ts) sherdog sync FAILED (non-fatal)"
  echo "===== $(ts) sherdog done ====="
} >> "$LOG" 2>&1
