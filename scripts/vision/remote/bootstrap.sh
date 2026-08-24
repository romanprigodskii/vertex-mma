#!/usr/bin/env bash
# Runs ON the rented box. Idempotent — safe to re-run after a disconnect.
#
#   bash bootstrap.sh
#
# Expects the code already pushed to ~/vision by push.sh, including
# artifacts/manifest.json (which carries the fight list AND the UFCStats
# ground truth, so the box never needs database access) and a cookie
# jar at ~/vision/cookies.txt.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

echo "=== system packages ==="
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ffmpeg python3-venv python3-pip curl >/dev/null
fi

echo "=== python env ==="
[ -d venv ] || python3 -m venv venv
./venv/bin/pip install -q --upgrade pip
# torch first and on its own: the CUDA build is large and pip's resolver
# will otherwise try to reconcile it against everything else at once.
./venv/bin/python -c "import torch" 2>/dev/null || ./venv/bin/pip install -q torch torchvision
./venv/bin/pip install -q ultralytics pandas pyarrow opencv-python-headless yt-dlp

echo "=== device ==="
./venv/bin/python - <<'PY'
import torch
print("cuda:", torch.cuda.is_available(),
      torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")
PY

echo "=== ready ==="
echo "run:  cd $ROOT && VERTEX_YT_COOKIES=\$PWD/cookies.txt \\"
echo "        ./venv/bin/python scripts/run_pipeline.py --holdout --limit 35 --workers 8"
