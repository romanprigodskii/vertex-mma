#!/bin/bash
# DAILY — score upcoming UFC bouts with the committed model and write
# bout_simulation / _features / _rounds (winner prob + SHAP + Monte-Carlo
# method/round props). Without this the sportsbook odds and the "how they win"
# panel go STALE: bookmaker odds refresh every 6h, but the model's own
# predictions and MC prop markets only changed on a manual run (the gap the
# audit flagged — run_predict was absent from cron).
#
# Runs AFTER the daily 04:30 scrape-stats + recompute so predictions are built
# on fresh point-in-time features (updated fighter_score_history etc.). It's a
# pure DB read/write (no ufcstats fetch), so it does NOT take the shared scrape
# lock — but 05:15 already sits in the gap between scrape-stats (04:30) and the
# weekly full scrape (Sun 05:30).
#
# NOTE: this uses the simulation package, which reads DATABASE_URL from
# .env.local at the repo root (scripts/simulation/src/db.py) — ensure that file
# exists on the VPS checkout. It scores with the COMMITTED model artifacts; it
# does NOT retrain (weights refresh is a separate concern).
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
  echo "===== $(ts) predict-refresh start ====="
  cd /opt/vertex-cron/vertex-mma || { echo "$(ts) checkout missing"; exit 1; }
  git_sync

  # Set up / refresh the simulation venv (separate from the scraper venv).
  VENV=scripts/simulation/venv
  [ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install --quiet --upgrade pip; }
  "$VENV/bin/pip" install --quiet -r scripts/simulation/requirements.txt || echo "$(ts) pip warned"

  cd scripts/simulation
  echo "$(ts) scoring upcoming bouts (run_predict)"
  venv/bin/python scripts/run_predict.py || echo "$(ts) run_predict FAILED"
  echo "===== $(ts) predict-refresh done ====="
} >> "$LOG" 2>&1
