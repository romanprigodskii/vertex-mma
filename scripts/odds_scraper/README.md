# Vertex MMA — Opening-odds backfill

Scrapes bestfightodds.com for historical UFC opening lines and writes
them to `bout_external_odds`. Powers the `market_prob_a` feature in
the simulation model (`scripts/simulation`).

Also backfills METHOD prop lines ("X wins by TKO/KO / submission /
decision") into the `method_{a,b}_{kotko,sub,dec}_decimal` columns —
see `scripts/run_method_backfill.py` below.

## Why

The simulation model's strongest individual signal would be a
sportsbook opening line — it bakes in private info (camp reports,
late injuries) that pure historical stats can't see. Pre-backfill we
had 23 rows of external odds; the model trained almost without that
input. This script discovers UFC events on bestfightodds and pulls
the per-fighter median moneyline across active books for each
matchup, then matches to bouts in our DB by date + fuzzy name.

## How it works

Direct event URLs (`/events/<id>`) redirect to the homepage on
bestfightodds — you can only fetch a page when you know its full
slug (`/events/ufc-vegas-118-4200`). To enumerate slugs we spider
fighter pages: each one lists every event that fighter appeared on,
URLs and all. Seeding with the top-N UFC fighters by total bouts and
deduping across them gives ~90% UFC event coverage with a few hundred
HTTP requests instead of brute-forcing 4,000+ IDs.

Two-phase pipeline:

  * **Discovery** — N fighter searches → N fighter-page fetches →
    set of unique `/events/<slug>-<id>` URLs (UFC only).
  * **Per-event scrape + match + upsert** — fetch each event page,
    parse the matchup table, compute consensus moneyline (median
    across sportsbook columns) for each fighter, fuzzy-match the
    pair to our bout table, upsert into `bout_external_odds`.

## Install

```bash
cd scripts/odds_scraper
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

`.env.local` at the project root must contain `DATABASE_URL`.

## Run

```bash
source venv/bin/activate

# 30 seed fighters — smoke test, ~5 min, ~1,000 rows.
python scripts/run_backfill.py 30

# 250 seed fighters — full backfill, ~20 min, ~5,000 rows.
python scripts/run_backfill.py 250
```

The backfill is idempotent — re-running upserts on `(bout_id, 'bestfightodds')`
so re-running picks up new bouts and refreshes any moved lines without
duplicating rows. Polite throttle: ~1 request/second.

## Method prop lines

Past bestfightodds event pages keep the full prop grid in HTML, so the
method book (KO/Sub/Decision per fighter) can be recovered
retroactively for backtests (`scripts/simulation/scripts/eval_method_market.py`):

```bash
source venv/bin/activate
python scripts/run_method_backfill.py                 # completed UFC events since 2025-01-01
python scripts/run_method_backfill.py --since 2024-06-01
python scripts/run_method_backfill.py --dry-run
```

Event URLs are recovered per event (stored `source_url` when it's a
real `/events/<slug>-<id>` link, else a small fighter-page discovery
bounded by BFO's chronological event ids). Discovered pages carry no
year, so writes are guarded by a majority-event filter and a
year-agnostic month/day check. Method columns COALESCE on conflict —
a page without props never wipes previously captured lines. The
6-hourly cron (`scripts/scraper/scripts/08_scrape_bestfightodds.py`)
captures the same method book for upcoming cards during fight week, so
closing method lines accumulate going forward without backfills.

## BetsAPI — every book, every move, with timestamps

A second price feed, into its own append-only table `bout_odds_quote`
(`drizzle/migrations/0100_bout_odds_quote.sql`), not into
`bout_external_odds`. Per UFC bout: up to seven books (Bet365, DraftKings,
10Bet, BWin, CloudBet, VirginBet, FonBet, Duelbits…) with an opening and a
last pre-bell price each, and Bet365's full line movement — winner and
total rounds, every quote stamped with when the book posted it. That is the
opening line and CLV, which bestfightodds' stored close cannot give.

```bash
# BETSAPI_TOKEN=… in the project's .env.local
venv/bin/python scripts/backfill_betsapi.py --league ufc   # download UFC (resumable)
venv/bin/python scripts/backfill_betsapi.py                # then every other promotion
venv/bin/python scripts/load_betsapi.py --dry-run          # match counts, no writes
venv/bin/python scripts/load_betsapi.py                    # write (append-only, re-runnable)
venv/bin/python tests/test_betsapi.py                      # corner + bell tests
```

The download writes raw JSON to `data/betsapi/` (gitignored) and nothing
else; the loader reads only that cache, so reparsing costs no calls. Only
pre-bell quotes are written — a book's last price is often in-play — so the
latest row per `(bout_id, book, market)` is that book's close:

```sql
SELECT DISTINCT ON (bout_id, book) bout_id, book, price_a, price_b, quoted_at
FROM bout_odds_quote
WHERE market = 'winner'
ORDER BY bout_id, book, quoted_at DESC;      -- ASC for the opening line
```

Checked on the first 47 shared bouts (2026-08/09): Bet365's close against
the stored bestfightodds close, de-vigged, correlates 0.997 with a mean gap of
1.4 probability points — the corners are right and no in-play price leaks in.

Contender Series and Road to UFC bouts are downloaded but not loaded:
UFCStats does not carry those cards, so no bout of ours can match them.

## After a backfill

Retrain the simulation model so the richer odds coverage flows into
the LightGBM features:

```bash
cd ../simulation
source venv/bin/activate
# bump MODEL_VERSION in src/config.py if you want a clean side-by-side
python scripts/run_train.py
python scripts/run_predict.py
```

## Layout

```
scripts/odds_scraper/
├── pyproject.toml
├── requirements.txt
├── src/
│   ├── config.py             # (none yet — kept lean)
│   ├── db.py                 # psycopg connection (reuses .env.local)
│   ├── dns_override.py       # libpq DNS workaround (shared trick)
│   ├── discovery.py          # fighter search + event harvesting
│   ├── http.py               # rate-limited httpx client
│   ├── matcher.py            # name+date fuzzy match → upsert
│   ├── betsapi.py            # BetsAPI payload → pre-bell quotes; bout matching
│   └── parser.py             # BS4 event-page parser
├── scripts/
│   ├── run_backfill.py        # CLI orchestrator (winner moneylines)
│   ├── run_method_backfill.py # method prop lines for a date window
│   ├── backfill_betsapi.py    # BetsAPI download → data/betsapi/
│   └── load_betsapi.py        # data/betsapi/ → bout_odds_quote
├── data/                     # (gitignored) BetsAPI raw cache
└── venv/                     # (gitignored)
```
