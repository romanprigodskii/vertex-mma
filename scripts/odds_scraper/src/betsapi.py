"""Read BetsAPI odds payloads into pre-bell quotes, and match their bouts to ours.

Pure functions only — no network, no database — so the two things that can
silently corrupt a price feed are pinned by tests/test_betsapi.py:

1. ORIENTATION. The feed lists a bout as home v away; each book says with
   `matching_dir` whether it lists the corners the same way (1) or reversed
   (-1); and our bout has its own fighter_a / fighter_b. A price written on
   the wrong corner turns a favourite into an underdog and nothing downstream
   would notice. Both flips happen here, once, and nowhere else.

2. THE BELL. A book's last recorded price is routinely an in-play one
   (vertexboxing measured Bet365 at 1.040 before the bell and 1.006 at `end`;
   on UFC 331 Gable Steveson's `end` is stamped a minute after his listed
   start). The listed `time` of an MMA bout on this feed is that bout's own
   start, not the card's — UFC 331 runs from 21:45 on the first prelim to
   03:25 on the main event — so a quote counts only if posted before it. A
   quote that cannot be shown to be pre-bell is dropped, not kept with a flag.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone

from rapidfuzz import fuzz

from .matcher import normalize_name

SNAPSHOTS = ("start", "kickoff", "end")
# time_status 3, ended, only. The 2026-09-23 load found status 2 ("to be
# fixed") on 8 matched UFC bouts, and 6 were placeholder copies of a status-3
# bout, listed at a round 00:00 or 03:00 instead of the real start — so their
# `time` is not the bell, and a placeholder listed after the real bell would
# let in-play prices through. Dropping status 2 costs two bouts. 4 postponed,
# 5 cancelled, 99 removed are prices on bouts that did not happen that day.
HAPPENED = {"3"}


@dataclass(frozen=True)
class Quote:
    """One price, in the FEED's home/away orientation (book reversal undone)."""
    book: str
    market: str            # 'winner' | 'total_rounds'
    quoted_at: int         # unix seconds, the book's add_time
    snapshot: str          # 'move' | 'start' | 'kickoff' | 'end'
    home: float | None = None
    away: float | None = None
    line: float | None = None
    over: float | None = None
    under: float | None = None


def _od(v) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if x > 1.0 else None


def _line(v) -> float | None:
    try:
        return float(str(v).replace("+", ""))
    except (TypeError, ValueError):
        return None


def _market_quote(key: str, q: dict, book: str, snapshot: str,
                  reversed_: bool) -> Quote | None:
    """One market entry ("162_1" winner, "162_3" total rounds) → Quote."""
    try:
        t = int(q["add_time"])
    except (KeyError, TypeError, ValueError):
        return None
    if key.endswith("_1"):
        h, a = _od(q.get("home_od")), _od(q.get("away_od"))
        if h is None or a is None:
            return None
        if reversed_:
            h, a = a, h
        return Quote(book, "winner", t, snapshot, home=h, away=a)
    if key.endswith("_3"):
        o, u, ln = _od(q.get("over_od")), _od(q.get("under_od")), _line(q.get("handicap"))
        if o is None or u is None or ln is None:
            return None
        return Quote(book, "total_rounds", t, snapshot, line=ln, over=o, under=u)
    # "_2" is a handicap market whose unit the feed does not document; the raw
    # JSON keeps it, and nothing is written until someone knows what it means
    return None


def summary_quotes(summary: dict) -> list[Quote]:
    """Every book's start / kickoff / end snapshot from /v2/event/odds/summary."""
    out: list[Quote] = []
    for book, v in (summary or {}).items():
        if not isinstance(v, dict) or not isinstance(v.get("odds"), dict):
            continue
        rev = v.get("matching_dir") == -1
        for sn in SNAPSHOTS:
            snap = v["odds"].get(sn)
            if not isinstance(snap, dict):
                continue
            for key, q in snap.items():
                if isinstance(q, dict):
                    x = _market_quote(str(key), q, book, sn, rev)
                    if x is not None:
                        out.append(x)
    return out


def history_quotes(history: dict, book: str = "Bet365") -> list[Quote]:
    """Every move in /v2/event/odds (Bet365's line history)."""
    if not isinstance(history, dict):
        return []
    rev = (history.get("stats") or {}).get("matching_dir") == -1
    out: list[Quote] = []
    for key, rows in (history.get("odds") or {}).items():
        for q in rows or []:
            if isinstance(q, dict):
                x = _market_quote(str(key), q, book, "move", rev)
                if x is not None:
                    out.append(x)
    return out


def pre_bell(quotes: list[Quote], bell: int) -> list[Quote]:
    """Quotes posted strictly before the bout's listed start."""
    return [q for q in quotes if q.quoted_at < bell]


# ------------------------------------------------------------------ matching
@dataclass(frozen=True)
class OurBout:
    bout_id: str
    event_date: date
    fighter_a: str
    fighter_b: str


# Precision first, as with every other matcher here: a pair must clear the
# average AND the weaker side must clear the floor, and a bout that two of
# ours would both accept is refused, not guessed.
PAIR_MIN = 85
SIDE_MIN = 75
# The feed stamps UTC; our event.date is the card's local date. A US main event
# ends after midnight UTC (UFC 331's is 03:25 on the 20th, the card is the
# 19th); an Abu Dhabi or Perth card sits on its own date in UTC.
DATE_WINDOW = (-1, 1)


# The feed's name → ours, where the two are not spellings of each other and no
# similarity threshold should be loose enough to bridge them: fighters UFCStats
# lists under a ring name or a shortened one. Explicit and reviewed, never
# inferred — widening PAIR_MIN/SIDE_MIN to catch these would also catch the
# replacement opponents the floor exists to refuse. Each was found by the
# 2026-09-23 load as a feed bout whose other corner matched ours at >= 95 on
# the same card, and checked to be the same person.
#
# An alias is an ADDITIONAL name, never a replacement: "Chris Duncan" is both
# the Scottish lightweight (ours: Chris Duncan) and, on this feed, the English
# middleweight (ours: Christian Leroy Duncan). Both stay reachable, and the
# opponent decides which, as it does for every other bout.
ALIASES = {
    "patricio freire": "patricio pitbull",
    "lupita godinez": "loopy godinez",
    "jose mariscal": "chepe mariscal",
    "bobby green": "king green",
    "ian garry": "ian machado garry",
    "mike mathetha": "blood diamond",
    "chris duncan": "christian leroy duncan",
    "giovanna canuto": "gigi canuto",
    "zarah fairn dos santos": "zarah fairn",
    "mizuki inoue": "mizuki",
    "hayisaer maheshate": "maheshate",
    "maheshate maheshate": "maheshate",
    "igor da silva": "igor severino",
}


def _similarity(x: str, y: str) -> float:
    return max(fuzz.ratio(x, y), fuzz.token_sort_ratio(x, y))


def _name_score(feed: str, ours: str) -> float:
    """Order-insensitive: the feed writes some Korean and Chinese names
    surname-first ("Yoo Joo Sang") where UFCStats does not. A feed name with
    an alias scores as the better of its own spelling and the alias."""
    nf, no = normalize_name(feed), normalize_name(ours)
    best = _similarity(nf, no)
    if nf in ALIASES:
        best = max(best, _similarity(ALIASES[nf], no))
    return best


def pair_score(home: str, away: str, a: str, b: str) -> tuple[float, float, bool]:
    """(average, weaker side, swapped). swapped means the feed's home is our b."""
    d1, d2 = _name_score(home, a), _name_score(away, b)
    s1, s2 = _name_score(home, b), _name_score(away, a)
    if (d1 + d2) >= (s1 + s2):
        return (d1 + d2) / 2, min(d1, d2), False
    return (s1 + s2) / 2, min(s1, s2), True


@dataclass(frozen=True)
class Match:
    bout_id: str
    swapped: bool          # feed home = our fighter_b
    score: float


def match_bout(home: str, away: str, when: datetime,
               ours_by_date: dict[date, list[OurBout]]) -> Match | None:
    """The one bout of ours this feed bout is, or None."""
    d0 = when.astimezone(timezone.utc).date()
    hits: list[Match] = []
    seen: set[str] = set()
    for k in range(DATE_WINDOW[0], DATE_WINDOW[1] + 1):
        day = date.fromordinal(d0.toordinal() + k)
        for b in ours_by_date.get(day, []):
            if b.bout_id in seen:
                continue
            seen.add(b.bout_id)
            avg, side, sw = pair_score(home, away, b.fighter_a, b.fighter_b)
            if avg >= PAIR_MIN and side >= SIDE_MIN:
                hits.append(Match(b.bout_id, sw, avg))
    if len(hits) != 1:
        return None
    return hits[0]


def bout_prices(q: Quote, swapped: bool) -> tuple[float | None, float | None]:
    """A winner quote's prices on (our fighter_a, our fighter_b). The second
    and last flip: the book's reversal was undone when the quote was read."""
    return (q.away, q.home) if swapped else (q.home, q.away)
