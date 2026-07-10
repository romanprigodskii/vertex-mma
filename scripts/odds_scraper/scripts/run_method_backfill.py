"""CLI: backfill METHOD prop lines ("X wins by TKO/KO / submission /
decision") from bestfightodds for completed UFC events in a date window.

run_backfill.py only stores winner moneylines; past bestfightodds event
pages keep the full prop grid in HTML, so the method book can be
recovered retroactively. Two sources of event URLs:

  1. bout_external_odds.source_url rows already pointing at
     /events/<slug>-<id> (written by earlier backfills) — fetched
     directly, matched with the event's real date (±21d filter active).
  2. Events whose rows only carry the homepage URL (6-hourly cron
     overwrites source_url) — recovered by searching 1-2 fighters from
     the card and harvesting their fighter-page event links, keeping
     only BFO ids >= (min known id in window − 30); BFO event ids are
     chronological, so this bounds the fetch set to the window.

Discovered pages have no year on them, so three guards apply before
writing: matches restricted to bouts inside the window, majority-event
filter (a page is one event; stragglers matched to other events are
dropped), and a month/day sanity check of the page header date against
the majority event's date (±3 days, year-agnostic).

Usage:
  source venv/bin/activate
  python scripts/run_method_backfill.py                    # since 2025-01-01
  python scripts/run_method_backfill.py --since 2024-06-01
  python scripts/run_method_backfill.py --dry-run
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import httpx  # noqa: E402
from rich.console import Console  # noqa: E402

from src.db import get_connection  # noqa: E402
from src.discovery import fetch_events_on_fighter_page, search_fighter  # noqa: E402

# discovery.UFC_SLUG_RE requires "ufc-"/"ufc/" — but bestfightodds keeps
# many events under a BARE "ufc" slug (/events/ufc-3269, page titled just
# "UFC") when the card had no name at listing time. Those are real UFC
# events and half the 2025 cards live there, so accept them too.
_UFC_EVENT_SLUG_RE = re.compile(r"^ufc(-|$)", re.IGNORECASE)
from src.http import RateLimitedClient  # noqa: E402
from src.matcher import (  # noqa: E402
    DBBout,
    MatchedOdds,
    fetch_all_bouts,
    match_matchups_to_bouts,
    upsert_matched,
)
from src.parser import iter_events_on_homepage, parse_event_page  # noqa: E402

console = Console()

DEFAULT_SINCE = date(2025, 1, 1)
BFO_ID_THRESHOLD_BUFFER = 30
MIN_MAJORITY_MATCHES = 3  # discovered pages must anchor to one event this strongly
# BFO event ids are chronological across ALL promotions, ~1.3-2.0 new
# ids/day. When no usable event URL is stored (the cron overwrites
# source_url and older rows carry slugless fallbacks), the fetch set is
# bounded by max-homepage-id minus a generous per-day rate.
BFO_IDS_PER_DAY = 2.0

_MONTHS = {
    m: i + 1
    for i, m in enumerate(
        "january february march april may june july august september october november december".split()
    )
}
_HEADER_DATE_RE = re.compile(r"([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?", re.IGNORECASE)
_EVENT_PATH_RE = re.compile(r"/events/[a-z0-9-]+-(\d+)$", re.IGNORECASE)


@dataclass
class TargetEvent:
    event_id: str
    name: str
    event_date: date
    event_url_path: str | None  # /events/<slug>-<id> when already stored


def _parse_header_month_day(text: str) -> tuple[int, int] | None:
    m = _HEADER_DATE_RE.search(text or "")
    if not m:
        return None
    month = _MONTHS.get(m.group(1).lower())
    if month is None:
        return None
    try:
        day = int(m.group(2))
    except ValueError:
        return None
    return month, day


def _header_date_plausible(md: tuple[int, int] | None, event_date: date) -> bool:
    """Year-agnostic ±3d check of the page header 'June 20th' against the
    matched event's date. Missing/unparseable header passes (majority
    filter still applies)."""
    if md is None:
        return True
    month, day = md
    for year in (event_date.year - 1, event_date.year, event_date.year + 1):
        try:
            candidate = date(year, month, day)
        except ValueError:
            continue
        if abs((candidate - event_date).days) <= 3:
            return True
    return False


def _target_events(conn, since: date) -> list[TargetEvent]:
    sql = """
        SELECT
          e.id::text,
          e.name,
          e.date::date,
          (SELECT beo.source_url
             FROM bout_external_odds beo
             JOIN bout b2 ON b2.id = beo.bout_id
            WHERE b2.event_id = e.id AND beo.source_url ~ '/events/'
            ORDER BY beo.fetched_at DESC
            LIMIT 1) AS event_url
        FROM event e
        WHERE e.promotion = 'ufc'
          AND e.date >= %s
          AND EXISTS (
            SELECT 1 FROM bout b WHERE b.event_id = e.id AND b.status = 'completed'
          )
        ORDER BY e.date
    """
    out: list[TargetEvent] = []
    with conn.cursor() as cur:
        cur.execute(sql, (since,))
        for event_id, name, event_date, url in cur.fetchall():
            path = None
            if url:
                path = url.replace("https://www.bestfightodds.com", "")
                if not _EVENT_PATH_RE.match(path):
                    path = None
            out.append(
                TargetEvent(
                    event_id=event_id,
                    name=name,
                    event_date=event_date if isinstance(event_date, date) else date.fromisoformat(str(event_date)),
                    event_url_path=path,
                )
            )
    return out


def _seed_names_for_event(conn, event_id: str, limit: int = 4) -> list[str]:
    """Fighter names from the card, main event first — any of them leads
    to the BFO event page via their fighter page."""
    sql = """
        SELECT fa.name_en, fb.name_en
        FROM bout b
        JOIN fighter fa ON fa.id = b.fighter_a_id
        JOIN fighter fb ON fb.id = b.fighter_b_id
        WHERE b.event_id = %s::uuid AND b.status = 'completed'
        ORDER BY b.is_main_event DESC, b.bout_order ASC NULLS LAST
        LIMIT %s
    """
    names: list[str] = []
    with conn.cursor() as cur:
        cur.execute(sql, (event_id, limit))
        for name_a, name_b in cur.fetchall():
            for n in (name_a, name_b):
                if n and n not in names:
                    names.append(n)
    return names


def _method_count(matched: list[MatchedOdds]) -> int:
    return sum(
        1
        for m in matched
        if any(
            v is not None
            for v in (
                m.method_a_ko_decimal,
                m.method_a_sub_decimal,
                m.method_a_dec_decimal,
                m.method_b_ko_decimal,
                m.method_b_sub_decimal,
                m.method_b_dec_decimal,
            )
        )
    )


def _coverage_report(conn, since: date) -> None:
    sql = """
        SELECT
          COUNT(*) AS bouts,
          COUNT(beo.bout_id) AS with_odds,
          COUNT(*) FILTER (
            WHERE beo.method_a_kotko_decimal IS NOT NULL
               OR beo.method_b_kotko_decimal IS NOT NULL
          ) AS with_method
        FROM bout b
        JOIN event e ON e.id = b.event_id
        LEFT JOIN bout_external_odds beo
          ON beo.bout_id = b.id AND beo.source = 'bestfightodds'
        WHERE e.promotion = 'ufc' AND e.date >= %s AND b.status = 'completed'
    """
    with conn.cursor() as cur:
        cur.execute(sql, (since,))
        bouts, with_odds, with_method = cur.fetchone()
    console.log(
        f"coverage since {since}: {bouts:,} completed bouts · "
        f"{with_odds:,} with winner odds · {with_method:,} with method odds"
    )
    gap_sql = """
        SELECT e.name, e.date::date, COUNT(*) AS bouts
        FROM bout b
        JOIN event e ON e.id = b.event_id
        LEFT JOIN bout_external_odds beo ON beo.bout_id = b.id
          AND beo.source = 'bestfightodds'
          AND (beo.method_a_kotko_decimal IS NOT NULL
               OR beo.method_b_kotko_decimal IS NOT NULL)
        WHERE e.promotion = 'ufc' AND e.date >= %s AND b.status = 'completed'
        GROUP BY e.id, e.name, e.date
        HAVING COUNT(beo.bout_id) = 0
        ORDER BY e.date
    """
    with conn.cursor() as cur:
        cur.execute(gap_sql, (since,))
        gaps = cur.fetchall()
    if gaps:
        console.log(f"[yellow]{len(gaps)} events still without any method odds:[/yellow]")
        for name, d, bouts in gaps:
            console.log(f"  [yellow]{d} {name} ({bouts} bouts)[/yellow]")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--since", type=date.fromisoformat, default=DEFAULT_SINCE)
    ap.add_argument("--dry-run", action="store_true", help="parse + match, don't write")
    ap.add_argument(
        "--overwrite-winner",
        action="store_true",
        help="also refresh winner_a/b_decimal from the page medians "
        "(default: fill-only, existing winner lines are preserved)",
    )
    args = ap.parse_args()
    since: date = args.since

    console.log("loading DB bouts for matching…")
    with get_connection() as conn:
        db_bouts = fetch_all_bouts(conn)
        targets = _target_events(conn, since)
        seed_names: dict[str, list[str]] = {
            t.event_id: _seed_names_for_event(conn, t.event_id)
            for t in targets
            if t.event_url_path is None
        }

    window_start = since - timedelta(days=21)
    window: list[DBBout] = [b for b in db_bouts if b.event_date >= window_start]
    bout_to_event: dict[str, tuple[str, date]] = {
        b.bout_id: (b.event_id, b.event_date) for b in window
    }
    event_names = {t.event_id: t.name for t in targets}

    known = [t for t in targets if t.event_url_path is not None]
    missing = [t for t in targets if t.event_url_path is None]
    known_ids: set[int] = set()
    for t in known:
        m = _EVENT_PATH_RE.match(t.event_url_path or "")
        if m:
            known_ids.add(int(m.group(1)))

    console.log(
        f"{len(targets)} target events since {since} — "
        f"{len(known)} with stored event URLs, {len(missing)} need discovery"
    )

    n_upserted = 0
    n_method_bouts = 0
    n_errored = 0

    def _write(matched: list[MatchedOdds], label: str) -> None:
        nonlocal n_upserted, n_method_bouts
        n_meth = _method_count(matched)
        n_method_bouts += n_meth
        if args.dry_run:
            console.log(f"[dry-run] {label}: {len(matched)} matched · {n_meth} with method odds")
            return
        with get_connection() as conn:
            wrote = upsert_matched(
                conn, matched, preserve_winner=not args.overwrite_winner
            )
        n_upserted += wrote
        console.log(f"{label}: {len(matched)} matched · {n_meth} with method odds · {wrote} upserted")

    with RateLimitedClient() as client:
        console.log("=== Phase 1: stored event URLs ===")
        for t in known:
            try:
                resp = client.get(t.event_url_path)
            except httpx.HTTPError as exc:
                console.log(f"[red]{t.event_url_path}: {exc!r}[/red]")
                n_errored += 1
                continue
            if resp.status_code != 200:
                n_errored += 1
                continue
            matchups = parse_event_page(resp.text)
            if not matchups:
                continue
            matched = match_matchups_to_bouts(
                matchups,
                window,
                parent_event_date=t.event_date,
                event_url=t.event_url_path,
            )
            if matched:
                _write(matched, f"{t.name} ({t.event_date})")

        if missing:
            console.log("=== Phase 2: discovery for events without stored URLs ===")
            # The MISSING events are usually OLDER than every stored URL, so
            # min(known_ids) alone can bound them out. Always compute the
            # homepage-anchored estimate too and take the looser (lower) bound.
            estimates: list[int] = []
            if known_ids:
                estimates.append(min(known_ids) - BFO_ID_THRESHOLD_BUFFER)
            try:
                resp = client.get("/")
                home_ids = list(iter_events_on_homepage(resp.text)) if resp.status_code == 200 else []
            except httpx.HTTPError:
                home_ids = []
            if home_ids:
                days = (date.today() - since).days + 45
                estimates.append(max(home_ids) - int(days * BFO_IDS_PER_DAY))
            id_threshold = min(estimates) if estimates else 0
            console.log(f"BFO id threshold {id_threshold}")

            candidates: dict[int, str] = {}  # bfo_id -> url path
            searched: set[str] = set()
            for t in missing:
                resolved = 0
                for seed in seed_names.get(t.event_id, []):
                    if seed in searched:
                        continue
                    searched.add(seed)
                    try:
                        fighter = search_fighter(client, seed)
                        events = (
                            fetch_events_on_fighter_page(client, fighter, ufc_only=False)
                            if fighter is not None
                            else []
                        )
                    except httpx.HTTPError as exc:
                        console.log(f"[red]discovery {seed!r}: {exc!r}[/red]")
                        n_errored += 1
                        continue
                    if fighter is None:
                        continue
                    for ev in events:
                        if not _UFC_EVENT_SLUG_RE.match(ev.bfo_slug):
                            continue
                        if ev.bfo_id >= id_threshold and ev.bfo_id not in known_ids:
                            candidates.setdefault(ev.bfo_id, ev.url)
                    resolved += 1
                    if resolved >= 3:
                        break
            console.log(f"discovery: {len(candidates)} candidate event pages to fetch")

            for bfo_id, url in sorted(candidates.items()):
                try:
                    resp = client.get(url)
                except httpx.HTTPError as exc:
                    console.log(f"[red]{url}: {exc!r}[/red]")
                    n_errored += 1
                    continue
                if resp.status_code != 200:
                    n_errored += 1
                    continue
                matchups = parse_event_page(resp.text)
                if not matchups:
                    continue
                matched = match_matchups_to_bouts(matchups, window, event_url=url)
                if not matched:
                    continue
                # Majority-event filter: the page is exactly one event.
                by_event = Counter(bout_to_event[m.bout_id][0] for m in matched)
                top_event, top_n = by_event.most_common(1)[0]
                if top_n < MIN_MAJORITY_MATCHES:
                    console.log(f"[yellow]{url}: only {top_n} majority matches — skipped[/yellow]")
                    continue
                matched = [m for m in matched if bout_to_event[m.bout_id][0] == top_event]
                event_date = bout_to_event[matched[0].bout_id][1]
                md = _parse_header_month_day(matchups[0].event_date_text)
                if not _header_date_plausible(md, event_date):
                    console.log(
                        f"[yellow]{url}: header date {matchups[0].event_date_text!r} "
                        f"doesn't fit {event_date} — skipped[/yellow]"
                    )
                    continue
                # Re-match against ONLY the majority event's bouts, date-
                # anchored: without this a rematch pair (same two fighters
                # twice in the window) ties across both bouts and one of
                # them silently never receives odds.
                event_bouts = [b for b in window if b.event_id == top_event]
                matched = match_matchups_to_bouts(
                    matchups,
                    event_bouts,
                    parent_event_date=event_date,
                    event_url=url,
                )
                _write(matched, f"{event_names.get(top_event, top_event)} ← {url}")

    console.log(
        f"DONE — upserted {n_upserted:,} rows · {n_method_bouts:,} bouts with method odds · "
        f"errored {n_errored:,}"
    )
    if not args.dry_run:
        with get_connection() as conn:
            _coverage_report(conn, since)


if __name__ == "__main__":
    main()
