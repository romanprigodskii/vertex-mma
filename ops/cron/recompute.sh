#!/bin/bash
# Canonical post-scrape recompute chain.
#
# Rebuilds every derived fighter column + the score-history / divisional /
# catalog snapshots from the freshly scraped bout + round-stats data.
# Each script resets its own target first, so the whole chain is idempotent
# and safe to re-run. ~5 min on the current roster.
#
# ORDER MATTERS — dependency rationale lives in the scripts/*.ts docstrings:
#   0  reconcile_champions        loss-rule + UFC-rankings champion sync
#                                 (NON-FATAL: a failure here must not block
#                                 the score recompute — downstream is correct
#                                 on the last committed champion data, and
#                                 reconcile self-heals next run)
#   1  derive_title_fights        rewrites the curated title-fight set
#      → then the curated-file commit block (persist EARLY: other wrappers'
#        git_sync reset --hard can fire mid-chain and would wipe
#        uncommitted edits; push = deploy via Coolify, which is wanted)
#   2  compute_opponent_quality   writes bout_opponent_tier (feeds 8/9/10/11)
#   3  compute_current_division
#   4  compute_championship_pedigree
#   5  compute_current_cp         needs (4)
#   6  compute_peak_scores
#   7  compute_era_dominance      needs (1)
#   8  compute_radar_aggregates   needs round stats + (2)
#   9  compute_score_history      replays the vertex view (needs 1-8)
#  10  materialize_vertex_score   copies view -> fighter columns
#  11  materialize_divisional_score  needs (10)
#  12  materialize_fighter_with_stats  refresh catalog matview last
#
# Called by scrape-stats.sh (daily) and scrape-full.sh (weekly). Writes to
# stdout/stderr — the caller redirects that into the shared cron log.
set -uo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
ts() { date "+%Y-%m-%d %H:%M:%S"; }
cd /opt/vertex-cron/vertex-mma || { echo "$(ts) recompute: checkout missing"; exit 1; }

# --- Step 0 (non-fatal): champion reconcile ---------------------------
echo "$(ts) recompute: reconcile_champions"
node_modules/.bin/tsx scripts/reconcile_champions.ts \
  || echo "$(ts) recompute: reconcile_champions FAILED (non-fatal — continuing on committed champion data)"

# --- Step 1 (strict): derive title fights ------------------------------
echo "$(ts) recompute: derive_title_fights"
if ! node_modules/.bin/tsx scripts/derive_title_fights.ts; then
  echo "$(ts) recompute: derive_title_fights FAILED — aborting chain (downstream would use stale inputs)"
  exit 1
fi

# --- Persist curated champion/title data (early, before the long steps) -
# Commit gated on a real content diff (generated files carry no timestamps,
# so no-change days stay quiet). Push only when a commit actually landed;
# rebase first because origin/main can move between the wrapper's git_sync
# and now (retrain push, manual push). All failures are self-healing: the
# next daily run re-derives identical edits from committed history + DB.
CURATED="src/lib/championship-history.ts src/lib/champions.ts src/lib/title-fights.ts"
if ! git diff --quiet -- $CURATED; then
  git add $CURATED
  if git -c user.name="vertex-cron" -c user.email="cron@vertexmma.com" \
      commit -q -m "chore(champions): auto-reconcile champions & title data [auto]"; then
    git fetch --quiet origin main 2>/dev/null || true
    if ! git rebase --quiet origin/main 2>/dev/null; then
      git rebase --abort 2>/dev/null || true
      echo "$(ts) recompute: rebase onto origin/main failed — commit stays local and the next git_sync will wipe it (idempotent re-derive next run)"
    fi
    if [ "$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)" -gt 0 ]; then
      if PUSH_OUT=$(git push origin main 2>&1); then
        echo "$(ts) recompute: pushed champion/title reconcile → deploy"
      else
        echo "$(ts) recompute: champions push FAILED (${PUSH_OUT}) — the next git_sync wipes the local commit; it will be re-derived and retried next run"
      fi
    fi
  else
    echo "$(ts) recompute: champions commit FAILED — edits will be re-derived next run"
  fi
fi

# --- Steps 2-12 (strict) ------------------------------------------------
for s in \
  compute_opponent_quality \
  compute_current_division \
  compute_championship_pedigree \
  compute_current_cp \
  compute_peak_scores \
  compute_era_dominance \
  compute_radar_aggregates \
  compute_score_history \
  materialize_vertex_score \
  materialize_divisional_score \
  materialize_fighter_with_stats; do
  echo "$(ts) recompute: $s"
  if ! node_modules/.bin/tsx "scripts/$s.ts"; then
    echo "$(ts) recompute: $s FAILED — aborting chain (downstream would use stale inputs)"
    exit 1
  fi
done
echo "$(ts) recompute: chain complete"
