"""Match bestfightodds matchups to bouts in our Postgres."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta

from rapidfuzz import fuzz

from .parser import MatchupOdds

# Best-fight-odds returns event dates as raw "June 6th" without a year.
# When we look up the event in our DB we try our own event table by
# fuzzy name match, then derive the year from THAT row. As a fallback
# we accept any event within ±21 days of the bfo-reported month/day.
DATE_TOLERANCE_DAYS = 21
NAME_SIMILARITY_THRESHOLD = 85


@dataclass
class DBBout:
    bout_id: str
    event_id: str
    event_name: str
    event_date: date
    fighter_a_id: str
    fighter_a_name: str
    fighter_b_id: str
    fighter_b_name: str


def normalize_name(name: str) -> str:
    """Lowercase, strip diacritics, drop punctuation. Used to make fuzzy
    matching score "Nuñez" and "Nunez" the same."""
    nfkd = unicodedata.normalize("NFKD", name)
    no_accents = "".join(c for c in nfkd if not unicodedata.combining(c))
    cleaned = re.sub(r"[^a-z0-9]+", " ", no_accents.lower()).strip()
    return cleaned


# A pair passes only when the AVERAGE clears NAME_SIMILARITY_THRESHOLD
# AND the weaker side clears this floor. Without the per-side minimum a
# perfect name (100) carries an opponent as weak as 70 — late-replacement
# cards ("A vs B" page rows vs the DB's rebooked "A vs C") slip through.
MIN_SIDE_SIMILARITY = 75


def _pair_similarity(
    bfo_a: str, bfo_b: str, db_a: str, db_b: str
) -> tuple[float, float, bool]:
    """Score the bfo-A/bfo-B pair against the db-A/db-B pair. Returns
    (best_avg_score, min_side_score, ab_inverted). Swap is needed when
    bestfightodds lists fighters in opposite order from our DB."""
    bna, bnb = normalize_name(bfo_a), normalize_name(bfo_b)
    dna, dnb = normalize_name(db_a), normalize_name(db_b)
    d1, d2 = fuzz.ratio(bna, dna), fuzz.ratio(bnb, dnb)
    s1, s2 = fuzz.ratio(bna, dnb), fuzz.ratio(bnb, dna)
    direct, direct_min = (d1 + d2) / 2, min(d1, d2)
    swapped, swapped_min = (s1 + s2) / 2, min(s1, s2)
    if direct >= swapped:
        return direct, direct_min, False
    return swapped, swapped_min, True


@dataclass
class MatchedOdds:
    bout_id: str
    bfo_event_id: int
    bfo_matchup_id: int
    consensus_a_decimal: float | None
    consensus_b_decimal: float | None
    n_books_a: int
    n_books_b: int
    source_url: str
    quality_score: float  # name-similarity score 0–100
    method_a_ko_decimal: float | None = None
    method_a_sub_decimal: float | None = None
    method_a_dec_decimal: float | None = None
    method_b_ko_decimal: float | None = None
    method_b_sub_decimal: float | None = None
    method_b_dec_decimal: float | None = None


_MONTHS = {
    m: i
    for i, m in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun",
         "jul", "aug", "sep", "oct", "nov", "dec"],
        start=1,
    )
}
_DATE_TEXT_RE = re.compile(
    r"([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?"
)


def parse_event_date_text(text: str | None) -> tuple[int, int, int | None] | None:
    """(month, day, year|None) from bfo's `June 6th` / `Dec 11th 2021`.

    The parser hands the raw string through and leaves resolution to the
    caller (see `MatchupOdds.event_date_text`). This is that resolution, and
    it lives here because the matcher is the only thing that needs it.
    """
    if not text:
        return None
    m = _DATE_TEXT_RE.search(text.strip())
    if m is None:
        return None
    month = _MONTHS.get(m.group(1)[:3].lower())
    if month is None:
        return None
    day = int(m.group(2))
    if not 1 <= day <= 31:
        return None
    return month, day, int(m.group(3)) if m.group(3) else None


def _date_compatible(
    bout_date: date, md: tuple[int, int, int | None], tol: int = DATE_TOLERANCE_DAYS
) -> bool:
    """Is `bout_date` within `tol` days of the bfo month/day?

    With no year on the page, the month/day is anchored in the bout's own
    year and its two neighbours, so a page dated `Jan 3rd` still reaches a
    bout on December 28th.
    """
    month, day, year = md
    years = (year,) if year is not None else (
        bout_date.year - 1, bout_date.year, bout_date.year + 1
    )
    for y in years:
        try:
            anchor = date(y, month, day)
        except ValueError:
            continue
        if abs((bout_date - anchor).days) <= tol:
            return True
    return False


def match_matchups_to_bouts(
    matchups: Iterable[MatchupOdds],
    db_bouts: list[DBBout],
    *,
    parent_event_date: date | None = None,
    event_url: str | None = None,
    require_date: bool = True,
) -> list[MatchedOdds]:
    """For each bfo matchup, find the best-match DBBout by combined
    name similarity + date proximity. Skips matchups with no candidate
    above the similarity threshold.

    DATE FILTERING IS NOT OPTIONAL, and this is why. `run_backfill.py` never
    passed `parent_event_date`, so for every backfill run the ±21-day filter
    and the rematch tie-break below were both dead code and every matchup was
    resolved on fighter names alone — against the WHOLE bout table. On
    2026-08-15 that wrote the closing line of the September 2026 Van–Pantoja
    rematch onto their December 2025 fight, moving that bout's stored
    probability by 18.5 points.

    So the date now comes from the matchup itself (`event_date_text`, which
    the parser has always carried) whenever the caller does not supply one,
    and a matchup that cannot be dated at all is SKIPPED rather than matched
    on names — an undated matchup is exactly the case that caused the damage.
    `require_date=False` restores the old behaviour for a caller that really
    wants it; nothing in this repo does.

    Rematches are refused rather than guessed: if two candidate bouts in
    DIFFERENT years both clear the name threshold, there is no evidence in
    hand to choose between them, and writing the wrong one is worse than
    writing neither.
    """
    out: list[MatchedOdds] = []
    for m in matchups:
        md = parse_event_date_text(m.event_date_text)
        if parent_event_date is None and md is None and require_date:
            continue
        best: tuple[float, float, float, DBBout, bool] | None = None
        qualifying_years: set[int] = set()
        for bout in db_bouts:
            # If we know the bfo event's calendar date, filter early.
            if parent_event_date is not None:
                if abs((bout.event_date - parent_event_date).days) > DATE_TOLERANCE_DAYS:
                    continue
            elif md is not None and not _date_compatible(bout.event_date, md):
                continue
            score, side_min, inverted = _pair_similarity(
                m.fighter_a_name,
                m.fighter_b_name,
                bout.fighter_a_name,
                bout.fighter_b_name,
            )
            if score >= NAME_SIMILARITY_THRESHOLD and side_min >= MIN_SIDE_SIMILARITY:
                qualifying_years.add(bout.event_date.year)
            # Tie-break equal-score candidates (scratched-and-rebooked pairs,
            # rematches) by date proximity to the page's event when known.
            date_rank = (
                -abs((bout.event_date - parent_event_date).days)
                if parent_event_date is not None
                else 0.0
            )
            if best is None or (score, date_rank) > (best[0], best[1]):
                best = (score, date_rank, side_min, bout, inverted)
        if best is None or best[0] < NAME_SIMILARITY_THRESHOLD:
            continue
        if len(qualifying_years) > 1:
            # Same pair, two different years, both inside the window: a
            # rematch we cannot resolve. Refuse.
            continue
        score, _date_rank, side_min, bout, inverted = best
        if side_min < MIN_SIDE_SIMILARITY:
            continue
        # Map bfo A/B → db A/B taking the inversion into account.
        cons_a = m.consensus_a_decimal if not inverted else m.consensus_b_decimal
        cons_b = m.consensus_b_decimal if not inverted else m.consensus_a_decimal
        n_a = m.n_books_a if not inverted else m.n_books_b
        n_b = m.n_books_b if not inverted else m.n_books_a
        if not inverted:
            meth_a = (m.method_a_ko_decimal, m.method_a_sub_decimal, m.method_a_dec_decimal)
            meth_b = (m.method_b_ko_decimal, m.method_b_sub_decimal, m.method_b_dec_decimal)
        else:
            meth_a = (m.method_b_ko_decimal, m.method_b_sub_decimal, m.method_b_dec_decimal)
            meth_b = (m.method_a_ko_decimal, m.method_a_sub_decimal, m.method_a_dec_decimal)
        out.append(
            MatchedOdds(
                bout_id=bout.bout_id,
                bfo_event_id=m.event_id,
                bfo_matchup_id=m.matchup_id,
                consensus_a_decimal=cons_a,
                consensus_b_decimal=cons_b,
                n_books_a=n_a,
                n_books_b=n_b,
                source_url=(
                    f"https://www.bestfightodds.com{event_url}"
                    if event_url
                    else f"https://www.bestfightodds.com/events/-{m.event_id}"
                ),
                quality_score=score,
                method_a_ko_decimal=meth_a[0],
                method_a_sub_decimal=meth_a[1],
                method_a_dec_decimal=meth_a[2],
                method_b_ko_decimal=meth_b[0],
                method_b_sub_decimal=meth_b[1],
                method_b_dec_decimal=meth_b[2],
            )
        )
    return out


# --- DB-side helpers ------------------------------------------------------


FETCH_BOUTS_SQL = """
SELECT
  b.id::text AS bout_id,
  e.id::text AS event_id,
  e.name AS event_name,
  e.date::date AS event_date,
  b.fighter_a_id::text,
  fa.name_en AS fighter_a_name,
  b.fighter_b_id::text,
  fb.name_en AS fighter_b_name
FROM bout b
JOIN event e ON e.id = b.event_id
JOIN fighter fa ON fa.id = b.fighter_a_id
JOIN fighter fb ON fb.id = b.fighter_b_id
WHERE e.promotion = 'ufc'
  AND b.status = 'completed'
ORDER BY e.date, b.id
"""


def fetch_all_bouts(conn) -> list[DBBout]:
    with conn.cursor() as cur:
        cur.execute(FETCH_BOUTS_SQL)
        out: list[DBBout] = []
        for row in cur.fetchall():
            out.append(
                DBBout(
                    bout_id=row[0],
                    event_id=row[1],
                    event_name=row[2],
                    event_date=row[3] if isinstance(row[3], date) else date.fromisoformat(str(row[3])),
                    fighter_a_id=row[4],
                    fighter_a_name=row[5],
                    fighter_b_id=row[6],
                    fighter_b_name=row[7],
                )
            )
        return out


def index_bouts_by_event_window(
    bouts: list[DBBout],
) -> dict[tuple[int, int, int], list[DBBout]]:
    """Bucket bouts by (year, month, day) so we can do a fast
    coarse-window lookup before fuzzy-matching names. Each bout lands
    in every bucket within ±DATE_TOLERANCE_DAYS of its event date."""
    out: dict[tuple[int, int, int], list[DBBout]] = {}
    for b in bouts:
        for offset in range(-DATE_TOLERANCE_DAYS, DATE_TOLERANCE_DAYS + 1):
            d = b.event_date + timedelta(days=offset)
            key = (d.year, d.month, d.day)
            out.setdefault(key, []).append(b)
    return out


# Method columns use COALESCE on conflict: a re-scrape of a page whose
# prop grid is missing (future cards) must not wipe lines captured
# earlier. Winner odds keep overwrite semantics here (run_backfill's
# purpose is refreshing lines; also lets a re-run repair bad values).
#
# INVARIANT — `created_at` MUST NEVER appear in the DO UPDATE SET below.
# It is the moment this bout FIRST got a sportsbook line, and it is the only
# announcement-date proxy anywhere in the schema: nothing else records when a
# fight was booked. `bout.created_at` cannot serve (stamped en masse at import)
# and `fetched_at` is deliberately overwritten every run. Adding
# `created_at = now()` here would silently collapse every lead time to zero and
# destroy accumulated history that CANNOT be reconstructed. Same invariant in
# the 6-hourly cron's upsert (scripts/scraper/scripts/08_scrape_bestfightodds.py);
# both are pinned by scripts/scraper/tests/test_odds_first_seen.py.
UPSERT_SQL = """
INSERT INTO bout_external_odds
  (bout_id, source, winner_a_decimal, winner_b_decimal,
   method_a_kotko_decimal, method_a_sub_decimal, method_a_dec_decimal,
   method_b_kotko_decimal, method_b_sub_decimal, method_b_dec_decimal,
   source_url, fetched_at)
VALUES
  (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
ON CONFLICT (bout_id, source) DO UPDATE SET
  winner_a_decimal = EXCLUDED.winner_a_decimal,
  winner_b_decimal = EXCLUDED.winner_b_decimal,
  method_a_kotko_decimal = COALESCE(EXCLUDED.method_a_kotko_decimal, bout_external_odds.method_a_kotko_decimal),
  method_a_sub_decimal   = COALESCE(EXCLUDED.method_a_sub_decimal, bout_external_odds.method_a_sub_decimal),
  method_a_dec_decimal   = COALESCE(EXCLUDED.method_a_dec_decimal, bout_external_odds.method_a_dec_decimal),
  method_b_kotko_decimal = COALESCE(EXCLUDED.method_b_kotko_decimal, bout_external_odds.method_b_kotko_decimal),
  method_b_sub_decimal   = COALESCE(EXCLUDED.method_b_sub_decimal, bout_external_odds.method_b_sub_decimal),
  method_b_dec_decimal   = COALESCE(EXCLUDED.method_b_dec_decimal, bout_external_odds.method_b_dec_decimal),
  source_url = EXCLUDED.source_url,
  fetched_at = now()
"""

# Fill-only winner semantics for the METHOD backfill: it exists to add
# method columns and must not clobber winner lines already captured by
# the 6h cron (MAX-of-books) with page medians on every run.
UPSERT_PRESERVE_WINNER_SQL = UPSERT_SQL.replace(
    "winner_a_decimal = EXCLUDED.winner_a_decimal",
    "winner_a_decimal = COALESCE(bout_external_odds.winner_a_decimal, EXCLUDED.winner_a_decimal)",
).replace(
    "winner_b_decimal = EXCLUDED.winner_b_decimal",
    "winner_b_decimal = COALESCE(bout_external_odds.winner_b_decimal, EXCLUDED.winner_b_decimal)",
)


def upsert_matched(
    conn, matched: Iterable[MatchedOdds], *, preserve_winner: bool = False
) -> int:
    rows = [
        (
            m.bout_id,
            "bestfightodds",
            m.consensus_a_decimal,
            m.consensus_b_decimal,
            m.method_a_ko_decimal,
            m.method_a_sub_decimal,
            m.method_a_dec_decimal,
            m.method_b_ko_decimal,
            m.method_b_sub_decimal,
            m.method_b_dec_decimal,
            m.source_url,
        )
        for m in matched
        if m.consensus_a_decimal is not None and m.consensus_b_decimal is not None
    ]
    if not rows:
        return 0
    sql = UPSERT_PRESERVE_WINNER_SQL if preserve_winner else UPSERT_SQL
    with conn.cursor() as cur:
        cur.executemany(sql, rows)
    conn.commit()
    return len(rows)
