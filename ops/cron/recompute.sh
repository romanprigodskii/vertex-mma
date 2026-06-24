#!/bin/bash
# Canonical post-scrape recompute chain.
#
# Rebuilds every derived fighter column + the score-history / divisional /
# catalog snapshots from the freshly scraped bout + round-stats data.
# Each script resets its own target first, so the whole chain is idempotent
# and safe to re-run. ~5 min on the current roster.
#
# ORDER MATTERS — dependency rationale lives in the scripts/*.ts docstrings:
#   1  derive_title_fights        rewrites the curated title-fight set first
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

for s in \
  derive_title_fights \
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
