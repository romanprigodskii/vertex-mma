#!/usr/bin/env bash
# Push the local photo store to the nginx origin on the VPS.
#
# The scraper writes into PHOTO_STORE_DIR (default ~/.cache/vertexmma-photos)
# because ufc.com answers the VPS with a 403 — the fetch has to happen from a
# residential connection, so the bytes have to travel afterwards. Additive:
# rsync never deletes on the far side, so a partial run cannot wipe photos it
# simply did not refetch.
set -euo pipefail

cd "$(dirname "$0")/.."
exec ./venv/bin/python -c "
import sys
sys.path.insert(0, 'scripts')
import _path  # noqa: F401
from src.storage import publish
publish(dry_run=${DRY_RUN:-False})
"
