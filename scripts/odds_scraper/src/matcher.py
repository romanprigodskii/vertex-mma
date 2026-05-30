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


def _pair_similarity(
    bfo_a: str, bfo_b: str, db_a: str, db_b: str
) -> tuple[float, bool]:
    """Score the bfo-A/bfo-B pair against the db-A/db-B pair. Returns
    (best_score, ab_inverted). Swap is needed when bestfightodds lists
    fighters in opposite order from our DB."""
    bna, bnb = normalize_name(bfo_a), normalize_name(bfo_b)
    dna, dnb = normalize_name(db_a), normalize_name(db_b)
    direct = (fuzz.ratio(bna, dna) + fuzz.ratio(bnb, dnb)) / 2
    swapped = (fuzz.ratio(bna, dnb) + fuzz.ratio(bnb, dna)) / 2
    if direct >= swapped:
        return direct, False
    return swapped, True


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


def match_matchups_to_bouts(
    matchups: Iterable[MatchupOdds],
    db_bouts: list[DBBout],
    *,
    parent_event_date: date | None = None,
    event_url: str | None = None,
) -> list[MatchedOdds]:
    """For each bfo matchup, find the best-match DBBout by combined
    name similarity + date proximity. Skips matchups with no candidate
    above the similarity threshold."""
    from .parser import american_to_decimal

    out: list[MatchedOdds] = []
    for m in matchups:
        best: tuple[float, DBBout, bool] | None = None
        for bout in db_bouts:
            # If we know the bfo event's calendar date, filter early.
            if parent_event_date is not None:
                if abs((bout.event_date - parent_event_date).days) > DATE_TOLERANCE_DAYS:
                    continue
            score, inverted = _pair_similarity(
                m.fighter_a_name,
                m.fighter_b_name,
                bout.fighter_a_name,
                bout.fighter_b_name,
            )
            if best is None or score > best[0]:
                best = (score, bout, inverted)
        if best is None or best[0] < NAME_SIMILARITY_THRESHOLD:
            continue
        score, bout, inverted = best
        # Map bfo A/B → db A/B taking the inversion into account.
        a_amer = m.consensus_a_american if not inverted else m.consensus_b_american
        b_amer = m.consensus_b_american if not inverted else m.consensus_a_american
        n_a = m.n_books_a if not inverted else m.n_books_b
        n_b = m.n_books_b if not inverted else m.n_books_a
        out.append(
            MatchedOdds(
                bout_id=bout.bout_id,
                bfo_event_id=m.event_id,
                bfo_matchup_id=m.matchup_id,
                consensus_a_decimal=american_to_decimal(a_amer),
                consensus_b_decimal=american_to_decimal(b_amer),
                n_books_a=n_a,
                n_books_b=n_b,
                source_url=(
                    f"https://www.bestfightodds.com{event_url}"
                    if event_url
                    else f"https://www.bestfightodds.com/events/-{m.event_id}"
                ),
                quality_score=score,
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


UPSERT_SQL = """
INSERT INTO bout_external_odds
  (bout_id, source, winner_a_decimal, winner_b_decimal, source_url, fetched_at)
VALUES
  (%s::uuid, %s, %s, %s, %s, now())
ON CONFLICT (bout_id, source) DO UPDATE SET
  winner_a_decimal = EXCLUDED.winner_a_decimal,
  winner_b_decimal = EXCLUDED.winner_b_decimal,
  source_url = EXCLUDED.source_url,
  fetched_at = now()
"""


def upsert_matched(conn, matched: Iterable[MatchedOdds]) -> int:
    rows = [
        (
            m.bout_id,
            "bestfightodds",
            m.consensus_a_decimal,
            m.consensus_b_decimal,
            m.source_url,
        )
        for m in matched
        if m.consensus_a_decimal is not None and m.consensus_b_decimal is not None
    ]
    if not rows:
        return 0
    with conn.cursor() as cur:
        cur.executemany(UPSERT_SQL, rows)
    conn.commit()
    return len(rows)
