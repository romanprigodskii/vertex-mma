from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

import _path  # noqa: F401

from src.utils.logger import log

PHASES = {
    "events": "01_scrape_events.py",
    "fighters": "02_scrape_fighters.py",
    "bouts": "03_scrape_bouts.py",
    "enrich-fighters": "04_enrich_fighters.py",
    "enrich-bouts": "05_enrich_bouts.py",
    "scorecards": "07_scrape_scorecards.py",
    "odds": "08_scrape_bestfightodds.py",
}

PHASE_GROUPS = {
    "quick": ["events", "fighters", "bouts"],
    # Cheap scheduled refresh: re-list events (2 pages) and re-scrape bouts for
    # upcoming + recent cards only (set SCRAPE_BOUTS_SINCE_DAYS, e.g. 21). Pull
    # odds separately via 08 (it has its own entrypoint, no run_all hook).
    "refresh": ["events", "bouts"],
    "enrich": ["enrich-fighters", "enrich-bouts"],
    "all": [
        "events",
        "fighters",
        "bouts",
        "enrich-fighters",
        "enrich-bouts",
        "scorecards",
    ],
}


def _load_phase(filename: str):
    path = Path(__file__).parent / filename
    spec = importlib.util.spec_from_file_location(filename.removesuffix(".py"), path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser(description="Run UFC stats scraper phases.")
    parser.add_argument(
        "--phase",
        required=True,
        choices=[*PHASE_GROUPS.keys(), *PHASES.keys()],
        help="Phase or group to run.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Max items to process within each phase (useful for smoke tests).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse and report, but don't write to the database.",
    )
    args = parser.parse_args()

    phases = PHASE_GROUPS.get(args.phase, [args.phase])
    log.info(f"running phases: {', '.join(phases)} (limit={args.limit}, dry_run={args.dry_run})")

    for name in phases:
        log.info(f"=== phase: {name} ===")
        module = _load_phase(PHASES[name])
        result = module.run(limit=args.limit, dry_run=args.dry_run)
        log.info(f"phase {name} done: {result}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
