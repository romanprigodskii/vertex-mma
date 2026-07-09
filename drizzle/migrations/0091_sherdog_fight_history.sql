-- Sherdog full-career fight history — closes the pre-UFC information gap.
--
-- The debut segment was the model's weakest spot (market ~75% vs our ~59%):
-- bookmakers see a debutant's 15-0 regional record, we saw NaN. This table
-- stores each fighter's complete Sherdog pro fight history; the sim
-- pipeline derives point-in-time pre-UFC features (record, finish rates,
-- career length) from the is_ufc=false rows. Fighter-level match/sync
-- bookkeeping lives on two new fighter columns.
--
-- Populated exclusively by scripts/scraper/scripts/17_scrape_sherdog.py
-- (delete-and-reinsert per fighter — Sherdog rows have no natural key).
--
-- Apply with: pnpm tsx scripts/apply_sherdog_history.ts
-- (idempotent; also declared in src/lib/db/schema/fighters.ts so
-- drizzle-kit push won't drop it)

ALTER TABLE fighter ADD COLUMN IF NOT EXISTS sherdog_match_status text;
ALTER TABLE fighter ADD COLUMN IF NOT EXISTS sherdog_synced_at timestamptz;

CREATE TABLE IF NOT EXISTS fighter_sherdog_bout (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fighter_id uuid NOT NULL REFERENCES fighter(id) ON DELETE CASCADE,
  result text NOT NULL,
  opponent_name text NOT NULL,
  opponent_sherdog_id text,
  event_name text NOT NULL,
  event_date date,
  method text,
  method_class text,
  round smallint,
  time_seconds integer,
  is_ufc boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fighter_sherdog_bout_fighter_idx
  ON fighter_sherdog_bout (fighter_id);
CREATE INDEX IF NOT EXISTS fighter_sherdog_bout_fighter_date_idx
  ON fighter_sherdog_bout (fighter_id, event_date);
