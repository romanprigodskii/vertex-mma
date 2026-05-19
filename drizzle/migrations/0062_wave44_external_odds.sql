-- Wave 44: external sportsbook odds per bout.
--
-- One row per (bout, source). Decimal odds canonical (American → decimal
-- conversion happens in the scraper). Method columns nullable because
-- bestfightodds doesn't expose stable prop IDs in plain HTML — only
-- winner moneyline is parsed in v1.
--
-- Public read; writes only via scraper / generate_markets.

CREATE TABLE IF NOT EXISTS bout_external_odds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bout_id uuid NOT NULL REFERENCES bout(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'bestfightodds',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  winner_a_decimal real,
  winner_b_decimal real,
  method_a_kotko_decimal real,
  method_a_sub_decimal real,
  method_a_dec_decimal real,
  method_b_kotko_decimal real,
  method_b_sub_decimal real,
  method_b_dec_decimal real,
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bout_external_odds_bout_idx
  ON bout_external_odds(bout_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bout_external_odds_unique'
  ) THEN
    ALTER TABLE bout_external_odds
      ADD CONSTRAINT bout_external_odds_unique UNIQUE (bout_id, source);
  END IF;
END$$;

ALTER TABLE bout_external_odds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bout_external_odds_select_all" ON bout_external_odds;
CREATE POLICY "bout_external_odds_select_all" ON bout_external_odds
  FOR SELECT USING (true);
