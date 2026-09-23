"""Write the downloaded BetsAPI archive into bout_odds_quote.

Reads only the cache that backfill_betsapi.py filled (data/betsapi/), so it
costs no API calls and can be re-run at will: rows are append-only and a
re-run lands on the unique key and writes nothing twice.

For every feed bout that happened and that we can match to exactly one of
our bouts (same fighters, card date within a day — see src/betsapi.py), every
book's pre-bell quotes are written in our bout's orientation: Bet365's full
line history plus each book's opening and last snapshot from the summary.

  venv/bin/python scripts/load_betsapi.py --dry-run     # match + counts, no writes
  venv/bin/python scripts/load_betsapi.py               # write
  venv/bin/python scripts/load_betsapi.py --unmatched   # list UFC bouts we could not place
"""

from __future__ import annotations

import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from backfill_betsapi import EVENTS, HISTORY, SUMMARY, is_ufc, load  # noqa: E402
from src.betsapi import (  # noqa: E402
    HAPPENED,
    OurBout,
    bout_prices,
    history_quotes,
    match_bout,
    pre_bell,
    summary_quotes,
)
from src.db import get_connection  # noqa: E402

SOURCE = "betsapi"
# UFC-branded cards UFCStats does not carry, so no bout of ours can match them.
# Their prices stay in the cache; the Sherdog pre-UFC history is where they
# would join, not the bout table.
NOT_ON_UFCSTATS = re.compile(r"contender series|road to ufc", re.I)

OUR_BOUTS_SQL = """
SELECT b.id::text, e.date::date, fa.name_en, fb.name_en
FROM bout b
JOIN event e ON e.id = b.event_id
JOIN fighter fa ON fa.id = b.fighter_a_id
JOIN fighter fb ON fb.id = b.fighter_b_id
WHERE e.date >= '2016-08-01'
  -- a price is evidence the bout was fought; a cancelled row of ours is at
  -- best a duplicate of the real one (Davis v Aliev, 2026-07-25, is both) and
  -- at worst the booking that never happened
  AND b.status <> 'cancelled'
"""

INSERT_SQL = """
INSERT INTO bout_odds_quote
  (bout_id, source, book, market, line, price_a, price_b, price_over,
   price_under, quoted_at, snapshot, external_id)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, to_timestamp(%s), %s, %s)
ON CONFLICT ON CONSTRAINT bout_odds_quote_unique DO NOTHING
"""


def feed_bouts() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for f in sorted(EVENTS.glob("*.json.gz")):
        for e in load(f) or []:
            if e.get("id") and e.get("time") and is_ufc(e):
                out[str(e["id"])] = e
    return out


def main() -> None:
    dry = "--dry-run" in sys.argv
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(OUR_BOUTS_SQL)
        ours = defaultdict(list)
        for bid, d, a, b in cur.fetchall():
            ours[d].append(OurBout(bid, d, a or "", b or ""))

    stats: Counter = Counter()
    rows: list[tuple] = []
    unmatched: list[str] = []
    matched_to: dict[str, str] = {}
    examined: set[str] = set()
    for eid, e in sorted(feed_bouts().items(), key=lambda kv: int(kv[1]["time"])):
        stats["feed UFC bouts"] += 1
        examined.add(eid)
        if str(e.get("time_status")) not in HAPPENED:
            stats["skipped: not ended (status != 3)"] += 1
            continue
        s, h = load(SUMMARY / f"{eid}.json.gz"), load(HISTORY / f"{eid}.json.gz")
        if s is None:
            stats["skipped: summary not downloaded yet"] += 1
            continue
        bell = int(e["time"])
        raw = history_quotes(h) + summary_quotes(s)
        qs = pre_bell(raw, bell)
        stats["quotes dropped as post-bell"] += len(raw) - len(qs)
        if not raw:
            stats["skipped: no price at all"] += 1
            continue
        if not qs:
            stats["skipped: only in-play prices"] += 1
            continue
        home, away = e["home"]["name"], e["away"]["name"]
        when = datetime.fromtimestamp(bell, timezone.utc)
        m = match_bout(home, away, when, ours)
        if m is None and NOT_ON_UFCSTATS.search(e["league"]["name"]):
            stats["skipped: Contender Series / Road to UFC"] += 1
            continue
        if m is None:
            stats["UNMATCHED (priced, on a UFCStats card)"] += 1
            unmatched.append(f"{when:%Y-%m-%d} {e['league']['name'][:40]:40} "
                             f"{home} v {away}")
            continue
        if m.bout_id in matched_to:
            # two feed bouts on one of ours: the feed lists some bouts twice
            # (a re-created event); keep the first, count the rest
            stats["duplicate feed bout for one of ours"] += 1
            continue
        matched_to[m.bout_id] = eid
        stats["matched"] += 1
        stats["matched, corners swapped"] += m.swapped
        for q in qs:
            a, b = bout_prices(q, m.swapped)
            rows.append((m.bout_id, SOURCE, q.book, q.market, q.line, a, b,
                         q.over, q.under, q.quoted_at, q.snapshot, eid))

    for k, v in stats.items():
        print(f"  {k:48} {v:,}")
    by = Counter((r[2], r[3]) for r in rows)
    print(f"  quotes to write: {len(rows):,}")
    for (book, market), n in by.most_common(12):
        print(f"    {book:12} {market:13} {n:,}")
    if "--unmatched" in sys.argv:
        print("\n".join(unmatched))

    if dry:
        print("dry run — nothing written")
        return
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM bout_odds_quote WHERE source = %s", (SOURCE,))
        before = cur.fetchone()[0]
        cur.executemany(INSERT_SQL, rows)
        # Rows an earlier run wrote from a feed bout this run looked at and
        # did not choose — the rules got stricter (the status-2 placeholders of
        # 2026-09-23). Only bouts this run EXAMINED are touched, so a run over a
        # partial or missing cache can never empty the table.
        rejected = sorted(examined - set(matched_to.values()))
        cur.execute("DELETE FROM bout_odds_quote WHERE source = %s "
                    "AND external_id = ANY(%s)", (SOURCE, rejected))
        removed = cur.rowcount
        cur.execute("SELECT count(*) FROM bout_odds_quote WHERE source = %s", (SOURCE,))
        after = cur.fetchone()[0]
    conn.commit()
    print(f"bout_odds_quote ({SOURCE}): {before:,} -> {after:,} rows "
          f"({removed:,} removed from feed bouts no longer chosen)")


if __name__ == "__main__":
    main()
