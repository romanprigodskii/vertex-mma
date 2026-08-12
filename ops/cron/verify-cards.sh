#!/bin/bash
# Every 6h at :20 — diff every upcoming card we serve against the live
# UFCStats card (scripts/scraper/scripts/verify_cards_against_ufcstats.py).
#
# Runs 20 minutes past the scrape-refresh slot on purpose: it checks what that
# scrape just wrote, so a refresh that under-read a card is caught on the same
# tick rather than a tick later.
#
# This is the check whose absence let three fights that were never booked sit
# on live cards for a week. Every scrape had "succeeded" — nothing ever asked
# whether our card agreed with the source. Two kinds of drift are reported:
#
#   EXTRA   — on our card, not on UFCStats (an unadopted provisional row, or a
#             bout UFCStats has since pulled)
#   MISSING — on UFCStats, not on ours (a scrape that silently under-read)
#
# Read-only: it never writes to the database, so a bad verdict costs a log line
# and nothing else. Drift is logged as `CARD DRIFT` — grep for that:
#
#   grep "CARD DRIFT" /var/log/vertex-cron.log
#
# Shares /var/lock/vertex-scrape.lock with the scrapers: it hits ufcstats.com
# and there is no reason to compete with a running scrape for it. Skipping is
# harmless — the next tick is 6h away and the check is stateless.
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
  if ! flock -n 9; then echo "===== $(ts) verify-cards: scrape lock busy, skipping ====="; exit 0; fi

  echo "===== $(ts) verify-cards start ====="
  cd /opt/vertex-cron/vertex-mma || { echo "$(ts) checkout missing"; exit 1; }
  git_sync
  cd scripts/scraper || { echo "$(ts) scraper dir missing"; exit 1; }
  [ -x venv/bin/python ] || { echo "$(ts) scraper venv missing — run a scrape job first"; exit 1; }

  venv/bin/python scripts/verify_cards_against_ufcstats.py
  rc=$?
  if [ $rc -eq 1 ]; then
    # Exit 1 is the script's "cards disagree with the source" verdict, not a
    # crash — the drifting bouts are named in the lines just above this one.
    echo "$(ts) CARD DRIFT — our upcoming cards disagree with UFCStats (see the EXTRA/MISSING lines above)"
  elif [ $rc -ne 0 ]; then
    echo "$(ts) verify-cards FAILED to run (exit $rc)"
  fi
  echo "===== $(ts) verify-cards done ====="
} >> "$LOG" 2>&1
