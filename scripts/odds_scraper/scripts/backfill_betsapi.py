"""Download the BetsAPI (api.b365api.com) MMA archive: every book's opening
and closing price per bout, and Bet365's whole line movement on UFC bouts.

Ported from vertexboxing (scripts/odds_scraper/scripts/backfill_betsapi.py),
where the same token pulled the boxing archive. This file only DOWNLOADS; it
writes raw JSON to data/betsapi/ and nothing to the database, so a reparse
never means a re-download.

  https://api.b365api.com/v3/events/ended?sport_id=162&day=YYYYMMDD   the bouts that happened
  https://api.b365api.com/v2/event/odds/summary?event_id=…            per book: start / kickoff / end
  https://api.b365api.com/v2/event/odds?event_id=…                    Bet365: every price change

What the live token showed on 2026-09-23 (UFC 331, Chikadze vs Brito):

- sport_id 162 is MMA: UFC, KSW, PFL, ONE… under one id; the league name
  ("UFC 331 - Van vs Pantoja 2") is the only promotion tag.
- the summary carries 7 books on a UFC bout (Bet365, 10Bet, BWin, CloudBet,
  VirginBet, DraftKings, FonBet), each with `start`, `kickoff` and `end`
  snapshots of "162_1" (winner), "162_2" (handicap) and "162_3" (total rounds).
- **`end` is not the close.** On boxing it was routinely an in-play price
  (1.040 before the bell, 1.006 at `end`). The close is `kickoff`, and where a
  book has none, `end` counts only if stamped before the bell.
- `/v2/event/odds` is Bet365's full history, newest first, each price with its
  `add_time`: the opening line, the close and every move between — CLV, which
  the BestFightOdds feed cannot give (see run_backfill.py).

WHAT IT COSTS. One listing call per day, one summary per bout, one history
per UFC bout. The trial ("Everything 3 Days", $8) allows 1,800 requests an
hour and the token may run out at any moment, so:

- pass 1 (`--league ufc`) lists every day and prices only UFC bouts;
- pass 2 (no `--league`) prices every other promotion from the same listing;
- both go a month at a time, NEWEST FIRST, so a dead token leaves the recent
  years complete; three straight months of listed UFC bouts with no price is
  the floor of the price archive and stops the run (`--all` goes on).

Every file is written atomically and a failed call is never cached as an
empty bout: an empty file would read as "no prices" forever.

  BETSAPI_TOKEN=… in the project's .env.local
  venv/bin/python scripts/backfill_betsapi.py --league ufc     # pass 1
  venv/bin/python scripts/backfill_betsapi.py                  # pass 2
  venv/bin/python scripts/backfill_betsapi.py --rate 3600      # a monthly plan
"""

from __future__ import annotations

import gzip
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from threading import Lock

import httpx
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parents[1]          # scripts/odds_scraper
load_dotenv(HERE.parents[1] / ".env.local")
TOKEN = os.environ.get("BETSAPI_TOKEN", "")

API = "https://api.b365api.com"
SPORT = 162                                         # MMA
CACHE = HERE / "data" / "betsapi"
EVENTS = CACHE / "events"      # one file per day: the bouts that ended on it
SUMMARY = CACHE / "summary"    # one file per bout: every book's start/kickoff/end
HISTORY = CACHE / "history"    # one file per UFC bout: Bet365's every price

START = date(2016, 9, 1)       # the archive floor BetsAPI documents
END = date.today() - timedelta(days=1)


def _arg(name: str, default: str | None = None) -> str | None:
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


# requests/hour. The trial allows 1,800; 1,700 leaves room for a probe from
# another shell without tripping TOO_MANY_REQUESTS
RATE = int(_arg("--rate", "1700"))
LEAGUE = _arg("--league")      # "ufc" for pass 1
WORKERS = 4

UFC = re.compile(r"\bufc\b|ultimate fighter", re.I)


def is_ufc(e: dict) -> bool:
    return bool(UFC.search(str((e.get("league") or {}).get("name", ""))))


def _wanted(e: dict) -> bool:
    return is_ufc(e) if LEAGUE == "ufc" else True


# ------------------------------------------------------------------ transport
_gate = Lock()
_next = [0.0]


def _pace() -> None:
    """One fleet-wide gap between calls, so four workers together stay under
    the hourly cap however long each request takes."""
    with _gate:
        now = time.monotonic()
        wait = _next[0] - now
        _next[0] = max(now, _next[0]) + 3600.0 / RATE
    if wait > 0:
        time.sleep(wait)


def get(path: str, **params) -> dict:
    """One call. Returns the body only when it says `success`, raises
    otherwise: a transient failure must not become a permanent fact."""
    params["token"] = TOKEN
    for attempt in range(6):
        _pace()
        try:
            r = httpx.get(f"{API}{path}", params=params, timeout=30)
            if r.status_code == 429:
                time.sleep(30 * (attempt + 1))
                continue
            d = r.json()
            if d.get("error") == "AUTHORIZE_FAILED":
                raise SystemExit("BETSAPI_TOKEN is missing or not valid "
                                 "(or the trial has run out)")
            if d.get("success") == 1:
                return d
            if d.get("error") == "TOO_MANY_REQUESTS":
                time.sleep(60 * (attempt + 1))
                continue
            time.sleep(3 * (attempt + 1))
        except SystemExit:
            raise
        except Exception:  # noqa: BLE001
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"no success from {path} "
                       f"{params.get('event_id') or params.get('day')}")


def _save(f: Path, obj) -> None:
    """Write, then rename: a process killed mid-write (the trial ending, a
    laptop lid) must leave no truncated file for the next run to trust."""
    tmp = f.with_suffix(".tmp")
    tmp.write_bytes(gzip.compress(json.dumps(obj).encode()))
    os.replace(tmp, f)


def load(f: Path):
    try:
        return json.loads(gzip.decompress(f.read_bytes()))
    except (OSError, EOFError, ValueError):
        return None


# -------------------------------------------------------------------- phases
def fetch_day(d: date) -> None:
    f = EVENTS / f"{d:%Y%m%d}.json.gz"
    if f.exists():
        return
    out, page = [], 1
    while page <= 100:
        r = get("/v3/events/ended", sport_id=SPORT, day=f"{d:%Y%m%d}", page=page)
        rows = r.get("results") or []
        out += rows
        pager = r.get("pager") or {}
        if not rows or pager.get("page", 0) * pager.get("per_page", 50) >= pager.get("total", 0):
            break
        page += 1
    _save(f, out)


def fetch_summary(eid: str) -> None:
    f = SUMMARY / f"{eid}.json.gz"
    if not f.exists():
        _save(f, get("/v2/event/odds/summary", event_id=eid).get("results") or {})


def fetch_history(eid: str) -> None:
    f = HISTORY / f"{eid}.json.gz"
    if not f.exists():
        _save(f, get("/v2/event/odds", event_id=eid).get("results") or {})


def priced(res) -> bool:
    """Does any book on this bout carry a winner price at any snapshot?"""
    if not isinstance(res, dict):
        return False
    for v in res.values():
        od = v.get("odds") if isinstance(v, dict) else None
        for sn in (od or {}).values():
            if isinstance(sn, dict) and any(k.endswith("_1") and isinstance(q, dict)
                                            for k, q in sn.items()):
                return True
    return False


def _run(fn, items, label: str) -> None:
    lock, n = Lock(), {"i": 0}

    def work(x):
        try:
            fn(x)
        except SystemExit:
            raise
        except Exception as e:  # noqa: BLE001
            print(f"  ! {label} {x}: {e!r}", flush=True)
        with lock:
            n["i"] += 1
            if n["i"] % 200 == 0:
                print(f"  {label} …{n['i']:,}/{len(items):,}", flush=True)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(work, items))


def main() -> None:
    for p in (EVENTS, SUMMARY, HISTORY):
        p.mkdir(parents=True, exist_ok=True)
        for f in p.glob("*.tmp"):
            f.unlink()
    for f in [*EVENTS.glob("*.json.gz"), *SUMMARY.glob("*.json.gz"),
              *HISTORY.glob("*.json.gz")]:
        if load(f) is None:
            print(f"  unreadable cache file dropped: {f.name}")
            f.unlink()
    if not TOKEN:
        raise SystemExit("set BETSAPI_TOKEN in .env.local")

    days = [END - timedelta(days=i) for i in range((END - START).days + 1)]
    listed = sum((EVENTS / f"{d:%Y%m%d}.json.gz").exists() for d in days)
    print(f"{len(days):,} days {START} .. {END}, {listed:,} already listed · "
          f"league={LEAGUE or 'all'} · {RATE}/h", flush=True)
    dry = 0
    for k in range(0, len(days), 30):
        month = days[k:k + 30]
        _run(fetch_day, [d for d in month
                         if not (EVENTS / f"{d:%Y%m%d}.json.gz").exists()], "days")
        bouts = []
        for d in month:
            bouts += [e for e in load(EVENTS / f"{d:%Y%m%d}.json.gz") or []
                      if e.get("id") and _wanted(e)]
        ids = list(dict.fromkeys(str(e["id"]) for e in bouts))
        ufc = list(dict.fromkeys(str(e["id"]) for e in bouts if is_ufc(e)))
        _run(fetch_summary, [i for i in ids if not (SUMMARY / f"{i}.json.gz").exists()],
             "summary")
        # Bet365's history is worth a call only where the summary shows a price
        has = {i for i in ufc if priced(load(SUMMARY / f"{i}.json.gz"))}
        _run(fetch_history, [i for i in ufc if i in has
                             and not (HISTORY / f"{i}.json.gz").exists()], "history")
        n_priced = sum(priced(load(SUMMARY / f"{i}.json.gz")) for i in ids
                       if (SUMMARY / f"{i}.json.gz").exists())
        print(f"{month[-1]} .. {month[0]}: {len(ids):,} bouts ({len(ufc):,} UFC), "
              f"{n_priced:,} priced, {len(has):,} UFC histories", flush=True)
        # the archive of EVENTS starts 2016-09, the archive of PRICES need not:
        # three months of listed UFC bouts with no price is that floor
        u_priced = len(has)
        dry = dry + 1 if (len(ufc) >= 20 and u_priced == 0) else 0
        if dry >= 3 and "--all" not in sys.argv:
            print(f"no UFC prices for three months up to {month[0]} — the price "
                  f"archive ends here; stopping (--all to continue)", flush=True)
            break


if __name__ == "__main__":
    main()
