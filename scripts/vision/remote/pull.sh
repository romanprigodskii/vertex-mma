#!/usr/bin/env bash
# Runs on the LAPTOP. Brings results back.
#
#   ./pull.sh root@ssh5.vast.ai -p 12345           # features only, ~20 KB
#   ./pull.sh root@ssh5.vast.ai -p 12345 --skeletons   # + parquet, ~9 MB/fight
#
# Features are the default because this connection is a phone hotspot
# and the feature table is four orders of magnitude smaller than the
# skeletons it was computed from. Pull skeletons only when the raw
# keypoints are actually needed for re-analysis.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=$1; shift
WANT_SKELETONS=false
SSH_OPTS=()
for a in "$@"; do
  if [ "$a" = "--skeletons" ]; then WANT_SKELETONS=true; else SSH_OPTS+=("$a"); fi
done
RSYNC_SSH="ssh ${SSH_OPTS[*]}"

mkdir -p artifacts
rsync -az --info=stats1 -e "$RSYNC_SSH" \
  "$HOST:vision/artifacts/" artifacts/ || true

if $WANT_SKELETONS; then
  mkdir -p data/skeletons
  rsync -az --info=stats1 -e "$RSYNC_SSH" \
    "$HOST:vision/data/skeletons/" data/skeletons/
fi
echo "pulled. score locally with:"
echo "  ./venv/bin/python scripts/run_validation.py --set holdout"
