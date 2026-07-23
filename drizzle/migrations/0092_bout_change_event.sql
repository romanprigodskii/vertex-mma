-- Forward-only accrual of booking circumstance.
--
-- The winner model is at parity with the closing line on selection (0.9 pp,
-- McNemar p = 0.72) and on calibration (reliability 0.00296 vs 0.00303); the
-- entire remaining gap is resolution on lopsided matchups, and three tuning
-- levers failed to close it (scripts/simulation/docs/tail_resolution.md). The
-- plausible missing INPUT is booking circumstance — short notice, replacement
-- opponent, withdrawal, missed weight — which is exactly what compromises a
-- fighter in the bucket where a mismatch looks decided on paper.
--
-- None of it is in the database and none of it is backfillable: the UFCStats
-- event page shows the card as it stands today, and our own scrape used to
-- hard-DELETE the row that proved a pulled fight ever existed. So this
-- migration adds the append-only log of removals, opponent swaps,
-- cancellations, date moves and weight-class changes, and the scraper stops
-- destroying the evidence. (bout.first_seen_at, the other half of the record,
-- lands in 0093.)
--
-- Apply with: pnpm tsx scripts/apply_bout_change_event.ts
-- (idempotent; the table is also declared in src/lib/db/schema/events.ts so
-- drizzle-kit push won't drop it.)
--
-- NOT applied with `drizzle-kit push`: six tables live in this database but
-- not in the Drizzle schema (bout_opponent_tier — 17 568 rows, prediction_event,
-- prediction_event_result, prediction_pick, fight_card, fight_card_like), so a
-- push proposes DROPPING them. Pre-existing drift, unrelated to this change,
-- but it makes an unattended push destructive. The DDL below is byte-equivalent
-- to what drizzle-kit generates from the schema declarations.

-- ---------------------------------------------------------------------------
-- bout_change_event
-- ---------------------------------------------------------------------------
-- DELIBERATELY NO FOREIGN KEYS on bout_id / event_id. Half the point of the
-- table is to outlive `DELETE FROM bout` — a removal log that cascades away
-- with the bout it documents records nothing — and the provisional-event
-- merges that drop `event` rows.
CREATE TABLE IF NOT EXISTS bout_change_event (
    -- bigserial, not a random uuid: rows are deduped against the LAST one
    -- written for a (bout, kind), and insertion order is the only ordering
    -- that a backdated observed_at can't perturb.
    id          bigserial PRIMARY KEY NOT NULL,
    bout_id     uuid NOT NULL,
    event_id    uuid,
    -- When the change HAPPENED (news published_at for news-sourced rows, the
    -- observation time — an upper bound — for scraped ones).
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    -- When WE wrote the row. Keeps "when did the pipeline learn this"
    -- answerable without trusting the source clock.
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    -- 'ufcstats' | 'news' | 'odds'
    source      text NOT NULL,
    -- 'bout_removed_from_card' | 'opponent_swapped' | 'status_cancelled'
    -- | 'date_moved' | 'weight_class_changed' | 'provisional_merged'
    -- Free text on purpose: starting to record a new observation should not
    -- need a migration.
    kind        text NOT NULL,
    -- Deterministic fingerprint of the CHANGE. A row is written only when this
    -- differs from the most recent row with the same (bout_id, kind): the
    -- scrape re-reads every upcoming card every 6 h, and without it an
    -- unrepaired opponent swap would log itself four times a day forever.
    signature   text NOT NULL,
    payload     jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS bout_change_event_bout_idx
    ON bout_change_event USING btree (bout_id, observed_at);
CREATE INDEX IF NOT EXISTS bout_change_event_observed_idx
    ON bout_change_event USING btree (observed_at);
-- Serves the dedupe lookup: latest row for a (bout, kind).
CREATE INDEX IF NOT EXISTS bout_change_event_dedupe_idx
    ON bout_change_event USING btree (bout_id, kind, id DESC);
