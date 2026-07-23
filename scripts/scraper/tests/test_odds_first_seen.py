"""Pin the `bout_external_odds.created_at` first-seen invariant.

`created_at` is the moment a bout FIRST got a sportsbook line. It is the only
announcement-date proxy that exists anywhere in the schema — `bout.created_at`
was stamped en masse at import and `fetched_at` is overwritten on every
6-hourly pass — and it survives today only because nobody has put it in an
ON CONFLICT DO UPDATE SET clause. That is one careless refactor away from
erasing months of accumulated lead time that CANNOT be reconstructed.

Two upsert paths write the table:
  * scripts/scraper/scripts/08_scrape_bestfightodds.py  (the 6-hourly cron)
  * scripts/odds_scraper/src/matcher.py                 (the backfill)

Each is checked twice — statically (the column name must not appear in the
SET clause) and against the live database (upsert an existing row and watch
what moves). Everything runs inside a transaction that is rolled back, so the
test never leaves a trace in production.

Run:
    scripts/scraper/venv/bin/python scripts/scraper/tests/test_odds_first_seen.py

Needs DATABASE_URL in .env.local, like every other scraper entry point.
"""
from __future__ import annotations

import importlib.util
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

_SCRAPER_ROOT = Path(__file__).resolve().parents[1]
_REPO_ROOT = _SCRAPER_ROOT.parents[1]
sys.path.insert(0, str(_SCRAPER_ROOT))
sys.path.insert(0, str(_SCRAPER_ROOT / "scripts"))

from src.db import get_connection  # noqa: E402

_BFO_SCRIPT = _SCRAPER_ROOT / "scripts" / "08_scrape_bestfightodds.py"
_MATCHER = _REPO_ROOT / "scripts" / "odds_scraper" / "src" / "matcher.py"

# A timestamp far enough in the past that no `now()` could be mistaken for it.
_ANCHOR = datetime(2020, 1, 1, tzinfo=timezone.utc)


def _load_bfo_module():
    """Import the numbered cron script as a module so the test exercises the
    real `upsert_odds`, not a copy of its SQL."""
    if "bfo_scraper" in sys.modules:
        return sys.modules["bfo_scraper"]
    spec = importlib.util.spec_from_file_location("bfo_scraper", _BFO_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    # Register before exec: @dataclass resolves annotations through
    # sys.modules[cls.__module__] and blows up if the module isn't there yet.
    sys.modules["bfo_scraper"] = module
    spec.loader.exec_module(module)
    return module


def _insert_sql_literal(source: str, where: str) -> str:
    """Pull the bout_external_odds INSERT out of a chunk of Python source.

    Reading the literal (rather than a copy pasted into the test) is the whole
    point: the check can't drift from what production actually runs. It also
    keeps the invariant notes — which necessarily mention `DO UPDATE SET` and
    `created_at` in prose — out of what gets scanned."""
    match = re.search(
        r'"""(\s*INSERT INTO bout_external_odds.*?)"""', source, re.S
    )
    if match is None:
        raise AssertionError(
            f"no bout_external_odds INSERT literal found in {where} — the "
            f"test's extraction is stale; fix it rather than deleting the check."
        )
    return match.group(1)


def _matcher_upsert_sql() -> str:
    """UPSERT_SQL from the backfill matcher, read WITHOUT importing it — that
    module lives in a separate venv (rapidfuzz) and coupling the two
    environments just to read a string constant is not worth it."""
    return _insert_sql_literal(_MATCHER.read_text(), "matcher.py")


def _do_update_set_clause(sql: str) -> str:
    """The text between DO UPDATE SET and the end of the statement — the only
    place a column can be assigned on conflict."""
    marker = "DO UPDATE SET"
    idx = sql.upper().find(marker)
    if idx < 0:
        raise AssertionError(f"no DO UPDATE SET in:\n{sql}")
    return sql[idx + len(marker) :]


# ---------------------------------------------------------------------------
# Static checks — these fail the moment someone types `created_at` in a SET
# ---------------------------------------------------------------------------


def check_cron_sql_omits_created_at() -> None:
    import inspect

    bfo = _load_bfo_module()
    clause = _do_update_set_clause(
        _insert_sql_literal(inspect.getsource(bfo.upsert_odds), "upsert_odds")
    )
    assert "created_at" not in clause, (
        "08_scrape_bestfightodds.upsert_odds assigns created_at on conflict — "
        "that destroys the first-seen timestamp. See the invariant note on the "
        "function."
    )


def check_backfill_sql_omits_created_at() -> None:
    clause = _do_update_set_clause(_matcher_upsert_sql())
    assert "created_at" not in clause, (
        "odds_scraper matcher.UPSERT_SQL assigns created_at on conflict — that "
        "destroys the first-seen timestamp. See the invariant note above the "
        "constant."
    )


def check_preserve_winner_variant_is_derived() -> None:
    """UPSERT_PRESERVE_WINNER_SQL inherits the invariant only because it is
    built from UPSERT_SQL by two winner-column replacements. If it is ever
    rewritten as its own literal, it needs its own check — fail loudly instead
    of silently covering nothing."""
    source = _MATCHER.read_text()
    assert re.search(
        r"UPSERT_PRESERVE_WINNER_SQL\s*=\s*UPSERT_SQL\.replace\(", source
    ), (
        "UPSERT_PRESERVE_WINNER_SQL is no longer derived from UPSERT_SQL — it "
        "must be checked for created_at in its own right now."
    )


# ---------------------------------------------------------------------------
# Live checks — upsert a real row and watch which timestamps move
# ---------------------------------------------------------------------------


def _seed_row(cur, bout_id: str) -> None:
    """Plant a bout_external_odds row whose timestamps are both pinned to 2020,
    so a `now()` written by either column is unmistakable. Pinning created_at
    explicitly (rather than doing two upserts) also sidesteps `now()` being
    frozen at transaction start — both writes would otherwise carry the same
    value and the fetched_at half of the assertion would prove nothing."""
    cur.execute(
        """
        INSERT INTO bout_external_odds (
            bout_id, source, fetched_at, created_at,
            winner_a_decimal, winner_b_decimal, source_url
        )
        VALUES (%s::uuid, 'bestfightodds', %s, %s, 1.50, 2.60, 'seed')
        """,
        (bout_id, _ANCHOR, _ANCHOR),
    )


def _timestamps(cur, bout_id: str) -> tuple[datetime, datetime, float | None]:
    cur.execute(
        "SELECT created_at, fetched_at, winner_a_decimal FROM bout_external_odds "
        "WHERE bout_id = %s::uuid AND source = 'bestfightodds'",
        (bout_id,),
    )
    return cur.fetchone()


def _pick_bout_without_odds(cur) -> str:
    cur.execute(
        """
        SELECT b.id::text
        FROM bout b
        LEFT JOIN bout_external_odds o
          ON o.bout_id = b.id AND o.source = 'bestfightodds'
        WHERE o.id IS NULL
        LIMIT 1
        """
    )
    row = cur.fetchone()
    assert row is not None, "no bout without a bestfightodds row to test against"
    return row[0]


def check_cron_upsert_preserves_created_at(conn) -> None:
    bfo = _load_bfo_module()
    with conn.cursor() as cur:
        bout_id = _pick_bout_without_odds(cur)
        _seed_row(cur, bout_id)

        fight = bfo.ScrapedFight(
            matchup_id="test",
            fighter_a_name="A",
            fighter_a_slug="a",
            fighter_b_name="B",
            fighter_b_slug="b",
            winner_a_decimal=1.91,
            winner_b_decimal=1.95,
        )
        bfo.upsert_odds(conn, bout_id, fight, "https://example.invalid/test", False)

        created_at, fetched_at, winner_a = _timestamps(cur, bout_id)
        assert created_at == _ANCHOR, (
            f"cron upsert MOVED created_at {_ANCHOR} -> {created_at}; the "
            f"first-seen timestamp is no longer preserved"
        )
        assert fetched_at > _ANCHOR, (
            "cron upsert did not move fetched_at — the freshness timestamp is "
            "supposed to be overwritten every run; the test is no longer "
            "exercising the conflict path"
        )
        assert abs(winner_a - 1.91) < 1e-6, (
            "cron upsert did not overwrite the winner line — the test is no "
            "longer exercising the conflict path"
        )


def check_backfill_upsert_preserves_created_at(conn) -> None:
    sql = _matcher_upsert_sql()
    with conn.cursor() as cur:
        bout_id = _pick_bout_without_odds(cur)
        _seed_row(cur, bout_id)

        cur.execute(
            sql,
            (
                bout_id, "bestfightodds", 2.05, 1.80,
                None, None, None, None, None, None,
                "https://example.invalid/backfill",
            ),
        )

        created_at, fetched_at, winner_a = _timestamps(cur, bout_id)
        assert created_at == _ANCHOR, (
            f"backfill upsert MOVED created_at {_ANCHOR} -> {created_at}; the "
            f"first-seen timestamp is no longer preserved"
        )
        assert fetched_at > _ANCHOR, (
            "backfill upsert did not move fetched_at — the test is no longer "
            "exercising the conflict path"
        )
        assert abs(winner_a - 2.05) < 1e-6, (
            "backfill upsert did not overwrite the winner line — the test is no "
            "longer exercising the conflict path"
        )


def main() -> int:
    failures: list[str] = []

    for check in (
        check_cron_sql_omits_created_at,
        check_backfill_sql_omits_created_at,
        check_preserve_winner_variant_is_derived,
    ):
        try:
            check()
        except AssertionError as exc:
            failures.append(f"{check.__name__}: {exc}")
        else:
            print(f"  ok  {check.__name__}")

    # One transaction for both live checks, rolled back unconditionally — the
    # production table must look untouched afterwards.
    with get_connection() as conn:
        try:
            for check in (
                check_cron_upsert_preserves_created_at,
                check_backfill_upsert_preserves_created_at,
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
    print("\nall odds first-seen invariant checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
