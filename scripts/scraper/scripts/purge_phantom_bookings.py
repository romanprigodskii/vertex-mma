"""Remove news-invented bookings that the current guards would refuse.

A provisional row (`ufc_stats_id IS NULL`) is a bet: the news announced a
fight before UFCStats listed it, and the scrape will adopt the row within
hours. When the bet is wrong the row does not decay — it sits on a live card
as a fight that does not exist. Three did, until 2026-08-12:

  * "Brian Ortega vs. Roan Carneiro" on the UFC 330 card — a surname collision
    (Renato Moicano's legal surname is Carneiro) landed on the wrong card
    (similarity('UFC 330','UFC 331') = 0.60);
  * "Darren Till vs. Yoel Romero" — a BKFC bare-knuckle boxing match;
  * "Zabit Magomedsharipov vs. Youssef Zalal" — a grappling match.

`loaders.news` now refuses all three at the source. This script clears what
the unguarded runs already wrote, and stays useful afterwards as the sweep for
provisional rows that never got adopted.

Deleted, not cancelled, on purpose. `cancelled` is a claim about the world —
that a real booking fell through — and `bout_change_event` accrual reads
cancellations as withdrawal signals. Marking a fight that was never booked as
"cancelled" would quietly poison that dataset with fake withdrawals.

Only ever touches rows with `ufc_stats_id IS NULL`. Anything UFCStats has
confirmed is left alone, whatever it looks like. Refuses to delete a bout
carrying user stakes (bets, parlay legs, markets, prediction picks) or an
accrued change-event history; those are reported for a human instead.

Run:
    scripts/scraper/venv/bin/python scripts/scraper/scripts/purge_phantom_bookings.py [--apply]

Without --apply it prints what it would do and changes nothing.
"""
from __future__ import annotations

import argparse

import _path  # noqa: F401

from src.db import get_connection
from src.loaders.news import is_foreign_promotion, stale_bookee
from src.utils.logger import log


def _phantom_bouts(conn) -> list[dict]:
    """Provisional, still-scheduled bouts on upcoming cards, with their stakes."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT b.id::text AS bout_id, e.id::text AS event_id,
                   e.name AS event_name, e.date::date AS event_date,
                   b.fighter_a_id::text AS fighter_a_id,
                   b.fighter_b_id::text AS fighter_b_id,
                   fa.name_en AS fighter_a, fb.name_en AS fighter_b,
                   e.ufc_stats_id IS NULL AS event_provisional,
                   (SELECT count(*) FROM fixed_odds_bet x WHERE x.bout_id = b.id)
                 + (SELECT count(*) FROM parlay_leg x WHERE x.bout_id = b.id)
                 + (SELECT count(*) FROM market x WHERE x.bout_id = b.id)
                 + (SELECT count(*) FROM prediction_pick x WHERE x.bout_id = b.id)
                   AS stakes,
                   (SELECT count(*) FROM bout_change_event x WHERE x.bout_id = b.id)
                   AS changes
            FROM bout b
            JOIN event e ON e.id = b.event_id
            LEFT JOIN fighter fa ON fa.id = b.fighter_a_id
            LEFT JOIN fighter fb ON fb.id = b.fighter_b_id
            WHERE b.ufc_stats_id IS NULL
              AND b.status = 'scheduled'
              AND e.date >= now()
            ORDER BY e.date, e.name
            """
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def _empty_provisional_events(conn) -> list[dict]:
    """Provisional events holding no bouts at all — nothing to adopt, nothing to show."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT e.id::text, e.name, e.date::date
            FROM event e
            WHERE e.ufc_stats_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM bout b WHERE b.event_id = e.id)
              AND NOT EXISTS (
                    SELECT 1 FROM prediction_event p WHERE p.event_id = e.id
                  )
            ORDER BY e.date
            """
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def _stale_provisional_events(conn) -> list[dict]:
    """Provisional cards whose date has passed but that still read as 'upcoming'.

    `cancel_past_scheduled_bouts` retires their bouts; nothing was retiring the
    card itself, so news-invented events sat in the upcoming state forever.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT e.id::text, e.name, e.date::date,
                   (SELECT count(*) FROM bout b WHERE b.event_id = e.id) AS bouts
            FROM event e
            WHERE e.ufc_stats_id IS NULL
              AND e.status = 'upcoming'
              AND e.date < now() - interval '2 days'
            ORDER BY e.date
            """
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def _delete_bout(conn, bout_id: str) -> None:
    """Simulations cascade; the news link is NO ACTION so it is cleared first."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE news_item SET related_bout_id = NULL WHERE related_bout_id = %s::uuid",
            (bout_id,),
        )
        cur.execute("DELETE FROM bout WHERE id = %s::uuid", (bout_id,))


def run(*, apply: bool = False) -> dict[str, int]:
    totals = {
        "bouts_examined": 0,
        "bouts_deleted": 0,
        "bouts_kept_with_stakes": 0,
        "events_deleted": 0,
        "events_marked_cancelled": 0,
    }

    with get_connection() as conn:
        for bout in _phantom_bouts(conn):
            totals["bouts_examined"] += 1
            label = f"{bout['fighter_a']} vs {bout['fighter_b']}"

            # Exactly the two conditions loaders.news now refuses at the
            # source. A provisional bout that fails neither is the feature
            # working as designed — a real fight announced before UFCStats
            # listed it — and is left alone.
            reasons: list[str] = []
            if is_foreign_promotion(bout["event_name"]):
                reasons.append(f"{bout['event_name']!r} is not a UFC card")
            for fid in (bout["fighter_a_id"], bout["fighter_b_id"]):
                stale = stale_bookee(conn, fid)
                if stale:
                    reasons.append(
                        f"{stale} is off the roster with no bout in years"
                    )
            if not reasons:
                continue

            if bout["stakes"] or bout["changes"]:
                totals["bouts_kept_with_stakes"] += 1
                log.warning(
                    f"  KEPT — {label} @ {bout['event_name']}: "
                    f"{'; '.join(reasons)}, but it carries "
                    f"{bout['stakes']} user stake(s) and {bout['changes']} "
                    "change event(s); resolve by hand"
                )
                continue

            log.info(
                f"  purge bout {label} @ {bout['event_name']} "
                f"({bout['event_date']}) — {'; '.join(reasons)}"
            )
            if apply:
                _delete_bout(conn, bout["bout_id"])
            totals["bouts_deleted"] += 1

        if apply:
            conn.commit()

        # Run after the bout sweep: deleting a card's only bout is what leaves
        # the card empty.
        for event in _empty_provisional_events(conn):
            log.info(
                f"  purge empty provisional event {event['name']!r} @ {event['date']}"
            )
            if apply:
                with conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM event WHERE id = %s::uuid", (event["id"],)
                    )
            totals["events_deleted"] += 1

        for event in _stale_provisional_events(conn):
            log.info(
                f"  cancel past provisional event {event['name']!r} @ "
                f"{event['date']} ({event['bouts']} bout(s))"
            )
            if apply:
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE event SET status = 'cancelled', updated_at = now() "
                        "WHERE id = %s::uuid",
                        (event["id"],),
                    )
            totals["events_marked_cancelled"] += 1

        if apply:
            conn.commit()

    verb = "purged" if apply else "would purge (dry run)"
    log.info(
        f"phantom bookings {verb}: bouts={totals['bouts_deleted']} "
        f"kept_with_stakes={totals['bouts_kept_with_stakes']} "
        f"empty_events={totals['events_deleted']} "
        f"past_events_cancelled={totals['events_marked_cancelled']}"
    )
    return totals


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="actually delete; without it the script only reports",
    )
    args = parser.parse_args()
    run(apply=args.apply)
