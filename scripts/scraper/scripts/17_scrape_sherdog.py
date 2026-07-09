"""Step 17 — Sherdog pre-UFC fight history (match ids + scrape careers).

Closes the sim model's biggest information gap: pre-UFC records. The
debut segment sat at ~59% accuracy vs the market's ~75% because
bookmakers see a debutant's regional record and we saw NaN. This step
matches every UFC-roster fighter to their Sherdog profile and stores the
full pro fight history in fighter_sherdog_bout; the sim pipeline derives
point-in-time pre-UFC features from the non-UFC rows.

Matching (precision over recall — see src/sherdog.py):
  * fighters with completed UFC bouts verify via fight overlap (shared
    event date ±1 day + opponent surname) — practically unforgeable;
  * true debutants (no UFC bouts yet) verify via exact DOB + name
    similarity, falling back to a unique near-exact name + height check.

Incremental (default) targets: never-attempted fighters, plus
upcoming-bout fighters that are unmatched (retry before fight day) or
matched-but-stale (> SHERDOG_RESYNC_DAYS — late-notice debutants add
regional fights close to their booking). --full re-syncs everyone.

Idempotent: history sync is delete-and-reinsert per fighter inside one
transaction; match bookkeeping is plain UPDATEs. Checkpointed every 50
fighters for intra-run resume (cross-run staleness lives in the DB via
sherdog_match_status / sherdog_synced_at).

Usage:
  ./venv/bin/python scripts/17_scrape_sherdog.py                # incremental
  ./venv/bin/python scripts/17_scrape_sherdog.py --full         # everyone
  ./venv/bin/python scripts/17_scrape_sherdog.py --retry-unmatched
  ./venv/bin/python scripts/17_scrape_sherdog.py --dry-run --limit 5
  ./venv/bin/python scripts/run_all.py --phase sherdog          # incremental
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import quote_plus

import _path  # noqa: F401
from rich.progress import BarColumn, Progress, TextColumn, TimeElapsedColumn

import psycopg

from src.config import (
    CHECKPOINT_EVERY_FIGHTERS,
    SHERDOG_RATE_LIMIT_SECONDS,
    SHERDOG_RESYNC_DAYS,
)
from src.db import get_connection
from src.http import Client
from src.loaders.sherdog import mark_match_status, save_matched_history
from src.sherdog import (
    FIGHT_FINDER_URL,
    FIGHTER_URL_TEMPLATE,
    SherdogCandidate,
    ascii_fold,
    count_fight_overlaps,
    mark_ufc_bouts_by_date,
    name_similarity,
    parse_fight_finder,
    parse_fighter_page,
    surnames_match,
)
from src.utils.logger import log, record_parse_error

CHECKPOINT_PATH = Path(__file__).resolve().parents[1] / ".checkpoint_sherdog.json"

# Verification thresholds. MAX_CANDIDATES bounds profile fetches per
# fighter so an ambiguous common name can't burn dozens of requests.
MAX_CANDIDATES = 4
MIN_SIMILARITY = 0.5
DEBUT_DOB_MIN_SIMILARITY = 0.75
DEBUT_NO_DOB_MIN_SIMILARITY = 0.99  # effectively exact name
HEIGHT_TOLERANCE_CM = 4

# Incremental targets: never attempted, or has an upcoming bout and is
# either unmatched (retry before fight day) or stale-matched. NULLS FIRST
# on next_event_date is deliberate — has_upcoming_bout DESC already puts
# bookings first; among them soonest fight first.
TARGETS_SQL = """
SELECT
  f.id::text AS fighter_id,
  f.name_en,
  f.nickname,
  f.dob::date AS dob,
  f.height_cm,
  f.sherdog_id,
  f.has_upcoming_bout
FROM fighter f
WHERE f.ufc_stats_id IS NOT NULL
  AND (
    f.sherdog_match_status IS NULL
    OR (f.has_upcoming_bout AND f.sherdog_id IS NULL)
    OR (
      f.has_upcoming_bout
      AND f.sherdog_id IS NOT NULL
      AND (
        f.sherdog_synced_at IS NULL
        OR f.sherdog_synced_at < now() - INTERVAL '%(resync_days)s days'
      )
    )
  )
ORDER BY f.has_upcoming_bout DESC, f.next_event_date ASC NULLS LAST, f.name_en
""" % {"resync_days": SHERDOG_RESYNC_DAYS}

TARGETS_FULL_SQL = """
SELECT
  f.id::text AS fighter_id,
  f.name_en,
  f.nickname,
  f.dob::date AS dob,
  f.height_cm,
  f.sherdog_id,
  f.has_upcoming_bout
FROM fighter f
WHERE f.ufc_stats_id IS NOT NULL
ORDER BY f.has_upcoming_bout DESC, f.next_event_date ASC NULLS LAST, f.name_en
"""

# Retry pass for fighters an earlier run couldn't match — useful right
# after the backfill: once opponents are matched, the opponent-history
# fallback below resolves most of the leftovers without search.
TARGETS_RETRY_SQL = """
SELECT
  f.id::text AS fighter_id,
  f.name_en,
  f.nickname,
  f.dob::date AS dob,
  f.height_cm,
  f.sherdog_id,
  f.has_upcoming_bout
FROM fighter f
WHERE f.ufc_stats_id IS NOT NULL
  AND f.sherdog_id IS NULL
  AND f.sherdog_match_status IN ('unmatched', 'ambiguous')
ORDER BY f.has_upcoming_bout DESC, f.next_event_date ASC NULLS LAST, f.name_en
"""

# Every fighter's completed UFC bouts (event date + opponent name/id) —
# the fight-overlap verification corpus, fetched once for the whole run.
DB_BOUTS_SQL = """
SELECT
  b.fighter_a_id::text AS fighter_a_id,
  b.fighter_b_id::text AS fighter_b_id,
  e.date::date AS event_date,
  fa.name_en AS name_a,
  fb.name_en AS name_b
FROM bout b
JOIN event e ON e.id = b.event_id
JOIN fighter fa ON fa.id = b.fighter_a_id
JOIN fighter fb ON fb.id = b.fighter_b_id
WHERE e.promotion = 'ufc' AND b.status = 'completed'
"""


def _load_checkpoint() -> set[str]:
    try:
        return set(json.loads(CHECKPOINT_PATH.read_text()))
    except Exception:
        return set()


def _save_checkpoint(done: set[str]) -> None:
    CHECKPOINT_PATH.write_text(json.dumps(sorted(done)))


def _fetch_db_bouts(
    conn: psycopg.Connection,
) -> dict[str, list[tuple[date, str, str]]]:
    """fighter_id -> [(event_date, opponent_name, opponent_fighter_id)]."""
    out: dict[str, list[tuple[date, str, str]]] = {}
    with conn.cursor() as cur:
        cur.execute(DB_BOUTS_SQL)
        for fa, fb, ev_date, name_a, name_b in cur.fetchall():
            out.setdefault(fa, []).append((ev_date, name_b, fb))
            out.setdefault(fb, []).append((ev_date, name_a, fa))
    return out


def _resolve_via_opponent_histories(
    conn: psycopg.Connection,
    fighter: dict,
    db_bouts: list[tuple[date, str, str]],
) -> str | None:
    """Search-free fallback: if any of the fighter's UFC opponents already
    has a synced Sherdog history, the opponent's row for their shared
    event date carries OUR fighter's sherdog id (opponent_sherdog_id).
    Rescues fighters the fight finder can't surface (e.g. spelling drift —
    "Benardo Sopaj" has zero fight-finder hits). The returned id is still
    profile-fetched and overlap-verified by the caller, so a bad vote
    degrades to 'unmatched', never to a wrong match."""
    opp_ids = list({oid for _, _, oid in db_bouts})
    if not opp_ids:
        return None
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT fighter_id::text, opponent_sherdog_id, opponent_name, event_date
            FROM fighter_sherdog_bout
            WHERE fighter_id = ANY(%s::uuid[])
              AND opponent_sherdog_id IS NOT NULL
              AND event_date IS NOT NULL
            """,
            (opp_ids,),
        )
        rows = cur.fetchall()
    by_opp: dict[str, list[tuple[str, str, date]]] = {}
    for opp_fid, osid, oname, edate in rows:
        by_opp.setdefault(opp_fid, []).append((osid, oname, edate))

    one_day = timedelta(days=1)
    votes: Counter[str] = Counter()
    for ev_date, _, opp_fid in db_bouts:
        same_date = [
            r for r in by_opp.get(opp_fid, []) if abs(r[2] - ev_date) <= one_day
        ]
        named = [r for r in same_date if surnames_match(r[1], fighter["name_en"])]
        if named:
            votes[named[0][0]] += 1
        elif len(same_date) == 1:
            # A fighter fights once per night (old one-night tournaments are
            # the multi-row exception — those need the surname check above).
            votes[same_date[0][0]] += 1
    if not votes:
        return None
    ranked = votes.most_common(2)
    if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
        return None  # conflicting votes — let it stay unmatched
    return ranked[0][0]


def _search_candidates(http: Client, name_en: str) -> list[SherdogCandidate]:
    """Fight-finder search, ranked by name similarity. Falls back to
    "first last" for 3+-token names Sherdog registered without the middle
    part (e.g. patronymics)."""
    queries = [ascii_fold(name_en)]
    tokens = ascii_fold(name_en).split()
    if len(tokens) > 2:
        queries.append(f"{tokens[0]} {tokens[-1]}")
    candidates: dict[str, SherdogCandidate] = {}
    for query in queries:
        html = http.get(FIGHT_FINDER_URL.format(query=quote_plus(query)))
        for cand in parse_fight_finder(html):
            candidates.setdefault(cand.sherdog_id, cand)
        if candidates:
            break
    ranked = list(candidates.values())
    for cand in ranked:
        cand.similarity = name_similarity(name_en, cand.name)
    ranked = [c for c in ranked if c.similarity >= MIN_SIMILARITY]
    ranked.sort(key=lambda c: c.similarity, reverse=True)
    return ranked[:MAX_CANDIDATES]


def _verify_candidate(
    *,
    candidate: SherdogCandidate,
    profile,
    fighter: dict,
    db_bouts: list[tuple[date, str]],
    n_candidates: int,
) -> bool:
    """Decide whether a fetched Sherdog profile is our fighter."""
    if db_bouts:
        return count_fight_overlaps(profile.fights, db_bouts) >= 1
    # True debutant — no UFC bouts in our DB yet.
    if fighter["dob"] is not None and profile.birth_date is not None:
        return (
            profile.birth_date == fighter["dob"]
            and candidate.similarity >= DEBUT_DOB_MIN_SIMILARITY
        )
    # No DOB on one of the sides: only accept an effectively exact,
    # unambiguous name — backed by height when both sides know it.
    if candidate.similarity < DEBUT_NO_DOB_MIN_SIMILARITY or n_candidates > 1:
        return False
    if fighter["height_cm"] is not None and candidate.height_cm is not None:
        return abs(fighter["height_cm"] - candidate.height_cm) <= HEIGHT_TOLERANCE_CM
    return True


def run(
    *,
    limit: int | None = None,
    dry_run: bool = False,
    full: bool = False,
    retry_unmatched: bool = False,
) -> dict[str, int]:
    totals = {
        "processed": 0,
        "matched": 0,
        "resynced": 0,
        "unmatched": 0,
        "ambiguous": 0,
        "fights_written": 0,
        "errors": 0,
    }
    done = set() if dry_run else _load_checkpoint()

    if retry_unmatched:
        targets_sql = TARGETS_RETRY_SQL
    elif full:
        targets_sql = TARGETS_FULL_SQL
    else:
        targets_sql = TARGETS_SQL

    with Client(rate_limit_seconds=SHERDOG_RATE_LIMIT_SECONDS) as http, get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(targets_sql)
            cols = [d[0] for d in cur.description]
            targets = [dict(zip(cols, row)) for row in cur.fetchall()]
        targets = [t for t in targets if t["fighter_id"] not in done]
        if limit is not None:
            targets = targets[:limit]
        db_bouts_by_fighter = _fetch_db_bouts(conn)

        log.info(
            f"phase 17: sherdog sync for {len(targets)} fighters "
            f"(full={full}, retry_unmatched={retry_unmatched}, "
            f"checkpointed: {len(done)})"
        )

        with Progress(
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("[cyan]{task.completed}/{task.total}[/]"),
            TimeElapsedColumn(),
        ) as progress:
            task = progress.add_task("Sherdog", total=len(targets))
            for fighter in targets:
                fid = fighter["fighter_id"]
                db_bouts3 = db_bouts_by_fighter.get(fid, [])
                db_bout_pairs = [(d, n) for d, n, _ in db_bouts3]
                try:
                    already_matched = fighter["sherdog_id"] is not None
                    profile = None
                    sherdog_id = fighter["sherdog_id"]

                    if already_matched:
                        html = http.get(
                            FIGHTER_URL_TEMPLATE.format(sherdog_id=sherdog_id)
                        )
                        profile = parse_fighter_page(html)
                    else:
                        candidates = _search_candidates(http, fighter["name_en"])
                        for cand in candidates:
                            html = http.get(
                                FIGHTER_URL_TEMPLATE.format(
                                    sherdog_id=cand.sherdog_id
                                )
                            )
                            cand_profile = parse_fighter_page(html)
                            if _verify_candidate(
                                candidate=cand,
                                profile=cand_profile,
                                fighter=fighter,
                                db_bouts=db_bout_pairs,
                                n_candidates=len(candidates),
                            ):
                                profile = cand_profile
                                sherdog_id = cand.sherdog_id
                                break
                        if profile is None and db_bouts3:
                            # Search failed — try resolving through already
                            # synced opponents, then overlap-verify as usual.
                            fallback_id = _resolve_via_opponent_histories(
                                conn, fighter, db_bouts3
                            )
                            if fallback_id:
                                html = http.get(
                                    FIGHTER_URL_TEMPLATE.format(
                                        sherdog_id=fallback_id
                                    )
                                )
                                cand_profile = parse_fighter_page(html)
                                if (
                                    count_fight_overlaps(
                                        cand_profile.fights, db_bout_pairs
                                    )
                                    >= 1
                                ):
                                    profile = cand_profile
                                    sherdog_id = fallback_id
                        if profile is None:
                            status = "ambiguous" if candidates else "unmatched"
                            mark_match_status(
                                conn, fighter_id=fid, status=status, dry_run=dry_run
                            )
                            if not dry_run:
                                conn.commit()
                            totals[status] += 1
                            totals["processed"] += 1
                            done.add(fid)
                            progress.advance(task)
                            continue

                    mark_ufc_bouts_by_date(
                        profile.fights, [d for d, _, _ in db_bouts3]
                    )
                    try:
                        n = save_matched_history(
                            conn,
                            fighter_id=fid,
                            sherdog_id=sherdog_id,
                            fights=profile.fights,
                            dry_run=dry_run,
                        )
                    except psycopg.errors.UniqueViolation:
                        # sherdog_id already claimed by another fighter —
                        # one of the two matches is wrong. Don't guess.
                        conn.rollback()
                        mark_match_status(
                            conn, fighter_id=fid, status="ambiguous", dry_run=dry_run
                        )
                        if not dry_run:
                            conn.commit()
                        record_parse_error(
                            url=FIGHTER_URL_TEMPLATE.format(sherdog_id=sherdog_id),
                            kind="sherdog_duplicate_match",
                            message=f"sherdog_id {sherdog_id} already claimed "
                            f"(fighter {fid} marked ambiguous)",
                        )
                        totals["ambiguous"] += 1
                        totals["processed"] += 1
                        done.add(fid)
                        progress.advance(task)
                        continue
                    if not dry_run:
                        conn.commit()
                    totals["fights_written"] += n
                    totals["resynced" if already_matched else "matched"] += 1
                except Exception as exc:  # noqa: BLE001 — non-fatal per fighter
                    conn.rollback()
                    totals["errors"] += 1
                    record_parse_error(
                        url=FIGHT_FINDER_URL.format(
                            query=quote_plus(ascii_fold(fighter["name_en"]))
                        ),
                        kind="sherdog_fighter",
                        message=repr(exc),
                        extra={"fighter_id": fid, "name": fighter["name_en"]},
                    )
                    log.error(f"sherdog sync failed for {fighter['name_en']}: {exc!r}")

                totals["processed"] += 1
                done.add(fid)
                if not dry_run and totals["processed"] % CHECKPOINT_EVERY_FIGHTERS == 0:
                    _save_checkpoint(done)
                progress.advance(task)

        if not dry_run:
            # The checkpoint is intra-run resume state only. Clearing it on
            # clean completion keeps cross-run behavior driven purely by DB
            # state (sherdog_match_status / sherdog_synced_at) — unlike 04's
            # checkpoint, which persists forever and silently blocks
            # staleness-driven resyncs.
            CHECKPOINT_PATH.unlink(missing_ok=True)

    log.info(
        "phase 17: sherdog done: "
        + " ".join(f"{k}={v}" for k, v in totals.items())
    )
    return totals


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Match fighters to Sherdog and scrape full fight histories."
    )
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--full",
        action="store_true",
        help="target every fighter (default: incremental — new + upcoming)",
    )
    parser.add_argument(
        "--retry-unmatched",
        action="store_true",
        help="second pass over unmatched/ambiguous fighters (the opponent-"
        "history fallback resolves most once their opponents are synced)",
    )
    args = parser.parse_args()
    run(
        limit=args.limit,
        dry_run=args.dry_run,
        full=args.full,
        retry_unmatched=args.retry_unmatched,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
