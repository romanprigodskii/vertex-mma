"""Compare every upcoming card we serve against the live UFCStats card.

The question this answers is the one a reader asks first: is a fight on our
site actually booked? Nothing else checked it. Phantom bouts reached live
cards and sat there for a week — the pipeline had no notion of "our card
disagrees with the source", only of "the scrape ran".

Reports two kinds of drift, both worth knowing:

  EXTRA   — on our card, not on UFCStats. A provisional row that was never
            adopted (the phantom shape), or a bout UFCStats has since pulled.
  MISSING — on UFCStats, not on ours. A scrape that silently under-read.

Matching is by surname pair, which is what survives the two sites spelling a
fighter differently ("Ian Garry" / "Ian Machado Garry"). Cards UFCStats keeps
off its upcoming listing (DWCS) are fetched by their own event id when we hold
one, so they are checked rather than reported as unknown.

Exit code is 1 when any drift is found, so cron can gate on it.

Run:
    scripts/scraper/venv/bin/python scripts/scraper/scripts/verify_cards_against_ufcstats.py
"""
from __future__ import annotations

import re
import unicodedata

import _path  # noqa: F401

from src.config import EVENTS_UPCOMING_URL
from src.db import get_connection
from src.http import Client
from src.parsers.event_details import parse_event_details
from src.parsers.events import parse_events_listing
from src.utils.logger import log

_UFCSTATS_EVENT_URL = "http://ufcstats.com/event-details/{}"


def _surname(name: str) -> str:
    folded = unicodedata.normalize("NFKD", name or "")
    folded = "".join(ch for ch in folded if not unicodedata.combining(ch))
    folded = re.sub(r"[^A-Za-z ]", " ", folded).lower().split()
    return folded[-1] if folded else ""


def _pair(a: str, b: str) -> frozenset[str]:
    return frozenset((_surname(a), _surname(b)))


def _our_upcoming_cards(conn) -> dict[str, dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT e.ufc_stats_id, e.name, e.date::date,
                   fa.name_en, fb.name_en, b.ufc_stats_id IS NULL
            FROM bout b
            JOIN event e ON e.id = b.event_id
            LEFT JOIN fighter fa ON fa.id = b.fighter_a_id
            LEFT JOIN fighter fb ON fb.id = b.fighter_b_id
            WHERE e.date >= now()
              AND b.status <> 'cancelled'
              AND e.status <> 'cancelled'
            ORDER BY e.date
            """
        )
        cards: dict[str, dict] = {}
        for ev_uid, ev_name, ev_date, fa, fb, provisional in cur.fetchall():
            key = ev_uid or f"provisional:{ev_name}"
            card = cards.setdefault(
                key,
                {"uid": ev_uid, "name": ev_name, "date": ev_date, "bouts": []},
            )
            card["bouts"].append((fa, fb, provisional))
        return cards


def run() -> dict[str, int]:
    totals = {"cards_checked": 0, "extra": 0, "missing": 0, "unverifiable": 0}

    with get_connection() as conn:
        ours = _our_upcoming_cards(conn)

    live: dict[str, list[tuple[str, str]]] = {}
    with Client() as http:
        for item in parse_events_listing(http.get(EVENTS_UPCOMING_URL)):
            details = parse_event_details(http.get(item.detail_url))
            live[item.ufc_stats_id] = [
                (b.fighter_a_name, b.fighter_b_name) for b in details.bouts
            ]
        # Cards we track that the upcoming listing omits (DWCS lives on its own
        # page) — fetch them directly rather than calling them unverifiable.
        for card in ours.values():
            if card["uid"] and card["uid"] not in live:
                details = parse_event_details(
                    http.get(_UFCSTATS_EVENT_URL.format(card["uid"]))
                )
                live[card["uid"]] = [
                    (b.fighter_a_name, b.fighter_b_name) for b in details.bouts
                ]

    for card in sorted(ours.values(), key=lambda c: c["date"]):
        label = f"[{card['date']}] {card['name']}"
        if not card["uid"]:
            totals["unverifiable"] += 1
            log.warning(
                f"{label} — provisional card, UFCStats has never listed it "
                f"({len(card['bouts'])} bout(s))"
            )
            continue

        live_bouts = live.get(card["uid"], [])
        totals["cards_checked"] += 1
        live_keys = {_pair(a, b) for a, b in live_bouts}
        our_keys = {_pair(a or "", b or "") for a, b, _ in card["bouts"]}

        drift = False
        for fa, fb, provisional in card["bouts"]:
            if _pair(fa or "", fb or "") not in live_keys:
                drift = True
                totals["extra"] += 1
                tag = "provisional" if provisional else "scraped"
                log.warning(f"{label}  EXTRA ({tag}): {fa} vs {fb}")
        for fa, fb in live_bouts:
            if _pair(fa, fb) not in our_keys:
                drift = True
                totals["missing"] += 1
                log.warning(f"{label}  MISSING: {fa} vs {fb}")
        if not drift:
            log.info(f"{label} — {len(card['bouts'])} bout(s), matches UFCStats")

    log.info(
        f"card verification: checked={totals['cards_checked']} "
        f"extra={totals['extra']} missing={totals['missing']} "
        f"unverifiable={totals['unverifiable']}"
    )
    return totals


if __name__ == "__main__":
    result = run()
    raise SystemExit(1 if result["extra"] or result["missing"] else 0)
