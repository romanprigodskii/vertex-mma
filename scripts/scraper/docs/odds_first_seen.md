# `bout_external_odds.created_at` — the first-seen clock

## What it is

The moment a bout **first** got a sportsbook line from bestfightodds. It is
the closest thing the schema has to a booking-announcement date: a fight
appears on the board within a day or two of being announced, so
`event.date - bout_external_odds.created_at` is a usable proxy for how much
notice the fighters had.

Nothing else in the schema can stand in for it:

| candidate | why it can't |
|---|---|
| `bout.created_at` | stamped en masse at import — 8 736 bouts share `2026-05-12`, 8 695 of them *after* their own event |
| `bout.updated_at` | rewritten unconditionally by every upsert; 90 of 96 bouts in the refresh window were touched inside 12 h with no data change |
| `bout_external_odds.fetched_at` | deliberately overwritten on every 6-hourly pass |

## The invariant

`created_at` never appears in an `ON CONFLICT ... DO UPDATE SET` clause. Both
writers depend on this and both carry a comment saying so:

* `scripts/scraper/scripts/08_scrape_bestfightodds.py` — `upsert_odds` (6-hourly cron)
* `scripts/odds_scraper/src/matcher.py` — `UPSERT_SQL` / `UPSERT_PRESERVE_WINNER_SQL` (backfill)

Pinned by `scripts/scraper/tests/test_odds_first_seen.py`, which checks both
statically (the column name must not occur in the SET clause) and against the
live DB (seed a row at 2020-01-01, upsert it, assert `created_at` held and
`fetched_at` moved). Run it after touching either upsert:

```bash
scripts/scraper/venv/bin/python scripts/scraper/tests/test_odds_first_seen.py
```

Live proof the invariant holds today: the UFC 330 main event (2026-08-15)
has `created_at = 2026-06-18` and `fetched_at = 2026-07-23` — 35 days and
~140 cron ticks apart.

We deliberately did **not** add a separate `first_seen_at` column here. It
would duplicate `created_at`, need backfilling *from* `created_at`, and leave
two invariants to defend instead of one.

## Filtering the backfill artefacts

Only rows whose first line predates their event carry lead-time information:

```sql
SELECT ...
FROM bout_external_odds o
JOIN bout  b ON b.id = o.bout_id
JOIN event e ON e.id = b.event_id
WHERE o.created_at::date < e.date::date   -- the whole filter
```

Everything else was created by a one-shot historical backfill *after* the
fight happened, so its `created_at` says when we ran a script, not when the
market opened. The two backfill spikes are plainly visible in the
`created_at` histogram:

* `2026-05-30` — 1 704 rows (`scripts/odds_scraper/scripts/run_backfill.py`)
* `2026-07-10` — 423 rows (`run_method_backfill.py`)

As of 2026-07-23 the table holds 2 215 rows (one per `(bout, 'bestfightodds')`
pair — no price history), of which the predicate keeps **96**:

| bout status | rows | lead time (days) |
|---|---|---|
| scheduled | 17 | 3 – 58 |
| completed | 77 | 3 – 53 |
| cancelled | 2 | 11 |

Granularity is per-bout, not per-card: on the 2026-07-25 event, 14 bouts carry
5 distinct `created_at` values spread over 4 days — late additions really do
show up late.

## Caveats

* A 3-day floor is an artefact of when the cron started, not of the market —
  bouts booked long before 2026-05 have no early observation to record.
* The proxy measures when *bestfightodds* posted a line, which trails the
  announcement by an unknown (probably small) amount and misses bouts that
  never get a market at all.
* This clock only runs forward from now. It is not backfillable, which is why
  the invariant above is worth a test.
