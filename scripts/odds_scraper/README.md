# Vertex MMA — Opening-odds backfill

Scrapes bestfightodds.com for historical UFC opening lines and writes
them to `bout_external_odds`. Powers the `market_prob_a` feature in
the simulation model (`scripts/simulation`).

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
│   └── parser.py             # BS4 event-page parser
├── scripts/
│   └── run_backfill.py       # CLI orchestrator
└── venv/                     # (gitignored)
```
