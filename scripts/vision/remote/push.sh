#!/usr/bin/env bash
# Runs on the LAPTOP. Ships code and the manifest to the rented box.
#
#   ./push.sh root@ssh5.vast.ai -p 12345
#
# Sends a few hundred KB: source, scripts, and artifacts/manifest.json.
# Deliberately NOT the video or the skeletons — the whole point is that
# footage never crosses this connection.
#
# COOKIES: pushed only if ./cookies.txt exists next to this script, and
# it should be a jar from a THROWAWAY Google account. A YouTube session
# cookie is account-wide access, and a rented box is someone else's
# hardware. Do not put your real session on it.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=$1; shift
SSH_OPTS=("$@")

RSYNC_SSH="ssh ${SSH_OPTS[*]}"
rsync -az --info=stats1 -e "$RSYNC_SSH" \
  --exclude 'data/' --exclude 'venv/' --exclude '__pycache__/' \
  src scripts remote requirements.txt "$HOST:vision/"
rsync -az -e "$RSYNC_SSH" artifacts/manifest.json "$HOST:vision/artifacts/"

if [ -f remote/cookies.txt ]; then
  rsync -az -e "$RSYNC_SSH" remote/cookies.txt "$HOST:vision/cookies.txt"
  echo "cookies shipped"
else
  echo "NOTE: remote/cookies.txt absent — export a throwaway account's jar first:"
  echo "  yt-dlp --cookies-from-browser chrome --cookies remote/cookies.txt --simulate <any-url>"
fi
echo "now:  ssh ${SSH_OPTS[*]} $HOST 'bash vision/remote/bootstrap.sh'"
