#!/usr/bin/env bash
# Runs ON the rented box. Idempotent — safe to re-run after a disconnect,
# which on a spot instance is not a hypothetical.
#
#   bash ~/vision/remote/bootstrap.sh
#
# Expects code already pushed to ~/vision by push.sh, including
# artifacts/manifest.json (which carries the fight list AND the UFCStats
# ground truth, so the box never needs database access) and a cookie jar
# at ~/vision/cookies.txt.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

# The Vast base image ships a venv at /venv/main and `uv`, which installs
# an order of magnitude faster than pip. Use them rather than building a
# second environment beside them.
VENV=${VENV:-/venv/main}
if [ -d "$VENV" ]; then
  PY="$VENV/bin/python"
  INSTALL="uv pip install --python $PY"
else
  [ -d venv ] || python3 -m venv venv
  PY="$ROOT/venv/bin/python"
  INSTALL="$ROOT/venv/bin/pip install"
fi

echo "=== system packages ==="
command -v ffmpeg >/dev/null || {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq ffmpeg
}
echo "ffmpeg: $(ffmpeg -version 2>/dev/null | head -1 | cut -c1-40)"

echo "=== python packages ==="
# torch first and alone: the CUDA wheel is large, and letting the
# resolver reconcile it against everything else at once is how a fast
# install becomes a slow one.
$PY -c "import torch" 2>/dev/null || $INSTALL torch torchvision
$INSTALL ultralytics pandas pyarrow opencv-python-headless yt-dlp

echo "=== device ==="
$PY - <<'PY'
import torch
print("torch", torch.__version__)
print("cuda :", torch.cuda.is_available(),
      torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")
PY

echo "$PY" > "$ROOT/.python-path"
echo "=== ready ==="
echo "run:  cd $ROOT && VERTEX_YT_COOKIES=\$PWD/cookies.txt \\"
echo "        $PY scripts/run_pipeline.py --holdout --limit 35 --workers 8"
