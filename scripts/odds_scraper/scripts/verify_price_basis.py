"""Is `bout_external_odds` the OPENING line or the CLOSING line?

The question is not rhetorical: it was answered wrongly once, from the fact
that rows are written after the fight and that this package's own docstrings
used to say "opening". Reading code settled nothing; this measures it.

WHAT IT COMPARES AGAINST. Our table keeps one number per fighter per bout.
Bestfightodds' *fighter* pages keep three — `td.moneyline` renders
[open, close-low, close-high] for every bout of that fighter's career, with
the closing pair being the range across books. Both sides of a bout appear as
consecutive rows, so a single fighter page yields the opening and closing
prices for BOTH fighters, which is what makes a like-for-like de-vigged
comparison possible. Same publisher, different page, different columns: this
is not independent corroboration of bestfightodds' numbers, it is a check of
which of ITS OWN two quantities we stored. That is exactly the question.

UNITS. Everything is compared in PROBABILITY, not decimal odds. Distance in
decimal is scale-dependent — 0.9 between 4.6 and 3.7 is small, 0.9 between 1.2
and 2.1 is enormous — and quoting a mean decimal distance invites the reader
to convert it in their head and conclude the number is impossible. Both sides
are de-vigged proportionally, the same way `src/export.py` builds
`market_prob_a`, so the comparison is against the quantity the project
actually uses.

SAMPLING. Deterministic pseudo-random over every priced bout:
`ORDER BY md5(bout_id || SALT)`. The salt is fixed in this file and the draw
is taken once — no re-draws, no widening the sample after seeing a result.
Attrition is reported per reason rather than silently dropped, because
"verified on the bouts that happened to resolve" is a different claim from
"verified on a random sample".

REMATCHES. A fighter page lists every meeting of a pair. The row is accepted
only if its own printed date is within `DATE_TOL_DAYS` of the DB event date,
so the September-2026 Van-Pantoja rematch cannot answer for their December
2025 fight. (That confusion is not hypothetical — it is the bug in
`fix/odds-matcher-rematch`.)

Usage:
  cd scripts/odds_scraper && ./venv/bin/python scripts/verify_price_basis.py [N]
"""

from __future__ import annotations

import re
import statistics
import sys
import time
from datetime import date, datetime
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import httpx  # noqa: E402
from bs4 import BeautifulSoup  # noqa: E402
from rich.console import Console  # noqa: E402

from src.db import get_connection  # noqa: E402

console = Console()

SALT = "price-basis-v1"          # fixed: the draw must not move between runs
DATE_TOL_DAYS = 10               # a fighter-page row must be THIS bout
DEFAULT_N = 60
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
    "Accept": "text/html,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun",
     "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}
_ROW_DATE = re.compile(r"([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})")


def american_to_decimal(text: str) -> float | None:
    text = text.strip().replace("−", "-")
    if not re.fullmatch(r"[+-]?\d{2,5}", text):
        return None
    n = int(text)
    return 1 + n / 100 if n > 0 else 1 + 100 / abs(n)


def devig(dec_a: float, dec_b: float) -> float:
    """Proportional de-vig — the same split `src/export.py` applies."""
    qa, qb = 1 / dec_a, 1 / dec_b
    return qa / (qa + qb)


def sample_bouts(n: int) -> list[dict]:
    sql = """
        SELECT o.bout_id::text, e.date::date AS event_date,
               fa.name_en AS name_a, fb.name_en AS name_b,
               o.winner_a_decimal, o.winner_b_decimal
        FROM bout_external_odds o
        JOIN bout b ON b.id = o.bout_id
        JOIN event e ON e.id = b.event_id
        JOIN fighter fa ON fa.id = b.fighter_a_id
        JOIN fighter fb ON fb.id = b.fighter_b_id
        WHERE o.winner_a_decimal IS NOT NULL AND o.winner_b_decimal IS NOT NULL
        ORDER BY md5(o.bout_id::text || %s)
        LIMIT %s
    """
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(sql, (SALT, n))
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r, strict=True)) for r in cur.fetchall()]


def _row_date(text: str) -> date | None:
    m = _ROW_DATE.search(text)
    if m is None:
        return None
    month = _MONTHS.get(m.group(1)[:3].lower())
    if month is None:
        return None
    try:
        return date(int(m.group(3)), month, int(m.group(2)))
    except ValueError:
        return None


def fighter_rows(html: str) -> list[tuple[str, list[float], date | None]]:
    """(name, [open, close_lo, close_hi] as decimals, row date) per row."""
    out = []
    for tr in BeautifulSoup(html, "html.parser").select("tr"):
        th = tr.find("th")
        if th is None:
            continue
        cells = [td.get_text(strip=True) for td in tr.select("td.moneyline")]
        if len(cells) < 3:
            continue
        decs = [american_to_decimal(c) for c in cells[:3]]
        if any(d is None for d in decs):
            continue
        a = th.find("a")
        name = (a.get_text(strip=True) if a else th.get_text(strip=True))
        out.append((name, decs, _row_date(tr.get_text(" ", strip=True))))
    return out


def norm(name: str) -> str:
    return re.sub(r"[^a-z]", "", name.lower())


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_N
    bouts = sample_bouts(n)
    console.log(f"drew {len(bouts)} bouts (salt {SALT!r})")

    client = httpx.Client(timeout=30, headers=HEADERS, follow_redirects=False)
    client.get("https://www.bestfightodds.com/")
    time.sleep(1.0)
    page_cache: dict[str, str | None] = {}
    rows, drops = [], {}

    def drop(reason: str) -> None:
        drops[reason] = drops.get(reason, 0) + 1

    for i, b in enumerate(bouts, start=1):
        key = norm(b["name_a"])
        if key not in page_cache:
            try:
                search = client.get(
                    "https://www.bestfightodds.com/search?query="
                    + b["name_a"].replace(" ", "+")
                )
                time.sleep(1.0)
                links = re.findall(r'href="(/fighters/[^"]+)"', search.text)
                want = norm(b["name_a"])
                link = next(
                    (l for l in links if norm(l.split("/")[-1].rsplit("-", 1)[0]) == want),
                    links[0] if links else None,
                )
                if link is None:
                    page_cache[key] = None
                else:
                    page = client.get(
                        "https://www.bestfightodds.com" + link,
                        headers={"Referer": str(search.url)},
                    )
                    time.sleep(1.0)
                    page_cache[key] = page.text if page.status_code == 200 else None
            except httpx.HTTPError:
                page_cache[key] = None
        html = page_cache[key]
        if html is None:
            drop("fighter page not reachable")
            continue

        parsed = fighter_rows(html)
        pair = None
        for j in range(len(parsed) - 1):
            names = {norm(parsed[j][0]), norm(parsed[j + 1][0])}
            if norm(b["name_a"]) in names and norm(b["name_b"]) in names:
                when = parsed[j][2] or parsed[j + 1][2]
                if when is None:
                    continue
                if abs((when - b["event_date"]).days) <= DATE_TOL_DAYS:
                    pair = (parsed[j], parsed[j + 1])
                    break
        if pair is None:
            drop("no dated row for this bout (rematch guard / not listed)")
            continue

        (n1, d1, _), (n2, d2, _) = pair
        if norm(n1) == norm(b["name_a"]):
            side_a, side_b = d1, d2
        else:
            side_a, side_b = d2, d1

        p_ours = devig(float(b["winner_a_decimal"]), float(b["winner_b_decimal"]))
        p_open = devig(side_a[0], side_b[0])
        p_close = devig((side_a[1] + side_a[2]) / 2, (side_b[1] + side_b[2]) / 2)
        rows.append({
            "date": b["event_date"], "bout": f"{b['name_a']} v {b['name_b']}",
            "p_ours": p_ours, "p_open": p_open, "p_close": p_close,
            "d_open": abs(p_ours - p_open), "d_close": abs(p_ours - p_close),
        })
        if i % 10 == 0:
            console.log(f"  {i}/{len(bouts)} — resolved {len(rows)}")

    client.close()

    print(f"\n{'date':11s} {'bout':42s} {'p_ours':>7} {'p_open':>7} {'p_close':>8}"
          f" {'|d_open|':>9} {'|d_close|':>10}")
    for r in sorted(rows, key=lambda r: r["date"]):
        print(f"{str(r['date']):11s} {r['bout'][:42]:42s} {r['p_ours']:7.3f} "
              f"{r['p_open']:7.3f} {r['p_close']:8.3f} {r['d_open']:9.3f} {r['d_close']:10.3f}")

    if not rows:
        print("\nnothing resolved")
        return
    do = [r["d_open"] for r in rows]
    dc = [r["d_close"] for r in rows]
    closer = sum(1 for r in rows if r["d_close"] < r["d_open"])
    print(f"\nresolved {len(rows)} of {len(bouts)} drawn")
    for reason, k in sorted(drops.items(), key=lambda kv: -kv[1]):
        print(f"  dropped {k:3d}  {reason}")
    print(f"\nmean   |p_ours − p_open| = {statistics.mean(do):.4f}"
          f"   |p_ours − p_close| = {statistics.mean(dc):.4f}")
    print(f"median |p_ours − p_open| = {statistics.median(do):.4f}"
          f"   |p_ours − p_close| = {statistics.median(dc):.4f}")
    print(f"closer to the CLOSE in {closer}/{len(rows)} bouts")
    print(f"mean |p_open − p_close| (how far the line actually moved) = "
          f"{statistics.mean([abs(r['p_open'] - r['p_close']) for r in rows]):.4f}")


if __name__ == "__main__":
    main()
