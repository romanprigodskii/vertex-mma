"""Pin the `first_seen_at` contract on `bout` and `event`.

`first_seen_at` records when a booking was FIRST observed. Its whole value
comes from never moving: the bouts scrape re-reads every upcoming card every
6 hours, so a single `first_seen_at = EXCLUDED.first_seen_at` in an ON CONFLICT
clause would drag every row forward to today and reproduce, exactly, the defect
that makes `bout.created_at` useless (8 736 bouts stamped 2026-05-12, most of
them after their own event).

Four things are checked:

  1. neither upsert assigns the column on conflict (static scan of the SET
     clause — fails the moment someone types the name in the wrong place);
  2. a repeat upsert leaves a stored `first_seen_at` untouched while
     `updated_at` moves, so the row really did go through the conflict path;
  3. adoption of a news-created provisional bout (the UPDATE that stamps
     `ufc_stats_id` on an existing row) doesn't touch it either — a bout the
     news announced keeps the announcement date through the transition to
     official data;
  4. the column has no database default, so historical rows stay NULL rather
     than being backfilled with a flattering lie.

Everything runs inside a transaction that is rolled back.

Run:
    scripts/scraper/venv/bin/python scripts/scraper/tests/test_first_seen_at.py
"""
from __future__ import annotations

import inspect
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

_SCRAPER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_SCRAPER_ROOT))

from src.db import get_connection  # noqa: E402
from src.loaders import events as events_loader  # noqa: E402
from src.loaders import news as news_loader  # noqa: E402
from src.parsers.event_details import BoutRow  # noqa: E402

_ANCHOR = datetime(2020, 1, 1, tzinfo=timezone.utc)


def _bout_row(ufc_id: str, fa_ufc: str, fb_ufc: str, weight_class: str) -> BoutRow:
    """A minimal scheduled BoutRow as the event-details parser would emit it."""
    return BoutRow(
        ufc_stats_id=ufc_id,
        bout_order=1,
        fighter_a_ufc_id=fa_ufc,
        fighter_a_name="A",
        fighter_b_ufc_id=fb_ufc,
        fighter_b_name="B",
        winner_side=None,
        weight_class=weight_class,
        method=None,
        method_detail=None,
        is_title_bout=False,
        round_finished=None,
        time_finished_seconds=None,
        status="scheduled",
    )


def _sql_literals(source: str) -> list[str]:
    return re.findall(r'"""(.*?)"""', source, re.S)


#: Anchored on the full `ON CONFLICT (...) DO UPDATE SET` so a prose mention of
#: "DO UPDATE SET" — the invariant notes have to name what they forbid — can't
#: be mistaken for the clause itself.
_ON_CONFLICT = re.compile(r"ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET", re.I)


def _set_clauses(source: str) -> list[str]:
    """Every real DO UPDATE SET body in a function's SQL literals."""
    clauses = []
    for literal in _sql_literals(source):
        for match in _ON_CONFLICT.finditer(literal):
            clauses.append(literal[match.end() :])
    return clauses


def check_bout_upsert_omits_first_seen_at() -> None:
    clauses = _set_clauses(inspect.getsource(events_loader.upsert_bouts))
    assert clauses, "no DO UPDATE SET found in upsert_bouts — extraction stale"
    for clause in clauses:
        assert "first_seen_at" not in clause, (
            "upsert_bouts assigns first_seen_at on conflict — every upcoming "
            "bout would be restamped every 6 hours. See the invariant note "
            "above the ON CONFLICT clause."
        )


def check_event_upsert_omits_first_seen_at() -> None:
    clauses = _set_clauses(inspect.getsource(events_loader.upsert_event_listing))
    assert clauses, "no DO UPDATE SET in upsert_event_listing — extraction stale"
    for clause in clauses:
        assert "first_seen_at" not in clause, (
            "upsert_event_listing assigns first_seen_at on conflict — every "
            "upcoming card would be restamped on every scrape."
        )


def check_no_database_default(conn) -> None:
    """A DEFAULT on a nullable column is not a convenience here — since
    Postgres 11, ADD COLUMN materialises it for existing rows, which is the
    backfill this column exists to avoid."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT table_name, column_default, is_nullable
            FROM information_schema.columns
            WHERE column_name = 'first_seen_at'
              AND table_name IN ('bout', 'event')
            ORDER BY table_name
            """
        )
        rows = cur.fetchall()
    assert len(rows) == 2, f"expected bout+event first_seen_at, got {rows}"
    for table, default, nullable in rows:
        assert default is None, (
            f"{table}.first_seen_at has DEFAULT {default!r} — a default would "
            f"backfill every existing row on ADD COLUMN"
        )
        assert nullable == "YES", (
            f"{table}.first_seen_at is NOT NULL — historical rows have no "
            f"honest value and must stay NULL"
        )


def _pick_scheduled_bout(cur) -> tuple[str, str, str, str, str, str]:
    """A scheduled bout with a real ufc_stats_id, plus its event's ufc id."""
    cur.execute(
        """
        SELECT b.id::text, b.ufc_stats_id, e.ufc_stats_id,
               fa.ufc_stats_id, fb.ufc_stats_id, b.weight_class::text
        FROM bout b
        JOIN event e ON e.id = b.event_id
        JOIN fighter fa ON fa.id = b.fighter_a_id
        JOIN fighter fb ON fb.id = b.fighter_b_id
        WHERE b.ufc_stats_id IS NOT NULL AND e.ufc_stats_id IS NOT NULL
          AND fa.ufc_stats_id IS NOT NULL AND fb.ufc_stats_id IS NOT NULL
          AND b.status = 'scheduled'
        LIMIT 1
        """
    )
    row = cur.fetchone()
    assert row is not None, "no scheduled bout with full ids to test against"
    return row


def check_reupsert_preserves_first_seen_at(conn) -> None:
    """Feed the real loader a bout it already has and watch what moves."""
    with conn.cursor() as cur:
        bout_id, bout_ufc, event_ufc, fa_ufc, fb_ufc, weight_class = (
            _pick_scheduled_bout(cur)
        )
        cur.execute(
            "UPDATE bout SET first_seen_at = %s, updated_at = %s WHERE id = %s::uuid",
            (_ANCHOR, _ANCHOR, bout_id),
        )

    events_loader.upsert_bouts(
        conn,
        event_ufc_id=event_ufc,
        bouts=[_bout_row(bout_ufc, fa_ufc, fb_ufc, weight_class)],
    )

    with conn.cursor() as cur:
        cur.execute(
            "SELECT first_seen_at, updated_at FROM bout WHERE id = %s::uuid",
            (bout_id,),
        )
        first_seen_at, updated_at = cur.fetchone()
    assert first_seen_at == _ANCHOR, (
        f"re-upsert MOVED bout.first_seen_at {_ANCHOR} -> {first_seen_at}"
    )
    assert updated_at > _ANCHOR, (
        "re-upsert did not move updated_at — the row didn't go through the "
        "conflict path, so this test proved nothing"
    )


def check_adoption_preserves_first_seen_at(conn) -> None:
    """A news-created provisional bout keeps its announcement date when the
    UFCStats scrape claims it. Adoption is an UPDATE that sets ufc_stats_id
    only — this pins that it stays that way."""
    with conn.cursor() as cur:
        _, _, event_ufc, _, _, weight_class = _pick_scheduled_bout(cur)
        cur.execute(
            "SELECT id::text FROM event WHERE ufc_stats_id = %s", (event_ufc,)
        )
        event_id = cur.fetchone()[0]

        # Two fighters with no bout on this card, so auto_create_bout really
        # inserts (its idempotency guard is the pair-at-event lookup) and the
        # adoption UPDATE has exactly one candidate.
        #
        # Active roster only: auto_create_bout refuses to book a fighter who is
        # off the roster and years past their last bout (that pattern is what a
        # bad name match looks like — see test_phantom_bout_guards). An
        # arbitrary pair used to draw someone retired since 2013 and this check
        # failed for a reason that has nothing to do with first_seen_at.
        cur.execute(
            """
            SELECT f.id::text, f.ufc_stats_id
            FROM fighter f
            WHERE f.ufc_stats_id IS NOT NULL
              AND f.roster_status = 'active'
              AND f.id NOT IN (
                SELECT fighter_a_id FROM bout WHERE event_id = %s::uuid
                UNION
                SELECT fighter_b_id FROM bout WHERE event_id = %s::uuid
              )
            LIMIT 2
            """,
            (event_id, event_id),
        )
        pair = cur.fetchall()
        assert len(pair) == 2, "no unbooked fighter pair to test adoption with"
        (fa_id, fa_ufc), (fb_id, fb_ufc) = pair
        # An id UFCStats has never issued: adoption must claim the provisional
        # row rather than insert a second one under this id.
        bout_ufc = "test-adopt-0000000000000000"

    provisional_id, created = news_loader.auto_create_bout(
        conn,
        fighter_a_id=fa_id,
        fighter_b_id=fb_id,
        event_id=event_id,
        weight_class=weight_class,
        first_seen_at=_ANCHOR,
    )
    assert created, "provisional bout not created — pair already linked?"

    with conn.cursor() as cur:
        cur.execute(
            "SELECT first_seen_at FROM bout WHERE id = %s::uuid", (provisional_id,)
        )
        assert cur.fetchone()[0] == _ANCHOR, (
            "auto_create_bout ignored the published_at it was handed"
        )

    events_loader.upsert_bouts(
        conn,
        event_ufc_id=event_ufc,
        bouts=[_bout_row(bout_ufc, fa_ufc, fb_ufc, weight_class)],
    )

    with conn.cursor() as cur:
        cur.execute(
            "SELECT ufc_stats_id, first_seen_at FROM bout WHERE id = %s::uuid",
            (provisional_id,),
        )
        adopted_ufc, first_seen_at = cur.fetchone()
    assert adopted_ufc == bout_ufc, (
        f"provisional bout was not adopted (ufc_stats_id={adopted_ufc!r}) — "
        f"the test didn't exercise the path it claims to"
    )
    assert first_seen_at == _ANCHOR, (
        f"adoption MOVED first_seen_at {_ANCHOR} -> {first_seen_at}; a bout the "
        f"news announced lost its announcement date on going official"
    )


def main() -> int:
    failures: list[str] = []

    for check in (
        check_bout_upsert_omits_first_seen_at,
        check_event_upsert_omits_first_seen_at,
    ):
        try:
            check()
        except AssertionError as exc:
            failures.append(f"{check.__name__}: {exc}")
        else:
            print(f"  ok  {check.__name__}")

    with get_connection() as conn:
        try:
            for check in (
                check_no_database_default,
                check_reupsert_preserves_first_seen_at,
                check_adoption_preserves_first_seen_at,
            ):
                try:
                    check(conn)
                except AssertionError as exc:
                    failures.append(f"{check.__name__}: {exc}")
                else:
                    print(f"  ok  {check.__name__}")
                conn.rollback()
        finally:
            conn.rollback()

    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nall first_seen_at checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
