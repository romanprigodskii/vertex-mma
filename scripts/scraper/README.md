# Vertex MMA — UFC Stats Scraper

Pulls fighters, events, bouts, and per-round bout statistics from `ufcstats.com` and writes them into the Vertex MMA Postgres schema.

## Setup

```bash
cd scripts/scraper
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

The scraper reads `DATABASE_URL` from `../../.env.local`, so make sure the project root `.env.local` is populated (see the root README's *Database setup* section).

## Usage

```bash
# All phases in order (quick + enrich), ~60–90 min total.
./venv/bin/python scripts/run_all.py --phase all

# Just the quick phases (events + fighters + bouts metadata), ~5–10 min.
./venv/bin/python scripts/run_all.py --phase quick

# Only the slow enrichment phases (fighter career stats + per-round bout stats),
# ~30–60 min. Resumable via .checkpoint files.
./venv/bin/python scripts/run_all.py --phase enrich

# Individual phases.
./venv/bin/python scripts/run_all.py --phase events
./venv/bin/python scripts/run_all.py --phase fighters
./venv/bin/python scripts/run_all.py --phase bouts
./venv/bin/python scripts/run_all.py --phase enrich-fighters
./venv/bin/python scripts/run_all.py --phase enrich-bouts

# Smoke test: parse first 5 items per phase without writing to the DB.
./venv/bin/python scripts/run_all.py --phase quick --limit 5 --dry-run

# Small real run for verification.
./venv/bin/python scripts/run_all.py --phase quick --limit 20
```

## Resumability

Phases 4 and 5 write a checkpoint file (`.checkpoint_fighters.json`, `.checkpoint_bouts.json`) every 50 / 100 items. Re-running picks up where the previous run left off. Delete the file to force a full re-enrich.

Phases 1–3 are naturally idempotent — they upsert by `ufc_stats_id`, so re-running just refreshes existing rows.

## Etiquette

- Rate limit: 0.6 s between requests in phases 1–3, 1.0 s in enrichment phases.
- Sequential only, no parallelism.
- User-Agent identifies the scraper: `VertexMMA-Scraper/1.0`.
- Exponential backoff on 429 and 5xx (2 s → 4 s → 8 s, 3 retries total).

## Layout

```
scripts/scraper/
  requirements.txt
  pyproject.toml
  README.md
  src/
    config.py            # URLs, rate limits, retry settings
    db.py                # psycopg connection, reads .env.local
    http.py              # httpx client with retries
    parsers/             # HTML -> typed dicts (no DB)
      events.py
      event_details.py
      fighters.py
      fighter_details.py
      bout_stats.py
    loaders/             # typed dicts -> Postgres
      events.py
      fighters.py
      bout_stats.py
    utils/
      slugify.py, dates.py, methods.py, weight_classes.py,
      stance.py, countries.py, measures.py, logger.py
  scripts/
    01_scrape_events.py
    02_scrape_fighters.py
    03_scrape_bouts.py
    04_enrich_fighters.py
    05_enrich_bouts.py
    run_all.py
```

## Error log

Non-fatal parse errors are appended to `.errors.jsonl`. Each line:

```json
{"ts": "...", "url": "...", "kind": "fighter_details|bout_stats|...", "message": "..."}
```

Inspect with `jq` or `tail -f`.
