"""Custom-simulation queue worker.

One-shot:  python scripts/run_custom.py            (process pending, exit)
Daemon:    python scripts/run_custom.py --loop [--interval 10]

The daemon mode is what the VPS runs as the `vertex-sim-worker` systemd
service (ops/systemd/vertex-sim-worker.service): it loads the committed
ensemble artifacts ONCE and polls the custom_simulation queue, so a user
request round-trips in roughly one poll interval + ~2s of scoring.

The model is never retrained here; artifacts refresh via the weekly
retrain cron + `systemctl restart vertex-sim-worker` (predict-refresh.sh
restarts the service daily after the git sync so code/artifact updates
are picked up)."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rich.console import Console

from src.custom import process_pending
from src.predict import LoadedModel

console = Console()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", action="store_true", help="poll forever")
    parser.add_argument("--interval", type=float, default=10.0)
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()

    model = LoadedModel()
    console.log(f"worker up — model {model.model_version}")

    if not args.loop:
        n = process_pending(model, limit=args.limit)
        console.log(f"processed {n} job(s)")
        return

    while True:
        try:
            n = process_pending(model, limit=args.limit)
            if n:
                console.log(f"processed {n} job(s)")
        except Exception as e:  # noqa: BLE001 — a DB blip must not kill the daemon
            console.log(f"poll error (will retry): {e}")
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
