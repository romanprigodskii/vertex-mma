"""CLI: backfill historical UFC CLOSING lines from bestfightodds.

The word matters and this docstring had it wrong for a long time. What
bestfightodds archives, and therefore what a retrospective scrape returns,
is the CLOSING consensus — not the opening line. Measured rather than
assumed: on 23 bouts spanning 2021-2026 the value this pipeline stores sits a
mean 0.029 from the closing-range midpoint on the fighter page and 0.311 from
the open, and is closer to the close in 21 of the 23. `src/export.py`
calls it the closing line and is right to; this file was the one lying.

That mattered beyond tidiness: the wrong word here, plus the fact that rows
are written after the fight, was enough to talk a reader into believing the
whole project's model-vs-market comparison was measured against something
other than a close.

Two-phase pipeline:

  Phase 1 — discovery. Take the top-N UFC fighters by total bouts in
  our DB; for each, search bestfightodds → fetch their page → harvest
  every /events/<slug>-<id> URL they appear on. Deduped across all
  fighters this converges to ~700-800 unique UFC events with very
  high overlap, so 300-500 seed fighters typically cover the full
  history.

  Phase 2 — per-event scrape + match + upsert. Fetch each unique
  event page, parse all matchups, fuzzy-match each to a bout in our
  Postgres by name pair + date proximity, upsert consensus
  (median-across-books) decimal odds into bout_external_odds.

Usage:
  source venv/bin/activate
  python scripts/run_backfill.py              # 400 seed fighters
  python scripts/run_backfill.py 100          # tiny smoke test
  python scripts/run_backfill.py 800          # extra coverage

Polite ~1 req/sec throttle. 400 seeds ≈ 25 min discovery + 12 min
event-scraping = ~40 min total."""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import httpx  # noqa: E402
from rich.console import Console  # noqa: E402

from src.db import get_connection  # noqa: E402
from src.discovery import discover_events  # noqa: E402
from src.http import RateLimitedClient  # noqa: E402
from src.matcher import (  # noqa: E402
    fetch_all_bouts,
    index_bouts_by_event_window,
    match_matchups_to_bouts,
    upsert_matched,
)
from src.parser import parse_event_page  # noqa: E402

console = Console()

DEFAULT_SEED_FIGHTERS = 400


def _top_fighters_by_bouts(n: int) -> list[str]:
    sql = """
        SELECT f.name_en
        FROM fighter f
        WHERE f.id IN (
          SELECT fighter_a_id FROM bout WHERE status = 'completed'
          UNION
          SELECT fighter_b_id FROM bout WHERE status = 'completed'
        )
        ORDER BY (
          (SELECT COUNT(*) FROM bout WHERE fighter_a_id = f.id OR fighter_b_id = f.id)
        ) DESC
        LIMIT %s
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (n,))
            return [r[0] for r in cur.fetchall()]


def main() -> None:
    n_seed = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SEED_FIGHTERS

    console.log("loading DB bouts for matching…")
    with get_connection() as conn:
        db_bouts = fetch_all_bouts(conn)
    window_idx = index_bouts_by_event_window(db_bouts)
    console.log(
        f"{len(db_bouts):,} UFC bouts loaded ({len(window_idx):,} date buckets)"
    )

    console.log(f"selecting top {n_seed} fighter names from DB…")
    seed_names = _top_fighters_by_bouts(n_seed)

    n_events_scraped = 0
    n_matched_total = 0
    n_upserted_total = 0
    n_errored = 0

    with RateLimitedClient() as client:
        console.log("=== Phase 1: discovery ===")
        events = discover_events(client, seed_names)
        console.log(f"discovery done — {len(events):,} unique UFC events to fetch")

        console.log("=== Phase 2: event scrape + match + upsert ===")
        with get_connection() as conn:
            for i, ev in enumerate(events, start=1):
                try:
                    resp = client.get(ev.url)
                except httpx.HTTPError as exc:
                    console.log(f"[red]{ev.url}: {exc!r}[/red]")
                    n_errored += 1
                    continue
                if resp.status_code != 200:
                    n_errored += 1
                    continue
                n_events_scraped += 1
                matchups = parse_event_page(resp.text)
                if not matchups:
                    continue
                matched = match_matchups_to_bouts(
                    matchups, db_bouts, event_url=ev.url
                )
                n_matched_total += len(matched)
                wrote = upsert_matched(conn, matched)
                n_upserted_total += wrote
                if i % 25 == 0 or wrote > 0 and i % 5 == 0:
                    console.log(
                        f"[{i:>4}/{len(events)}] {ev.url} — "
                        f"{len(matchups)} matchups · {len(matched)} matched · "
                        f"{wrote} upserted"
                    )

    console.log(
        f"DONE — events {n_events_scraped:,}/{len(events):,} fetched · "
        f"matched {n_matched_total:,} · upserted {n_upserted_total:,} · "
        f"errored {n_errored:,}"
    )


if __name__ == "__main__":
    main()
