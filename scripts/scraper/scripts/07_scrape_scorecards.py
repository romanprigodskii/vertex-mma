"""
07_scrape_scorecards.py — pulls judge scorecards from mmadecisions.com for
UFC bouts that ended in decision and don't yet have a mmadecisions_id
assigned. Writes to the bout_scorecard table; sets bout.mmadecisions_id
on success.

URL shape (probed Wave 28):
  - Year index:   https://mmadecisions.com/decisions-by-event/{year}/
                  Rows of <tr class="decision">: date + event link + count.
                  Event link: href="event/{id}/{slug}"
  - Event page:   https://mmadecisions.com/event/{id}/{slug}
                  Decision links: href="decision/{id}/{Fighter-A-vs-Fighter-B}"
  - Decision pg:  https://mmadecisions.com/decision/{id}/{slug}
                  Three <td class="judge"> blocks, each containing:
                    * <a href="judge/{id}/{name}">{Name}</a>  → judge_name
                    * <tr class="top-row"> with two <td class="top-cell">
                      <b>{LastName}</b></td>  → column headers (lastA, lastB)
                    * <tr class="decision"> rows with three <td class="list">
                      cells: round-number, scoreA, scoreB
                    * <tr class="bottom-row"> with TOTAL summary (ignored;
                      we sum from rounds ourselves)

Matching strategy:
  1. Walk year indices for years that cover unscored decision bouts.
  2. For each local UFC event with unscored decision bouts, find its
     mmadecisions counterpart by ±2-day date match + UFC name detection
     (event name contains "UFC").
  3. For each local decision bout in that event, find the matching
     decision URL by checking that BOTH fighter last-names appear in the
     URL slug.
  4. Parse the decision page; for each judge block, map the two column
     last-names back to fighter_a_id / fighter_b_id; insert rows.

Resumable via .checkpoint_scorecards.json (set of bout uuid strings that
have been processed — either persisted or marked no-data).

CLI:
  --dry-run    parse but don't write
  --limit N    process first N candidate bouts
"""

from __future__ import annotations

import argparse
import json
import re
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import _path  # noqa: F401

import psycopg
from rich.progress import BarColumn, Progress, TextColumn, TimeElapsedColumn
from selectolax.parser import HTMLParser, Node

from src.db import get_connection
from src.http import Client
from src.utils.logger import log, record_parse_error

MMAD_BASE = "https://mmadecisions.com"
CHECKPOINT_PATH = Path(__file__).resolve().parents[1] / ".checkpoint_scorecards.json"
CHECKPOINT_EVERY_BOUTS = 25
RATE_LIMIT_SECONDS = 1.0

DECISION_METHODS = (
    "decision_unanimous",
    "decision_split",
    "decision_majority",
)


def _load_checkpoint() -> set[str]:
    if not CHECKPOINT_PATH.exists():
        return set()
    try:
        return set(json.loads(CHECKPOINT_PATH.read_text(encoding="utf-8")))
    except Exception:
        return set()


def _save_checkpoint(done: set[str]) -> None:
    CHECKPOINT_PATH.write_text(json.dumps(sorted(done)), encoding="utf-8")


def _normalize_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("\xa0", " ")).strip()


def _slugify_token(token: str) -> str:
    """Lower-case, strip accents to ASCII-ish, collapse non-alphanum to nothing.
    Used for fuzzy matching of fighter last-names against URL slugs and HTML
    column headers (which strip diacritics inconsistently)."""
    import unicodedata

    nfkd = unicodedata.normalize("NFKD", token)
    ascii_only = "".join(c for c in nfkd if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", ascii_only.lower())


def _last_name(full_name: str) -> str:
    parts = [p for p in re.split(r"\s+", full_name.strip()) if p]
    if not parts:
        return ""
    # 'St-Pierre' / 'Du Plessis' / 'Van Buren' → take the last token; matching
    # against URL slugs is forgiving (also tries the full surname compound).
    return parts[-1]


def _surname_alternates(full_name: str) -> list[str]:
    """Return candidate surname tokens to try matching. Handles multi-word
    surnames like 'Du Plessis' or 'St-Pierre' which mmadecisions sometimes
    abbreviates to just the last word and other times keeps full."""
    parts = [p for p in re.split(r"\s+", full_name.strip()) if p]
    if not parts:
        return []
    out = [parts[-1]]
    if len(parts) >= 3:
        out.append(parts[-2] + parts[-1])  # 'Du Plessis' → 'duplessis'
        out.append(parts[-2] + " " + parts[-1])
    return out


# ─────────────────────────────────────────────────────────────────────────
# DB queries
# ─────────────────────────────────────────────────────────────────────────


def _bouts_to_score(conn: psycopg.Connection, limit: int | None) -> list[dict]:
    """Decision bouts on UFC events that don't yet have a mmadecisions_id."""
    sql = """
        SELECT
            b.id::text AS bout_id,
            b.event_id::text AS event_id,
            e.date::date::text AS event_date,
            e.name AS event_name,
            fa.id::text AS fighter_a_id,
            fb.id::text AS fighter_b_id,
            fa.name_en AS fighter_a_name,
            fb.name_en AS fighter_b_name
        FROM bout b
        JOIN event e ON e.id = b.event_id
        JOIN fighter fa ON fa.id = b.fighter_a_id
        JOIN fighter fb ON fb.id = b.fighter_b_id
        WHERE b.status = 'completed'
          AND b.method::text = ANY(%s)
          AND b.mmadecisions_id IS NULL
          AND e.promotion::text = 'ufc'
          AND e.date IS NOT NULL
        ORDER BY e.date DESC
    """
    if limit is not None:
        sql += " LIMIT %s"
    with conn.cursor() as cur:
        if limit is not None:
            cur.execute(sql, (list(DECISION_METHODS), limit))
        else:
            cur.execute(sql, (list(DECISION_METHODS),))
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


# ─────────────────────────────────────────────────────────────────────────
# Year index → events
# ─────────────────────────────────────────────────────────────────────────


_DATE_FORMATS = ("%b %d, %Y", "%B %d, %Y")


def _parse_year_index(html: str, year: int) -> list[dict]:
    """Returns [{date: YYYY-MM-DD, event_id, slug, name}, ...] for an mmad
    year-index page. Each <tr class="decision"> has the date, event link,
    and a count (ignored)."""
    out: list[dict] = []
    tree = HTMLParser(html)
    for tr in tree.css("tr.decision"):
        tds = tr.css("td")
        if len(tds) < 2:
            continue
        date_text = _normalize_ws(tds[0].text(strip=True))
        link = tds[1].css_first("a")
        if not link:
            continue
        href = link.attributes.get("href", "")
        # href shape "event/{id}/{slug}"
        m = re.match(r"event/(\d+)/(.+?)\s*$", href, re.S)
        if not m:
            continue
        event_id, slug = m.group(1), m.group(2).strip()
        # parse "Dec 07, 2024"
        date_iso: Optional[str] = None
        for fmt in _DATE_FORMATS:
            try:
                date_iso = datetime.strptime(date_text, fmt).strftime("%Y-%m-%d")
                break
            except ValueError:
                continue
        if date_iso is None:
            continue
        if int(date_iso[:4]) != year:
            # mmad sometimes lists boundary events; we'll see them on the
            # neighbouring-year pages too. Skip here.
            continue
        out.append(
            {
                "date": date_iso,
                "event_id": event_id,
                "slug": slug,
                "name": _normalize_ws(link.text(strip=True)),
            }
        )
    return out


# ─────────────────────────────────────────────────────────────────────────
# Event page → decisions
# ─────────────────────────────────────────────────────────────────────────


def _parse_event_decisions(html: str) -> list[dict]:
    """Decision URLs on an mmad event page. Each href="decision/{id}/{slug}"
    appears in a list cell. The slug is "Fighter-A-vs-Fighter-B"."""
    out: list[dict] = []
    seen: set[str] = set()
    for m in re.finditer(r'href="decision/(\d+)/([^"]+)"', html):
        decision_id, slug = m.group(1), m.group(2)
        # mmadecisions' HTML has literal CR/LF inside href attribute values
        # (e.g. `href="decision/16103/Strickland-vs-Chimaev\r\n">`). Strip
        # any whitespace before storing — otherwise the URL we build later
        # contains a stray \r and httpx rejects it.
        slug = slug.strip()
        if decision_id in seen:
            continue
        seen.add(decision_id)
        # Slug splits at '-vs-' (note: dashes inside names too).
        parts = slug.split("-vs-", 1)
        if len(parts) != 2:
            continue
        out.append(
            {
                "decision_id": decision_id,
                "slug": slug,
                "slug_a": parts[0],
                "slug_b": parts[1],
            }
        )
    return out


# ─────────────────────────────────────────────────────────────────────────
# Decision page → judge cards
# ─────────────────────────────────────────────────────────────────────────


JUDGE_HREF_RE = re.compile(r'href="judge/\d+/([^"]+)"')


def _parse_scorecards(html: str) -> list[dict]:
    """Returns a list of judge cards, each:
      {
        "judge_name": "Adalaide Byrd",
        "col_a_last": "Gane",    # lower-cased, alpha-only
        "col_b_last": "Volkov",
        "rounds": [(round, scoreA, scoreB), ...],
      }
    Three judges per page (occasionally 2 if a panel had a recusal — we
    accept whatever count parses cleanly)."""
    out: list[dict] = []
    tree = HTMLParser(html)
    # Each judge block sits in a <td class="judge"> wrapper containing
    # the anchor and the round/score table. Walk by <a href="judge/..."> as
    # the anchor point and then read the surrounding table.
    for anchor in tree.css('a[href^="judge/"]'):
        href = anchor.attributes.get("href", "")
        m = JUDGE_HREF_RE.search(f'href="{href}"')
        if not m:
            continue
        # Climb up to the enclosing <table> that holds this judge's rounds.
        # Structure on the page: judge anchor sits in <td class="judge"> of
        # a <table>, and that same table has the top-row + decision rows +
        # bottom-row.
        table = anchor
        while table is not None and table.tag != "table":
            table = table.parent
        if table is None:
            continue

        # Column header last-names — first <tr class="top-row"> after the
        # judge anchor.
        col_a_last: Optional[str] = None
        col_b_last: Optional[str] = None
        for tr in table.css("tr.top-row"):
            top_cells = tr.css("td.top-cell")
            if len(top_cells) >= 2:
                col_a_last = _slugify_token(top_cells[0].text(strip=True))
                col_b_last = _slugify_token(top_cells[1].text(strip=True))
                break
        if not col_a_last or not col_b_last:
            continue

        # Round rows.
        rounds: list[tuple[int, int, int]] = []
        for tr in table.css("tr.decision"):
            tds = tr.css("td.list")
            if len(tds) < 3:
                continue
            try:
                rnd = int(_normalize_ws(tds[0].text(strip=True)))
                a = int(_normalize_ws(tds[1].text(strip=True)))
                b = int(_normalize_ws(tds[2].text(strip=True)))
            except (ValueError, IndexError):
                continue
            rounds.append((rnd, a, b))
        if not rounds:
            continue

        judge_name = _normalize_ws(anchor.text(strip=True))
        out.append(
            {
                "judge_name": judge_name,
                "col_a_last": col_a_last,
                "col_b_last": col_b_last,
                "rounds": rounds,
            }
        )
    return out


# ─────────────────────────────────────────────────────────────────────────
# Matching + insertion
# ─────────────────────────────────────────────────────────────────────────


def _match_decision_for_bout(
    decisions: list[dict],
    fighter_a_name: str,
    fighter_b_name: str,
) -> Optional[dict]:
    """Return the decision dict whose slug contains BOTH fighters' last
    names (in some surname-alternate form). Order-agnostic."""
    a_alts = [_slugify_token(s) for s in _surname_alternates(fighter_a_name)]
    b_alts = [_slugify_token(s) for s in _surname_alternates(fighter_b_name)]
    for d in decisions:
        sa = _slugify_token(d["slug_a"])
        sb = _slugify_token(d["slug_b"])
        # Match if (sa contains an a-alt AND sb contains a b-alt) OR the
        # mirrored ordering.
        if (any(alt in sa for alt in a_alts) and any(alt in sb for alt in b_alts)) or (
            any(alt in sb for alt in a_alts) and any(alt in sa for alt in b_alts)
        ):
            return d
    return None


def _insert_scorecards(
    conn: psycopg.Connection,
    *,
    bout_id: str,
    decision_id: str,
    source_url: str,
    judges: list[dict],
    fighter_a_name: str,
    fighter_b_name: str,
    dry_run: bool,
) -> int:
    """Insert per-(bout, judge, round) rows. Sets bout.mmadecisions_id even
    on dry-run? — no: dry-run writes nothing. Returns rows inserted."""
    if not judges:
        return 0
    a_alts = [_slugify_token(s) for s in _surname_alternates(fighter_a_name)]
    b_alts = [_slugify_token(s) for s in _surname_alternates(fighter_b_name)]

    rows: list[tuple] = []
    for j in judges:
        # Decide whether the judge's col A is our fighter_a or fighter_b.
        col_a = j["col_a_last"]
        col_b = j["col_b_last"]
        a_is_a = any(alt and alt in col_a for alt in a_alts) or any(
            col_a and col_a in alt for alt in a_alts
        )
        b_is_a = any(alt and alt in col_b for alt in a_alts) or any(
            col_b and col_b in alt for alt in a_alts
        )
        # Fall back: if exactly one column matches a-alt, that wins.
        if a_is_a == b_is_a:
            # Try the b-side: see which column matches the B fighter's surname.
            a_is_b = any(alt and alt in col_a for alt in b_alts)
            b_is_b = any(alt and alt in col_b for alt in b_alts)
            if a_is_b and not b_is_b:
                swap = True
            elif b_is_b and not a_is_b:
                swap = False
            else:
                log.warning(
                    f"bout {bout_id} judge {j['judge_name']}: cannot map columns "
                    f"({col_a},{col_b}) to fighters ({fighter_a_name},{fighter_b_name}) — skip"
                )
                continue
        else:
            swap = b_is_a  # col B is our fighter A → swap A/B scores
        for rnd, sa, sb in j["rounds"]:
            score_a = sb if swap else sa
            score_b = sa if swap else sb
            rows.append((bout_id, j["judge_name"], rnd, score_a, score_b, source_url))

    if dry_run:
        for r in rows:
            log.info(f"[DRY] bout_scorecard {r}")
        return len(rows)

    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO bout_scorecard (
                bout_id, judge_name, round, fighter_a_score, fighter_b_score, source_url
            ) VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT ON CONSTRAINT bout_scorecard_unique DO NOTHING
            """,
            rows,
        )
        cur.execute(
            "UPDATE bout SET mmadecisions_id = %s WHERE id = %s::uuid AND mmadecisions_id IS NULL",
            (decision_id, bout_id),
        )
    return len(rows)


# ─────────────────────────────────────────────────────────────────────────
# Main run
# ─────────────────────────────────────────────────────────────────────────


def _group_by_event(bouts: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for b in bouts:
        grouped[b["event_id"]].append(b)
    return grouped


def _years_to_walk(bouts: list[dict]) -> list[int]:
    years: set[int] = set()
    for b in bouts:
        # event_date is YYYY-MM-DD
        years.add(int(b["event_date"][:4]))
    return sorted(years, reverse=True)


def _find_mmad_event(
    year_events: list[dict],
    event_date: str,
    event_name: str,
) -> Optional[dict]:
    """±2-day date window + name containing 'UFC'."""
    target = datetime.strptime(event_date, "%Y-%m-%d").date()
    is_ufc = "UFC" in event_name.upper()
    best: Optional[tuple[int, dict]] = None  # (day-distance, row)
    for ye in year_events:
        try:
            d = datetime.strptime(ye["date"], "%Y-%m-%d").date()
        except ValueError:
            continue
        delta = abs((d - target).days)
        if delta > 2:
            continue
        if is_ufc and "UFC" not in ye["name"].upper():
            continue
        if best is None or delta < best[0]:
            best = (delta, ye)
    return best[1] if best else None


def run(*, limit: int | None = None, dry_run: bool = False) -> dict:
    done = _load_checkpoint()
    totals = {
        "processed": 0,
        "errors": 0,
        "rows_inserted": 0,
        "no_match": 0,
        "no_data": 0,
    }

    with Client(rate_limit_seconds=RATE_LIMIT_SECONDS) as http, get_connection() as conn:
        bouts = _bouts_to_score(conn, limit=limit)
        bouts = [b for b in bouts if b["bout_id"] not in done]
        log.info(
            f"phase 7: {len(bouts)} unscored UFC decision bouts to process "
            f"(checkpointed: {len(done)})"
        )
        if not bouts:
            return totals

        # Pre-fetch each needed year index, then per-event pages, only once.
        years = _years_to_walk(bouts)
        year_cache: dict[int, list[dict]] = {}
        for y in years:
            try:
                html = http.get(f"{MMAD_BASE}/decisions-by-event/{y}/")
                year_cache[y] = _parse_year_index(html, y)
                log.info(f"year {y}: {len(year_cache[y])} mmad events listed")
            except Exception as exc:  # noqa: BLE001
                log.error(f"year {y}: index fetch failed: {exc!r}")
                year_cache[y] = []

        grouped = _group_by_event(bouts)
        event_decision_cache: dict[str, list[dict]] = {}

        with Progress(
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("[cyan]{task.completed}/{task.total}[/]"),
            TimeElapsedColumn(),
        ) as progress:
            task = progress.add_task("Scorecards", total=len(bouts))

            for event_id, event_bouts in grouped.items():
                head = event_bouts[0]
                year = int(head["event_date"][:4])
                mmad_event = _find_mmad_event(
                    year_cache.get(year, []),
                    head["event_date"],
                    head["event_name"],
                )
                if mmad_event is None:
                    # Try ±1 year for boundary cases.
                    for adj in (year - 1, year + 1):
                        mmad_event = _find_mmad_event(
                            year_cache.get(adj, []),
                            head["event_date"],
                            head["event_name"],
                        )
                        if mmad_event:
                            break
                if mmad_event is None:
                    log.warning(
                        f"event {head['event_name']} ({head['event_date']}): no mmad match"
                    )
                    for b in event_bouts:
                        totals["no_match"] += 1
                        done.add(b["bout_id"])
                        progress.advance(task)
                    continue

                event_url = f"{MMAD_BASE}/event/{mmad_event['event_id']}/{mmad_event['slug']}"
                decisions = event_decision_cache.get(mmad_event["event_id"])
                if decisions is None:
                    try:
                        html = http.get(event_url)
                        decisions = _parse_event_decisions(html)
                        event_decision_cache[mmad_event["event_id"]] = decisions
                    except Exception as exc:  # noqa: BLE001
                        log.error(f"event {event_url}: fetch failed: {exc!r}")
                        decisions = []
                        event_decision_cache[mmad_event["event_id"]] = decisions

                for b in event_bouts:
                    bout_id = b["bout_id"]
                    decision = _match_decision_for_bout(
                        decisions, b["fighter_a_name"], b["fighter_b_name"]
                    )
                    if decision is None:
                        totals["no_match"] += 1
                        done.add(bout_id)
                        progress.advance(task)
                        continue
                    decision_url = (
                        f"{MMAD_BASE}/decision/{decision['decision_id']}/{decision['slug']}"
                    )
                    try:
                        html = http.get(decision_url)
                        judges = _parse_scorecards(html)
                    except Exception as exc:  # noqa: BLE001
                        totals["errors"] += 1
                        record_parse_error(
                            url=decision_url,
                            kind="scorecard",
                            message=repr(exc),
                            extra={"bout_id": bout_id},
                        )
                        log.error(f"decision {decision_url}: parse failed: {exc!r}")
                        progress.advance(task)
                        continue

                    if not judges:
                        totals["no_data"] += 1
                        done.add(bout_id)
                        progress.advance(task)
                        continue

                    try:
                        n = _insert_scorecards(
                            conn,
                            bout_id=bout_id,
                            decision_id=decision["decision_id"],
                            source_url=decision_url,
                            judges=judges,
                            fighter_a_name=b["fighter_a_name"],
                            fighter_b_name=b["fighter_b_name"],
                            dry_run=dry_run,
                        )
                        totals["rows_inserted"] += n
                        if not dry_run:
                            conn.commit()
                        done.add(bout_id)
                        totals["processed"] += 1
                    except psycopg.OperationalError as exc:
                        # Supabase pooler kills long-idle session connections
                        # after ~8 min of URL-only crawl phases. Reconnect and
                        # retry the bout once before giving up.
                        log.warning(
                            f"db connection lost ({exc!r}) — reconnecting and retrying bout {bout_id}"
                        )
                        try:
                            conn.close()
                        except Exception:
                            pass
                        conn = get_connection()
                        try:
                            n = _insert_scorecards(
                                conn,
                                bout_id=bout_id,
                                decision_id=decision["decision_id"],
                                source_url=decision_url,
                                judges=judges,
                                fighter_a_name=b["fighter_a_name"],
                                fighter_b_name=b["fighter_b_name"],
                                dry_run=dry_run,
                            )
                            totals["rows_inserted"] += n
                            if not dry_run:
                                conn.commit()
                            done.add(bout_id)
                            totals["processed"] += 1
                        except Exception as retry_exc:  # noqa: BLE001
                            try:
                                conn.rollback()
                            except Exception:
                                pass
                            totals["errors"] += 1
                            record_parse_error(
                                url=decision_url,
                                kind="scorecard_insert_retry",
                                message=repr(retry_exc),
                                extra={"bout_id": bout_id},
                            )
                            log.error(
                                f"bout {bout_id} retry after reconnect failed: {retry_exc!r}"
                            )
                    except Exception as exc:  # noqa: BLE001
                        try:
                            conn.rollback()
                        except Exception:
                            pass
                        totals["errors"] += 1
                        record_parse_error(
                            url=decision_url,
                            kind="scorecard_insert",
                            message=repr(exc),
                            extra={"bout_id": bout_id},
                        )
                        log.error(f"bout {bout_id} insert failed: {exc!r}")

                    progress.advance(task)

                    if totals["processed"] % CHECKPOINT_EVERY_BOUTS == 0:
                        _save_checkpoint(done)

        _save_checkpoint(done)

    log.info(
        f"phase 7 scorecards: processed={totals['processed']} "
        f"rows_inserted={totals['rows_inserted']} "
        f"no_match={totals['no_match']} no_data={totals['no_data']} "
        f"errors={totals['errors']}"
    )
    return totals


def main() -> int:
    parser = argparse.ArgumentParser(description="Scrape mmadecisions.com scorecards.")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    run(limit=args.limit, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
