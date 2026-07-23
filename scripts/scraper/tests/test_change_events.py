"""Pin the two properties bout_change_event lives or dies by.

SURVIVAL. The removal log exists to outlive the `DELETE FROM bout` it
documents. A foreign key with ON DELETE CASCADE — the default reflex when
adding a bout_id column — would erase each row at the exact moment it became
the only evidence the fight was ever booked. Checked by simulating a removal
end to end: log it, delete the bout, read the row back.

IDEMPOTENCY. The bouts scrape re-reads every upcoming card every 6 hours and
the news classifier runs hourly. If the writers logged observations rather
than changes, an unrepaired opponent swap would produce four rows a day
forever and the table would be noise. Checked on both dedupe scopes.

Everything runs inside a transaction that is rolled back.

Run:
    scripts/scraper/venv/bin/python scripts/scraper/tests/test_change_events.py
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

_SCRAPER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_SCRAPER_ROOT))

from src.db import get_connection  # noqa: E402
from src.loaders.change_events import (  # noqa: E402
    KIND_BOUT_REMOVED,
    KIND_NEWS_SIGNAL,
    KIND_OPPONENT_SWAPPED,
    SOURCE_UFCSTATS,
    record_change,
)
from src.loaders.events import _record_removed_bouts  # noqa: E402
from src.loaders.news import record_news_signal  # noqa: E402

_ANCHOR = datetime(2020, 1, 1, tzinfo=timezone.utc)


def _pick_scheduled_bout(cur) -> tuple[str, str, str]:
    """(bout_id, event_id, ufc_stats_id) for a scheduled, official bout."""
    cur.execute(
        """
        SELECT id::text, event_id::text, ufc_stats_id FROM bout
        WHERE status = 'scheduled' AND ufc_stats_id IS NOT NULL
        LIMIT 1
        """
    )
    row = cur.fetchone()
    assert row is not None, "no scheduled bout to test against"
    return row


def check_removal_row_survives_bout_delete(conn) -> None:
    """Simulate a fight coming off a card: log the removal exactly as the
    loader does, then delete the bout, then look for the row."""
    with conn.cursor() as cur:
        bout_id, event_id, ufc_id = _pick_scheduled_bout(cur)

        # Feed the loader's own removal-logging helper a `seen_ids` list this
        # bout is missing from — precisely what the scrape sees when a fight
        # has been pulled from the event page.
        written = _record_removed_bouts(cur, event_id, ["not-this-bout"])
        assert written >= 1, "removal helper logged nothing for a missing bout"

        cur.execute(
            "SELECT count(*) FROM bout_change_event "
            "WHERE bout_id = %s::uuid AND kind = %s",
            (bout_id, KIND_BOUT_REMOVED),
        )
        assert cur.fetchone()[0] == 1, "removal not logged for the picked bout"

        # Now do what the loader does next.
        cur.execute(
            "UPDATE news_item SET related_bout_id = NULL WHERE related_bout_id = %s::uuid",
            (bout_id,),
        )
        cur.execute("DELETE FROM bout WHERE id = %s::uuid", (bout_id,))
        cur.execute("SELECT count(*) FROM bout WHERE id = %s::uuid", (bout_id,))
        assert cur.fetchone()[0] == 0, "the bout wasn't actually deleted"

        cur.execute(
            """
            SELECT payload->>'ufc_stats_id', payload->>'fighter_a_name'
            FROM bout_change_event
            WHERE bout_id = %s::uuid AND kind = %s
            """,
            (bout_id, KIND_BOUT_REMOVED),
        )
        surviving = cur.fetchall()
    assert len(surviving) == 1, (
        "the removal row did NOT survive DELETE FROM bout — something put a "
        "cascading foreign key on bout_change_event.bout_id, which erases the "
        "log at the moment it matters"
    )
    assert surviving[0][0] == ufc_id, "payload lost the bout's ufc_stats_id"
    assert surviving[0][1], "payload lost the fighter names — nothing to join to"


def check_latest_scope_dedupes_a_persistent_change(conn) -> None:
    """The opponent-swap case: the bout row is deliberately NOT repaired, so
    every subsequent scrape re-observes the same difference. It must be logged
    once — and a swap to a THIRD opponent must still get through."""
    with conn.cursor() as cur:
        bout_id, event_id, _ = _pick_scheduled_bout(cur)
        common = dict(
            bout_id=bout_id,
            event_id=event_id,
            kind=KIND_OPPONENT_SWAPPED,
            source=SOURCE_UFCSTATS,
            payload={"test": True},
        )
        assert record_change(cur, signature="A|B->A|C", **common), "first write"
        assert not record_change(cur, signature="A|B->A|C", **common), (
            "re-observing the SAME unrepaired swap wrote a second row — the "
            "6-hourly scrape would fill the table with duplicates"
        )
        assert record_change(cur, signature="A|B->A|D", **common), (
            "a swap to a different opponent was suppressed — this is a new "
            "change, not a re-observation"
        )
        cur.execute(
            "SELECT count(*) FROM bout_change_event WHERE bout_id = %s::uuid AND kind = %s",
            (bout_id, KIND_OPPONENT_SWAPPED),
        )
        assert cur.fetchone()[0] == 2, "expected exactly two swap rows"


def check_any_scope_dedupes_a_reprocessed_news_item(conn) -> None:
    """A news item reports a given thing once, however often it is
    reprocessed — even with another article's signal recorded in between,
    which is what defeats a most-recent-row check."""
    with conn.cursor() as cur:
        bout_id, _, _ = _pick_scheduled_bout(cur)
        cur.execute("SELECT id::text FROM news_item LIMIT 2")
        items = [r[0] for r in cur.fetchall()]
    assert len(items) == 2, "need two news items to test interleaving"

    first = dict(
        bout_id=bout_id,
        news_item_id=items[0],
        classification="bout_cancelled",
        confidence=0.9,
        published_at=_ANCHOR,
        source_is_trusted=True,
        acted=False,
    )
    assert record_news_signal(conn, **first), "first signal not written"
    assert record_news_signal(conn, **{**first, "news_item_id": items[1]}), (
        "a second, different article's signal was suppressed"
    )
    assert not record_news_signal(conn, **first), (
        "reprocessing the SAME news item wrote a duplicate — the 'any' dedupe "
        "scope is not in effect"
    )

    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM bout_change_event WHERE bout_id = %s::uuid AND kind = %s",
            (bout_id, KIND_NEWS_SIGNAL),
        )
        assert cur.fetchone()[0] == 2, "expected exactly two news-signal rows"


def main() -> int:
    failures: list[str] = []
    with get_connection() as conn:
        try:
            for check in (
                check_removal_row_survives_bout_delete,
                check_latest_scope_dedupes_a_persistent_change,
                check_any_scope_dedupes_a_reprocessed_news_item,
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
    print("\nall bout_change_event checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
