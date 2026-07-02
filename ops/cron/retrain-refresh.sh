#!/bin/bash
# WEEKLY — retrain the bout-winner model on the latest data and, if the weights
# changed, commit + push the refreshed artifacts so the SERVED model stays
# current. train.py refits the served model on ALL data, so each run folds in
# the fights added since the last retrain — without this the served weights
# drift (the audit flagged ~2.5yr staleness: they had only seen data <2024).
#
# Runs AFTER the Sunday full scrape + recompute so it trains on the freshest
# point-in-time features. Pushing the artifacts is how they DEPLOY (push → other
# jobs' git pull + Coolify redeploy). Training is deterministic, so an unchanged
# dataset yields byte-identical artifacts and produces NO commit.
#
# Requirements on the VPS: git push access (deploy key) and .env.local at the
# repo root for DATABASE_URL. NOTE: this auto-commits to main weekly when new
# fights exist — switch the push to a review branch if you'd rather gate it.
export PATH=/usr/local/bin:/usr/bin:/bin
LOG=/var/log/vertex-cron.log
ts() { date "+%Y-%m-%d %H:%M:%S"; }
{
  echo "===== $(ts) retrain-refresh start ====="
  cd /opt/vertex-cron/vertex-mma || { echo "$(ts) checkout missing"; exit 1; }

  # Serialize with the scrape/recompute jobs (BLOCKING wait, unlike their
  # flock -n): the reset --hard below would otherwise wipe a mid-chain
  # champion reconcile on this shared checkout while Sunday's scrape-full
  # (05:30, ~60-90 min) is still running.
  exec 9>/var/lock/vertex-scrape.lock
  flock 9 || echo "$(ts) flock failed — proceeding unserialized"

  # Start from a clean, current main (discard any stale local artifact edits a
  # previous failed push may have left).
  git fetch --quiet origin main 2>/dev/null \
    && git reset --quiet --hard origin/main 2>/dev/null \
    && echo "$(ts) git: synced to $(git rev-parse --short HEAD)" \
    || echo "$(ts) git: sync skipped — staying on pinned $(git rev-parse --short HEAD 2>/dev/null)"

  VENV=scripts/simulation/venv
  [ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install --quiet --upgrade pip; }
  "$VENV/bin/pip" install --quiet -r scripts/simulation/requirements.txt || echo "$(ts) pip warned"

  echo "$(ts) retraining (eval split metrics + production refit-on-all)"
  ( cd scripts/simulation && venv/bin/python scripts/run_train.py ) \
    || { echo "$(ts) retrain FAILED"; echo "===== $(ts) retrain-refresh aborted ====="; exit 1; }

  # Commit + push only when the artifacts actually changed (new fights → new
  # weights). Deterministic training means an unchanged dataset is a no-op.
  if ! git diff --quiet -- scripts/simulation/artifacts; then
    git add scripts/simulation/artifacts
    git -c user.name="vertex-cron" -c user.email="cron@vertexmma.com" \
      commit -q -m "chore(model): weekly retrain on latest data [auto]" \
      -m "Refit-on-all served weights through $(date +%Y-%m-%d)." \
      || echo "$(ts) commit warned"
    if git push --quiet origin main 2>/dev/null; then
      echo "$(ts) pushed refreshed model artifacts → deploy"
    else
      echo "$(ts) push FAILED — committed locally, next run resets and retries"
    fi
  else
    echo "$(ts) no artifact change (dataset unchanged since last retrain)"
  fi
  echo "===== $(ts) retrain-refresh done ====="
} >> "$LOG" 2>&1
