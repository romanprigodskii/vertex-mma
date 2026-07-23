"""Append-only accrual of what happens to a booking after it is announced.

Every write to `bout_change_event` goes through `record_change`. The table and
the reasoning behind it are documented in
`drizzle/migrations/0092_bout_change_event.sql` and
`scripts/scraper/docs/change_accrual.md`; the short version is that removals,
opponent swaps, cancellations and date moves are not reconstructable after the
fact — the UFCStats page only ever shows the card as it stands today — so they
have to be recorded as they happen or not at all.

Two rules the callers depend on:

  * LOG CHANGES, NOT OBSERVATIONS. The bouts scrape re-reads every upcoming
    card every 6 hours. `record_change` writes a row only when the change's
    `signature` differs from the most recent row for the same (bout, kind), so
    a condition that persists — an opponent swap we deliberately don't repair
    in the `bout` row — is recorded once rather than four times a day forever.
  * NEVER INVENT A TIMESTAMP. `observed_at` is either something the source
    actually told us (a news item's published_at) or the moment we looked
    (an upper bound for the scrape). There is no third option; a bout whose
    booking date we don't know keeps NULL.
"""
from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any

import psycopg

# --- kinds -----------------------------------------------------------------
# Free text in the DB on purpose (adding an observation shouldn't need a
# migration), but every writer in the tree uses one of these.

#: A scheduled bout with a real UFCStats id vanished from its event page.
#: The strongest withdrawal/scratch signal we have — and the one the scrape
#: used to destroy, because the row is hard-DELETEd right after.
KIND_BOUT_REMOVED = "bout_removed_from_card"
#: The same fight-details id now lists a different pair of fighters.
KIND_OPPONENT_SWAPPED = "opponent_swapped"
#: A bout moved to status 'cancelled' (past-event sweep, or a news withdrawal
#: report retiring a provisional booking).
KIND_STATUS_CANCELLED = "status_cancelled"
#: The card the bout sits on moved to a different date.
KIND_DATE_MOVED = "date_moved"
#: The bout is now contracted at a different weight.
KIND_WEIGHT_CLASS_CHANGED = "weight_class_changed"
#: A provisional (news-created) twin was folded into the official row.
KIND_PROVISIONAL_MERGED = "provisional_merged"
#: A news item classified as a withdrawal, a booking change or weigh-in
#: coverage, attributed to a bout. Recorded whether or not it caused a
#: database change — most don't, because the loaders only ever mutate
#: provisional rows, and "an outlet reported a withdrawal" is the observation
#: worth keeping either way.
KIND_NEWS_SIGNAL = "news_signal"

#: The classifications that produce a KIND_NEWS_SIGNAL row. These three are the
#: booking-circumstance categories the classifier already emits; they were
#: being used for display and (for provisional rows) a status flip, and then
#: discarded.
NEWS_SIGNAL_CLASSIFICATIONS = frozenset(
    {"bout_cancelled", "bout_changed", "weigh_in"}
)

SOURCE_UFCSTATS = "ufcstats"
SOURCE_NEWS = "news"


def _jsonable(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def record_change(
    cur: psycopg.Cursor,
    *,
    bout_id: str,
    kind: str,
    source: str,
    signature: str,
    payload: dict[str, Any],
    event_id: str | None = None,
    observed_at: datetime | None = None,
    dedupe_scope: str = "latest",
) -> bool:
    """Append one row unless the most recent row for this (bout, kind) already
    carries the same `signature`. Returns True when a row was written.

    `signature` must fingerprint the CHANGE, not the observation — it is what
    makes the 6-hourly re-scrape idempotent. Two examples:

      * opponent swap → the old pair and the new pair, each order-normalised,
        so re-reading the same unrepaired swap is silent but a swap to a third
        opponent is not;
      * removal from a card → the bout's ufc_stats_id, so a fight that is
        pulled, re-added and pulled again is recorded twice (it happened
        twice) while a single removal is recorded once.

    Ordering is by `id` (insertion order), NOT by `observed_at`: news rows are
    backdated to their article's published_at and would otherwise sort behind
    a scrape row written later.

    `dedupe_scope` picks which rows the signature is compared against:

      * 'latest' (default) — only the most recent row for this (bout, kind).
        Right for a CONDITION that can recur: a bout pulled, re-added and
        pulled again really did happen twice, and a weight class that moves
        back and forth is two changes, not one.
      * 'any' — every row for this (bout, kind). Right when the signature
        names a one-off FACT rather than a state, e.g. a specific news item:
        a given article reports a given thing exactly once, however many times
        it is reprocessed, and however many other articles landed in between.

    `observed_at=None` means "now" — correct only for a source with no clock
    of its own. Pass the source's timestamp whenever there is one.
    """
    if dedupe_scope == "any":
        cur.execute(
            """
            SELECT 1 FROM bout_change_event
            WHERE bout_id = %s::uuid AND kind = %s AND signature = %s
            LIMIT 1
            """,
            (bout_id, kind, signature),
        )
        if cur.fetchone() is not None:
            return False
    elif dedupe_scope == "latest":
        cur.execute(
            """
            SELECT signature FROM bout_change_event
            WHERE bout_id = %s::uuid AND kind = %s
            ORDER BY id DESC LIMIT 1
            """,
            (bout_id, kind),
        )
        row = cur.fetchone()
        if row is not None and row[0] == signature:
            return False
    else:
        raise ValueError(f"unknown dedupe_scope {dedupe_scope!r}")

    cur.execute(
        """
        INSERT INTO bout_change_event (
            bout_id, event_id, observed_at, source, kind, signature, payload
        )
        VALUES (%s::uuid, %s::uuid, COALESCE(%s, now()), %s, %s, %s, %s::jsonb)
        """,
        (
            bout_id,
            event_id,
            observed_at,
            source,
            kind,
            signature,
            json.dumps({k: _jsonable(v) for k, v in payload.items()}),
        ),
    )
    return True


def pair_signature(fighter_a_id: str, fighter_b_id: str) -> str:
    """Order-normalised fingerprint of a matchup. A vs B and B vs A are the
    same fight — UFCStats swapping the two rows on a page is a rendering
    detail, not a booking change, and must not read as an opponent swap."""
    return "|".join(sorted([fighter_a_id, fighter_b_id]))
