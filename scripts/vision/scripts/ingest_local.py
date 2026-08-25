"""Point this at a folder of fight videos; it says what it can identify.

    python scripts/ingest_local.py ~/Downloads/fightpass

Nothing is copied or moved. The output is a manifest saying, per file,
which bout it is and how confident that is — and, loudly, which files it
refuses to guess at.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.local import match_directory, write_local_manifest  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("directory", type=Path)
    ap.add_argument("--show", type=int, default=10,
                    help="how many problem files to print in full")
    args = ap.parse_args()

    if not args.directory.is_dir():
        raise SystemExit(f"{args.directory} is not a directory")

    matches = match_directory(args.directory)
    if not matches:
        raise SystemExit(f"no video files under {args.directory}")

    path = write_local_manifest(matches)
    counts = Counter(m.status for m in matches)

    print(f"files      : {len(matches)}")
    for status in ("matched", "ambiguous", "inconsistent", "unmatched"):
        if counts.get(status):
            print(f"  {status:12}: {counts[status]}")

    for status in ("ambiguous", "inconsistent", "unmatched"):
        problems = [m for m in matches if m.status == status]
        if not problems:
            continue
        print(f"\n{status.upper()}")
        for m in problems[: args.show]:
            print(f"  {Path(m.path).name}")
            print(f"    {m.detail}")
        if len(problems) > args.show:
            print(f"  ... and {len(problems) - args.show} more (see {path.name})")

    print(f"\nwritten: {path}")


if __name__ == "__main__":
    main()
