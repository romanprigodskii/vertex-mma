# Booking-circumstance accrual

## Why

The winner model is level with the closing line where people assume it isn't,
and behind where it's harder to see:

| basis | model | market |
|---|---|---|
| static test split (≥ 2025-01-01, order-averaged, n=568 with a line) | 0.6690 acc / 0.6198 ll | 0.6796 / 0.5968 |
| McNemar exact on that split | p = 0.72 — the accuracy difference is not established |
| reliability (calibration, lower better) | 0.00296 | 0.00303 |
| resolution (sharpness, higher better) | 0.03812 | 0.04580 |
| rolling retrain 2025-07..2026-07, main segment (n=417) | 0.6475 acc / 0.6218 ll | 0.6929 on the 394 with a line |

Calibration is at parity. The whole log-loss gap is **resolution on lopsided
matchups** — the book knows which mismatches are real and we don't. Three
attempts to close it by tuning (post-blender recalibration, blend re-selection
on the tail bucket, removing the age throttle) all failed their gate; see
`scripts/simulation/docs/tail_resolution.md`. The remaining explanation is
missing information rather than missing fitting.

The plausible missing channel is the circumstances of the booking: short
notice, a replacement opponent, a withdrawal, a missed weight. A fighter who
took the fight two weeks out is compromised exactly where the matchup looks
decided on paper — the target bucket.

**None of it is in the database, and none of it can be backfilled.** The
UFCStats event page shows the card as it stands today; a fight pulled last
month simply isn't on it. Worse, the scraper used to hard-DELETE the row that
proved the booking had ever been made. Every week without collection is a week
of future signal gone for good. Hence this: the point is not to model anything
now — there is nothing to model — but to have something to model in a year.

## What is recorded, and from where

### `bout_change_event` — append-only log

One row per observed change. `bout_id` and `event_id` are **bare uuids with no
foreign keys**: half the purpose is to survive the `DELETE FROM bout` the row
documents, and a cascade would erase each row at the moment it became the only
evidence. Join by hand and expect misses.

| kind | source | written by | payload highlights |
|---|---|---|---|
| `bout_removed_from_card` | `ufcstats` | `events._record_removed_bouts`, immediately before the card-reconcile DELETE | both fighter ids **and names**, weight class, bout order, title/main flags, event date, `days_to_event`, `first_seen_at`, `days_booked` |
| `opponent_swapped` | `ufcstats` | `events.upsert_bouts`, when the stored pair differs from the page | old and new pair (ids + names), `row_updated: false` |
| `provisional_merged` | `ufcstats` | both twin merges (`upsert_bouts`, `reconcile_duplicate_events`) | provisional bout/event ids, its `created_at` and `first_seen_at`, `first_seen_at_carried_over`, `reason` |
| `status_cancelled` | `ufcstats` | `cancel_past_scheduled_bouts`, driven off `RETURNING` | fighter ids, weight class, `reason: event_passed_without_result` |
| `status_cancelled` | `news` | `news.cancel_bout_if_provisional` | news item id, confidence, `was_provisional` |
| `weight_class_changed` | `news` | `news.update_provisional_bout` | old and new weight class |
| `date_moved` | `news` | `news.update_provisional_bout` | old and new event date, `days_shifted`, `scope: event` |
| `news_signal` | `news` | `news.record_news_signal`, from the classifier | classification, confidence, `source_is_trusted`, `acted` |

The removal payload is deliberately fat. After the DELETE there is no bout row
to join to, so anything an analysis might want has to be *in* the row.

### `bout.first_seen_at` / `event.first_seen_at`

When the booking was first observed. Nullable, **no database default**, NULL
for every row that predates the column. That is the design, not an oversight:
since Postgres 11 an `ADD COLUMN ... DEFAULT now()` materialises the default
for existing rows, which is exactly how `bout.created_at` became worthless
(8 736 bouts stamped 2026-05-12, 8 695 of them *after* their own event).

* UFCStats inserts stamp `now()` — an upper bound, since a fight announced
  between two 6-hourly scrapes is recorded up to 6 h late.
* News-created bouts and provisional cards get the announcing article's
  `published_at`. The classifier runs hourly and can pick up a backlog item
  days late, so `now()` would misdate precisely the rows whose timing matters.
* Both provisional-twin merges carry the earlier `first_seen_at` onto the
  surviving row before deleting the twin, so adoption by UFCStats can't
  downgrade a real announcement date to the date UFCStats got round to it.
* Never assigned in an `ON CONFLICT DO UPDATE SET`, and never on adoption.

### `bout_external_odds.created_at` — the pre-existing channel

Already accruing, by accident, since 2026-05: the first sportsbook line on a
bout, which trails the announcement by a little. Documented and now pinned in
`docs/odds_first_seen.md`.

## Idempotency

The bouts scrape re-reads every upcoming card every 6 hours; the news
classifier runs hourly. Writers must log **changes, not observations**, which
is what `record_change`'s `signature` is for — a fingerprint of the change,
compared before writing:

* `dedupe_scope='latest'` (default) compares against the most recent row for
  the same `(bout_id, kind)`. Right for a condition that can recur: a bout
  pulled, re-added and pulled again happened twice; an unrepaired opponent
  swap re-observed four times a day is one change.
* `dedupe_scope='any'` compares against every row for that `(bout_id, kind)`.
  Used for `news_signal`, keyed on the news item: an article reports a given
  thing exactly once however often it is reprocessed, and unlike a state it
  cannot legitimately repeat — including when another article's signal landed
  in between, which is the case a latest-row check would miss.

Ordering is by `id` (insertion order), not `observed_at`: news rows are
backdated to `published_at` and would otherwise sort behind a scrape row
written later.

## A decision worth knowing about: opponent swaps are logged, not applied

When UFCStats edits a matchup in place (same fight-details id, different
fighters) we record the swap and **leave `bout.fighter_a_id` / `fighter_b_id`
alone**. That is also what the loader has always done — those columns are
absent from the upsert's `DO UPDATE SET`, so no code path has ever written
fighters into an existing row; the change was simply ignored in silence, and
now it is ignored on the record.

The reason not to "fix" it: rewriting the fighters retro-fits a different
matchup onto a row that already carries a prediction, a market and possibly
placed bets, and the model's entire point-in-time discipline rests on rows not
changing their meaning after the fact. Repairing the row is a separate
decision with its own consequences; the log makes it possible to take that
decision later with evidence.

In practice UFCStats usually issues a NEW fight-details id for a new matchup
and drops the old one from the card, which surfaces as
`bout_removed_from_card` instead. The in-place case is the rarer one.

## Verification performed

| check | result |
|---|---|
| (a) `03_scrape_bouts.py` twice over the 21-day cron window (11 events, 90 bouts) | second run wrote **0** change rows; `bout.first_seen_at` hash unchanged; `bout_external_odds.created_at` hash unchanged. First run also wrote 0 — nothing had moved on UFCStats |
| (b) historical rows after adding the column | **0 of 8 862** bouts and **0 of 795** events have a non-null `first_seen_at` |
| (c) simulated removal | `scripts/scraper/tests/test_change_events.py` logs a removal through the real loader helper, deletes the bout, and reads the row back with its payload intact. Confirmed to FAIL ("the removal row did NOT survive") when a cascading FK is added inside the test transaction. Rolled back |
| (d) re-classifying processed news | 3 already-classified `weigh_in` items reset and re-run: first pass wrote 3 `news_signal` rows, the identical second pass wrote **0** |
| (e) `08_scrape_bestfightodds.py` | 16 bouts matched and re-upserted; `created_at` md5 over all 2 215 rows identical before and after, `fetched_at` advanced 12:01 → 13:54 |

Additional pins, all runnable against the live DB inside rolled-back
transactions:

```bash
scripts/scraper/venv/bin/python scripts/scraper/tests/test_odds_first_seen.py
scripts/scraper/venv/bin/python scripts/scraper/tests/test_first_seen_at.py
scripts/scraper/venv/bin/python scripts/scraper/tests/test_change_events.py
```

Each was verified to fail when the invariant it guards is broken (adding
`created_at` / `first_seen_at` to a `DO UPDATE SET`; adding a cascading FK).

## First real accrual

3 rows, all `news_signal` / `weigh_in`, from the acceptance run — the first
booking-circumstance records the database has ever held. No removals, swaps or
cancellations yet, which is the expected answer for a quiet 24 hours: the
scrape observed no card changes at all in the 21-day window.

## What is NOT covered

* **A missed weight is not separable from weigh-in coverage.** The classifier's
  `weigh_in` category is "weigh-in results or coverage; a fighter making or
  missing weight" — one label for both. So a `news_signal` row with
  `classification='weigh_in'` says an article about the weigh-in exists, not
  that anyone missed. Fixing this means changing the classifier prompt, which
  reclassifies the entire stream and is a much bigger decision than this
  change; left open deliberately. The cheapest honest fix later is probably a
  separate boolean field in the classifier's structured output rather than a
  new category.
* **Attribution is the binding constraint on the news channel**, not
  classification. Over the last 60 days: 62 items classified into the three
  signal categories, but only 22 (35 %) carry a `related_bout_id` and can be
  attached to anything. The rest name fighters we can't pair to a booking.
* **Date moves are recorded against one bout, event-scoped in effect.** A
  provisional card's date change shifts every fight on it; one row is written,
  against the bout whose article triggered it, with `scope: "event"`. Expand
  via `event_id` when analysing.
* **Only provisional rows are ever mutated by news.** An official UFCStats bout
  is never flipped by a headline. Those reports are recorded (`acted: false`)
  but change nothing.
* **`observed_at` from the scrape is an upper bound**, up to 6 h late.
* **Nothing reads this table.** No UI, no features, no model input. On purpose.
* **Pre-existing bouts have no `first_seen_at`.** The 68 currently-scheduled
  bouts were all booked before the column existed, so the first bouts with a
  real lead time are the ones announced from 2026-07-23 onward.

## When does this become answerable?

Measured accrual rates:

| channel | rate | notes |
|---|---|---|
| `bout_external_odds.created_at` (lead time) | ~9–10/week ≈ **480/yr** | already running since 2026-05; 96 usable rows today |
| `bout.first_seen_at` | ~500/yr | one per newly-announced bout; starts from zero now |
| `news_signal` | ~11/month ≈ **130/yr** | 35 % attribution on 62 signal items/60 days |
| removals / swaps / cancellations | **unknown** | the thing we've never been able to measure. UFC ran 45 cards / 530 bouts in the last 365 days; at 5–15 % churn that is 25–80 rows a year, and the first quarter replaces this guess with a number |

Against that, what each horizon buys:

* **3 months** — the removal rate stops being a guess. First descriptive cut:
  how often does a booked UFC fight change, how late, and does it cluster on
  particular card positions. Not a modelling question yet.
* **6 months** — ~250 bouts with a real lead time, of which perhaps 25 are
  short notice. Enough for a descriptive comparison, not enough to fit
  anything. A feature added here would be noise.
* **12–18 months** — ~500–750 bouts with a lead time, ~50–75 short-notice
  cases. A single binary `short_notice` feature becomes estimable, and the
  practical test ("does adding it improve out-of-fold log-loss on the tail
  bucket") becomes worth running. **This is the first honest attempt.**
* **3–4 years** — ~200 short-notice cases, which is what an 80 %-powered test
  of a 10 pp win-rate shift actually needs (n ≈ 7.85 · 0.25 / 0.10² ≈ 196).
  That is the horizon for *proving* the effect rather than exploiting it.

The asymmetry is the whole argument: collecting costs nothing per week, and
not collecting is unrecoverable. The 12-month mark is when the question
"is there signal in short notice" stops being unanswerable — which is why the
clock needed starting now rather than when someone wants the answer.
