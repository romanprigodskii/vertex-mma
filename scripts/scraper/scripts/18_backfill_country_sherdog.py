"""Step 18 — fighter nationality from Sherdog profiles.

Step 06 sources nationality from Wikidata via an English-Wikipedia article
title. That only reaches fighters notable enough to have an article, which
is why `fighter.country_code` coverage sat at 1,624 of 4,577 (35%) — and
the gap is not random: it is the low-profile and newly-signed end of the
roster, i.e. exactly the fighters on the next slate. On the upcoming card
only 25 of 67 bouts had a country on both sides.

Sherdog publishes nationality on every fighter profile, and 4,171 of our
fighters (91%) already carry a verified `sherdog_id` from step 17.

This step does NOT touch `country_code`. Two reasons, both measured on a
150-fighter read-only validation run (`--validate`, agreement 0.8600):

  * different definitions — country_code is Wikidata P27 (citizenship),
    Sherdog's block is `.item birthplace`. Adesanya reads NG here and NZ
    there; Uriah Hall JM vs US; Karo Parisyan US vs AM. Overwriting would
    change the flag the site renders for a chunk of the roster;
  * different vocabularies — the flag filename is alpha-2 for most
    countries but uses subdivision codes for the Home Nations ('en' for
    England, 9 of the 21 disagreements). 'EN' is not ISO at all, and 'SC'
    IS ISO — for Seychelles. Normalising at write time would bake a guess
    into the data.

So the raw flag code and the display name are stored as-is in
`fighter.sherdog_flag_code` / `fighter.sherdog_nationality`, and the
ISO map lives with the consumer (the sim model), where it can be revised
without re-scraping 4k pages. Same reasoning that kept `regional_export.py`
after its lab failed: building the data is the expensive part.

Idempotent. `--refresh` re-scrapes rows already filled; the default pass
only fills `sherdog_flag_code IS NULL`. Checkpointed every 50 fighters for
intra-run resume; the checkpoint is cleared on a clean finish.

Usage:
  ./venv/bin/python scripts/18_backfill_country_sherdog.py --validate 150
  ./venv/bin/python scripts/18_backfill_country_sherdog.py --dry-run --limit 20
  ./venv/bin/python scripts/18_backfill_country_sherdog.py
  ./venv/bin/python scripts/18_backfill_country_sherdog.py --refresh
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import _path  # noqa: F401
from rich.progress import BarColumn, Progress, TextColumn, TimeElapsedColumn

from src.config import CHECKPOINT_EVERY_FIGHTERS, SHERDOG_RATE_LIMIT_SECONDS
from src.db import get_connection
from src.http import Client
from src.sherdog import FIGHTER_URL_TEMPLATE, parse_fighter_page
from src.utils.logger import log, record_parse_error

CHECKPOINT_PATH = (
    Path(__file__).resolve().parents[1] / ".checkpoint_country_sherdog.json"
)

# has_upcoming_bout DESC first: the point of this backfill is the next
# slate, and a run interrupted halfway should still have covered it.
_ORDER = """
ORDER BY f.has_upcoming_bout DESC NULLS LAST,
         f.next_event_date ASC NULLS LAST,
         f.name_en
"""

TARGETS_SQL = (
    """
SELECT f.id::text, f.name_en, f.sherdog_id
FROM fighter f
WHERE f.sherdog_id IS NOT NULL
  AND f.sherdog_flag_code IS NULL
"""
    + _ORDER
)

TARGETS_REFRESH_SQL = (
    """
SELECT f.id::text, f.name_en, f.sherdog_id
FROM fighter f
WHERE f.sherdog_id IS NOT NULL
"""
    + _ORDER
)

VALIDATE_SQL = """
SELECT f.id::text, f.name_en, f.sherdog_id, f.country_code
FROM fighter f
WHERE f.country_code IS NOT NULL
  AND f.sherdog_id IS NOT NULL
ORDER BY md5(f.id::text)
LIMIT %(limit)s
"""

UPDATE_SQL = """
UPDATE fighter
   SET sherdog_flag_code = %(flag)s,
       sherdog_nationality = %(nat)s,
       updated_at = now()
 WHERE id = %(id)s
"""


def _load_checkpoint() -> set[str]:
    if CHECKPOINT_PATH.exists():
        return set(json.loads(CHECKPOINT_PATH.read_text()))
    return set()


def _save_checkpoint(done: set[str]) -> None:
    CHECKPOINT_PATH.write_text(json.dumps(sorted(done)))


def _fetch(client: Client, sherdog_id: str) -> tuple[str | None, str | None]:
    html = client.get(FIGHTER_URL_TEMPLATE.format(sherdog_id=sherdog_id))
    profile = parse_fighter_page(html)
    return profile.country_code, profile.nationality


def run_validate(limit: int) -> int:
    """Read-only. Compare Sherdog's flag against the country step 06 already
    established, and print the agreement rate. Writes nothing, ever."""
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(VALIDATE_SQL, {"limit": limit})
        rows = cur.fetchall()

    agree = disagree = missing = 0
    mismatches: list[tuple[str, str, str]] = []
    with (
        Client(rate_limit_seconds=SHERDOG_RATE_LIMIT_SECONDS) as client,
        Progress(
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("{task.completed}/{task.total}"),
            TimeElapsedColumn(),
        ) as progress,
    ):
        task = progress.add_task("validating", total=len(rows))
        for _fid, name, sherdog_id, db_cc in rows:
            try:
                flag, nat = _fetch(client, sherdog_id)
            except Exception as exc:  # noqa: BLE001
                record_parse_error(
                    url=FIGHTER_URL_TEMPLATE.format(sherdog_id=sherdog_id),
                    kind="sherdog_country_validate",
                    message=repr(exc),
                )
                missing += 1
                progress.advance(task)
                continue
            if flag is None:
                missing += 1
            elif flag == db_cc:
                agree += 1
            else:
                disagree += 1
                mismatches.append((name, db_cc, f"{flag} ({nat})"))
            progress.advance(task)

    checked = agree + disagree
    rate = f"{agree / checked:.4f}" if checked else "n/a"
    log.info(
        f"validate: n={len(rows)} · flag present {checked} · no flag {missing} · "
        f"agree {agree} · disagree {disagree} · agreement {rate}"
    )
    for name, db_cc, sd in mismatches[:40]:
        log.info(f"  mismatch {name}: db={db_cc} sherdog={sd}")
    return 0


def run_backfill(*, limit: int | None, dry_run: bool, refresh: bool) -> int:
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(TARGETS_REFRESH_SQL if refresh else TARGETS_SQL)
        targets = cur.fetchall()
    if limit is not None:
        targets = targets[:limit]

    done = set() if dry_run else _load_checkpoint()
    pending = [t for t in targets if t[0] not in done]
    log.info(
        f"sherdog nationality: {len(targets):,} candidates · "
        f"{len(pending):,} pending (checkpointed {len(done):,})"
        + (" · DRY RUN" if dry_run else "")
        + (" · REFRESH" if refresh else "")
    )

    totals: Counter[str] = Counter()
    vocabulary: Counter[str] = Counter()

    with (
        get_connection() as conn,
        Client(rate_limit_seconds=SHERDOG_RATE_LIMIT_SECONDS) as client,
        Progress(
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("{task.completed}/{task.total}"),
            TimeElapsedColumn(),
        ) as progress,
    ):
        task = progress.add_task("sherdog nationality", total=len(pending))
        for fighter_id, name, sherdog_id in pending:
            totals["processed"] += 1
            try:
                flag, nat = _fetch(client, sherdog_id)
            except Exception as exc:  # noqa: BLE001
                record_parse_error(
                    url=FIGHTER_URL_TEMPLATE.format(sherdog_id=sherdog_id),
                    kind="sherdog_country",
                    message=repr(exc),
                )
                totals["error"] += 1
                progress.advance(task)
                continue

            if flag is None:
                totals["no_flag"] += 1
            else:
                vocabulary[f"{flag}|{nat}"] += 1
                if dry_run:
                    totals["would_write"] += 1
                    log.info(f"  {name}: {flag} ({nat})")
                else:
                    with conn.cursor() as cur:
                        cur.execute(
                            UPDATE_SQL,
                            {"flag": flag, "nat": nat, "id": fighter_id},
                        )
                        totals["written"] += cur.rowcount
                    conn.commit()

            if not dry_run:
                done.add(fighter_id)
                if totals["processed"] % CHECKPOINT_EVERY_FIGHTERS == 0:
                    _save_checkpoint(done)
            progress.advance(task)

    if not dry_run:
        # Intra-run resume state only — a finished run must not block the
        # next one, which re-derives its own (smaller) candidate list.
        CHECKPOINT_PATH.unlink(missing_ok=True)

    log.info(
        f"done: processed {totals['processed']:,} · "
        f"written {totals['written']:,} · would-write {totals['would_write']:,} · "
        f"no flag {totals['no_flag']:,} · errors {totals['error']:,}"
    )
    # The full vocabulary, not the top-N: the ISO map downstream has to
    # cover every code that actually occurs, and a code seen twice is the
    # one that silently becomes NULL if it is missed.
    log.info(f"flag vocabulary ({len(vocabulary)} distinct):")
    for key, count in vocabulary.most_common():
        log.info(f"  {key} · {count}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Store Sherdog nationality (raw flag code + display name)."
    )
    parser.add_argument(
        "--validate",
        type=int,
        default=None,
        metavar="N",
        help="read-only: compare N already-known countries against Sherdog",
    )
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="re-scrape fighters that already have a flag code",
    )
    args = parser.parse_args()

    if args.validate is not None:
        return run_validate(args.validate)
    return run_backfill(
        limit=args.limit, dry_run=args.dry_run, refresh=args.refresh
    )


if __name__ == "__main__":
    raise SystemExit(main())
