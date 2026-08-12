"""Pin the three guards that stop the news pipeline inventing bouts.

Three fabricated matchups reached the live site before these existed, each
from a different failure:

  1. "Brian Ortega vs. Roan Carneiro" on the UFC 330 card. A Sherdog report on
     UFC 331 used Renato Moicano's legal surname ("Renato Carneiro"). pg_trgm
     scored that 0.50 against Roan Carneiro — a welterweight whose last bout
     was in 2017 — and 0.50 clears the 0.45 bar on the shared surname alone.
     The card was wrong for a second, independent reason: similarity('UFC 330',
     'UFC 331') is 0.60, while the real "UFC 331: Van vs. Pantoja 2" scores
     0.33 against the hint "UFC 331" and never clears the threshold at all. So
     the hint resolved, confidently, to the wrong card.
  2. "Darren Till vs. Yoel Romero" — a BKFC bare-knuckle boxing match, filed as
     a provisional UFC event named "BKFC event in Manchester".
  3. "Zabit Magomedsharipov vs. Youssef Zalal" — a grappling match, filed as
     the UFC card "ACBJJ 22".

Checked here:

  1. a surname collision with a different given name is rejected, while the
     spelling variants we must keep matching (initials, prefixes, an inserted
     middle name, accents) still resolve;
  2. a numbered card hint resolves by its number or not at all — never to a
     neighbouring number — and an unnumbered hint never lands on a numbered
     card;
  3. an event hint naming another promotion creates nothing;
  4. a fighter years past their last bout and off the roster is never
     auto-booked.

DB-backed checks run inside a transaction that is rolled back.

Run:
    scripts/scraper/venv/bin/python scripts/scraper/tests/test_phantom_bout_guards.py
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

_SCRAPER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_SCRAPER_ROOT))

from src.db import get_connection  # noqa: E402
from src.loaders.news import (  # noqa: E402
    auto_create_bout,
    is_foreign_promotion,
    names_can_be_same_fighter,
    resolve_event_id,
    resolve_fighter_ids,
    resolve_or_create_event,
)


def check_surname_collision_rejected() -> None:
    """The exact pairing that produced the phantom, plus the variants we keep."""
    # The defect: same surname, unrelated given name.
    assert not names_can_be_same_fighter("Roan Carneiro", "Renato Carneiro")
    assert not names_can_be_same_fighter("Renato Moicano", "Renato Carneiro")
    assert not names_can_be_same_fighter("Bruno Silva", "Joaquim Silva")

    # Variants that must still resolve, or the guard costs more than it saves.
    assert names_can_be_same_fighter("Ian Machado Garry", "Ian Garry")
    assert names_can_be_same_fighter("Dooho Choi", "Doo Ho Choi")
    assert names_can_be_same_fighter("Alexander Volkanovski", "Alex Volkanovski")
    assert names_can_be_same_fighter("Joshua Van", "J. Van")
    assert names_can_be_same_fighter("Jose Aldo", "José Aldo")
    assert names_can_be_same_fighter("Khabib Nurmagomedov", "khabib nurmagomedov")
    # Single-name fighters have no given/surname split to compare.
    assert names_can_be_same_fighter("Aoriqileng", "Aoriqileng")


def check_foreign_promotions_flagged() -> None:
    assert is_foreign_promotion("BKFC event in Manchester")
    assert is_foreign_promotion("ACBJJ 22")
    assert is_foreign_promotion("PFL San Diego")
    assert is_foreign_promotion("RAF 10")
    assert is_foreign_promotion("ONE Fight Night 47")
    assert is_foreign_promotion("Bellator 300")

    # UFC cards — including the UFC-owned developmental series — must pass.
    assert not is_foreign_promotion("UFC 331")
    assert not is_foreign_promotion("UFC Fight Night: Hooker vs. Parnasse")
    assert not is_foreign_promotion("Noche UFC")
    assert not is_foreign_promotion("DWCS 10.3")
    assert not is_foreign_promotion("UFC Paris")


def _make_event(conn, name: str, short_name: str, days_out: int) -> str:
    when = datetime.now(timezone.utc) + timedelta(days=days_out)
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO event (slug, name, short_name, promotion, date, status)
            VALUES (%s, %s, %s, 'ufc', %s, 'upcoming'::event_status)
            RETURNING id::text
            """,
            (f"test-{uuid.uuid4().hex[:12]}", name, short_name, when),
        )
        return cur.fetchone()[0]


def check_numbered_card_resolves_by_number(conn) -> None:
    """A number is an identifier, not a string to be scored for similarity."""
    # Numbers far outside the real schedule, so the assertions are about the
    # resolver and not about whichever cards production happens to hold.
    e990 = _make_event(conn, "UFC 990: Makhachev vs. Machado Garry", "UFC 990", 3)
    # Note the short_name: the real rows carry the full headline, which is
    # exactly why the fuzzy path scored the right card below threshold.
    e991 = _make_event(
        conn, "UFC 991: Van vs. Pantoja 2", "UFC 991: Van vs. Pantoja 2", 38
    )

    assert resolve_event_id(conn, "UFC 991") == e991, "hint must find its own card"
    assert resolve_event_id(conn, "UFC 990") == e990
    # The defect: 'UFC 992' used to land on UFC 990/991 at similarity 0.60.
    assert resolve_event_id(conn, "UFC 992") is None, (
        "an untracked numbered card must resolve to nothing, so the caller "
        "creates it instead of attaching bouts to a neighbouring number"
    )
    # An unnumbered hint must not fall into a numbered card either.
    assert resolve_event_id(conn, "UFC Fight Night") not in (e990, e991)


def check_foreign_promotion_creates_no_event(conn) -> None:
    when = (datetime.now(timezone.utc) + timedelta(days=45)).strftime("%Y-%m-%d")
    for hint in ("BKFC event in Manchester", "ACBJJ 22", "PFL San Diego"):
        assert (
            resolve_or_create_event(conn, hint, event_date=when) is None
        ), f"{hint!r} must not become a provisional UFC card"

    # A genuinely new UFC card still gets created — the guard is not a blanket
    # refusal to create events.
    created = resolve_or_create_event(conn, "UFC 999", event_date=when)
    assert created is not None, "a new UFC card must still be created"


def check_stale_fighter_is_not_booked(conn) -> None:
    """An off-roster fighter years past their last bout is a bad match, not a booking."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text FROM fighter
            WHERE roster_status IN ('released', 'retired')
              AND COALESCE((
                    SELECT max(e.date) FROM bout b JOIN event e ON e.id = b.event_id
                    WHERE (b.fighter_a_id = fighter.id OR b.fighter_b_id = fighter.id)
                      AND b.method IS NOT NULL
                  ), 'epoch'::timestamptz) < now() - interval '36 months'
            LIMIT 1
            """
        )
        stale = cur.fetchone()
        cur.execute(
            "SELECT id::text FROM fighter WHERE roster_status = 'active' LIMIT 1"
        )
        active = cur.fetchone()
    if not stale or not active:
        print("  skip check_stale_fighter_is_not_booked (no suitable fixture rows)")
        return

    event_id = _make_event(conn, "UFC 998: Test vs. Test", "UFC 998", 40)
    bout_id, created = auto_create_bout(
        conn,
        fighter_a_id=active[0],
        fighter_b_id=stale[0],
        event_id=event_id,
        weight_class="lightweight",
    )
    assert bout_id is None and not created, (
        "a fighter 3+ years past their last bout and off the roster must not "
        "be auto-booked from a headline"
    )


def check_alias_beats_the_name_guard(conn) -> None:
    """A curated alias is a human statement that two strings are one person."""
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM fighter WHERE name_en = 'Renato Moicano'")
        row = cur.fetchone()
    if not row:
        print("  skip check_alias_beats_the_name_guard (Renato Moicano absent)")
        return
    moicano = row[0]
    # Drop the real alias first (rolled back with everything else): asserting
    # against whatever production currently holds would make this a report on
    # the alias table, not on the resolver.
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM fighter_alias WHERE lower(alias) = lower(%s)",
            ("Renato Carneiro",),
        )
    assert resolve_fighter_ids(conn, ["Renato Carneiro"], {}) != [moicano], (
        "without an alias, 'Renato Carneiro' must not resolve to Moicano — "
        "the surnames differ outright"
    )
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO fighter_alias (fighter_id, alias) VALUES (%s::uuid, %s)",
            (moicano, "Renato Carneiro"),
        )
    assert resolve_fighter_ids(conn, ["Renato Carneiro"], {}) == [moicano], (
        "a registered alias must resolve even though the raw names differ"
    )


def main() -> int:
    failures: list[str] = []

    for check in (check_surname_collision_rejected, check_foreign_promotions_flagged):
        try:
            check()
        except AssertionError as exc:
            failures.append(f"{check.__name__}: {exc}")
        else:
            print(f"  ok  {check.__name__}")

    with get_connection() as conn:
        try:
            for db_check in (
                check_numbered_card_resolves_by_number,
                check_foreign_promotion_creates_no_event,
                check_stale_fighter_is_not_booked,
                check_alias_beats_the_name_guard,
            ):
                try:
                    db_check(conn)
                except AssertionError as exc:
                    failures.append(f"{db_check.__name__}: {exc}")
                else:
                    print(f"  ok  {db_check.__name__}")
                conn.rollback()
        finally:
            conn.rollback()

    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nall phantom-bout guards hold")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
