"""How much video buys how many testable bouts?

The decline detector asks whether a fighter's trajectory predicts his
next result. That makes a bout usable as a TEST only when both corners
already carry pose history — so the quantity to plan against is not
"bouts downloaded" but "bouts that become testable", and the two differ
by a lot.

The relationship is superlinear in the right direction: adding one more
fight for a fighter who already has three makes every LATER bout of his
testable too. Which is the whole argument for buying depth over breadth
— 300 fighters with their full histories beats 2000 fighters with one
fight each, at a fraction of the download.

    python scripts/plan_corpus.py --min-history 3
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.db import get_connection  # noqa: E402

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"

# Fight Pass coverage thins out on older cards, and broadcast style
# before this is different enough that pose features may not transfer.
SINCE = "2015-01-01"

_QUERY = """
select b.id::text, e.date::date::text,
       b.fighter_a_id::text, b.fighter_b_id::text,
       fa.name_en, fb.name_en
from bout b
join event e   on e.id = b.event_id
join fighter fa on fa.id = b.fighter_a_id
join fighter fb on fb.id = b.fighter_b_id
where b.status = 'completed'
  and b.round_finished is not null
  and e.date >= %s
order by e.date
"""


def load():
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(_QUERY, (SINCE,))
        return cur.fetchall()


def evaluate(bouts, chosen: set[str], min_history: int):
    """Testable bouts, given we own video for fighters in `chosen`."""
    seen = defaultdict(int)
    downloaded = testable = 0
    for _bid, _date, a, b, _na, _nb in bouts:
        have = (a in chosen) and (b in chosen)
        if have:
            downloaded += 1
            if seen[a] >= min_history and seen[b] >= min_history:
                testable += 1
        # History accrues only from bouts we actually hold video for.
        if a in chosen and b in chosen:
            seen[a] += 1
            seen[b] += 1
    return downloaded, testable


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-history", type=int, default=3,
                    help="prior bouts on tape each corner needs")
    args = ap.parse_args()

    bouts = load()
    counts = defaultdict(int)
    for _bid, _d, a, b, _na, _nb in bouts:
        counts[a] += 1
        counts[b] += 1
    ranked = sorted(counts, key=lambda f: -counts[f])

    print(f"UFC bouts since {SINCE}: {len(bouts)}")
    print(f"fighters involved      : {len(counts)}")
    print(f"needing >= {args.min_history} prior bouts on tape per corner\n")
    print(f"{'top fighters':>13} {'bouts to fetch':>15} {'testable':>10} {'yield':>7}")

    rows = []
    for n in (100, 150, 200, 300, 400, 600, 900, len(ranked)):
        n = min(n, len(ranked))
        chosen = set(ranked[:n])
        dl, test = evaluate(bouts, chosen, args.min_history)
        rows.append({"fighters": n, "fetch": dl, "testable": test,
                     "yield": test / dl if dl else 0.0})
        print(f"{n:>13} {dl:>15} {test:>10} {test/dl if dl else 0:>6.0%}")

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / "corpus_plan.json").write_text(json.dumps(
        {"since": SINCE, "min_history": args.min_history, "curve": rows},
        indent=2))
    print(f"\nwritten: {ARTIFACTS / 'corpus_plan.json'}")


if __name__ == "__main__":
    main()
