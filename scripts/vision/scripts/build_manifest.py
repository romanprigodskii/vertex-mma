"""bout_video -> artifacts/manifest.json, with the rejects written down."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.manifest import load_corpus, write_manifest  # noqa: E402


def main() -> None:
    usable, rejected = load_corpus()
    path = write_manifest()

    print(f"usable   : {len(usable)}")
    print(f"rejected : {len(rejected)}")
    for r in rejected:
        print(f"  - {r['event_date']}  {r['title'][:60]}")
        print(f"    {r['reason']}")

    finishes = sum(1 for f in usable if f.round_finished < f.scheduled_rounds)
    print()
    print(f"finishes : {finishes}  decisions: {len(usable) - finishes}")
    print(f"span     : {min(f.event_date for f in usable)} -> {max(f.event_date for f in usable)}")
    print(f"footage  : {sum(f.duration_seconds for f in usable) / 3600:.1f} h")
    print(f"written  : {path}")


if __name__ == "__main__":
    main()
