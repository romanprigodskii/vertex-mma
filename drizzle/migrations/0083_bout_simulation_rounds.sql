-- bout_simulation_rounds: Monte Carlo round-by-round distribution per
-- bout. One row per (bout, model_version). Stores both the headline
-- "method × round" matrix as a JSONB column AND a few summary
-- probabilities pre-computed for cheap UI rendering.
--
-- The JSONB shape is:
--   {
--     "n_simulations": 10000,
--     "winner_prob_a": 0.62,
--     "by_round": {
--       "1": {"ko_a": 0.04, "ko_b": 0.02, "sub_a": 0.01, "sub_b": 0.01, "carry": 0.92},
--       "2": {...},
--       ...,
--       "decision_a": 0.32, "decision_b": 0.28
--     },
--     "avg_finish_seconds": 540
--   }
--
-- Summary columns mirror the most-clicked numbers in the UI so the
-- panel doesn't have to parse JSONB per request.

CREATE TABLE IF NOT EXISTS "bout_simulation_rounds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bout_id" uuid NOT NULL,
  "model_version" text NOT NULL,
  "n_simulations" integer NOT NULL,
  -- Headline (independent of the LightGBM prob — useful sanity check).
  "mc_winner_prob_a" real NOT NULL,
  "mc_winner_prob_b" real NOT NULL,
  -- Method probabilities (sum to 1 across all six cells).
  "prob_ko_a" real NOT NULL,
  "prob_ko_b" real NOT NULL,
  "prob_sub_a" real NOT NULL,
  "prob_sub_b" real NOT NULL,
  "prob_decision_a" real NOT NULL,
  "prob_decision_b" real NOT NULL,
  -- Average finish time across sims where the bout ended early
  -- (NULL when every sim went to decision — unusual).
  "avg_finish_seconds" real,
  -- Per-round finish probability rolled up across both fighters and
  -- both methods. Round 5 prob is the chance ANY round-5 finish happens
  -- (or NULL when scheduled_rounds < 5). Sum + prob_decision = 1.
  "prob_finish_round_1" real,
  "prob_finish_round_2" real,
  "prob_finish_round_3" real,
  "prob_finish_round_4" real,
  "prob_finish_round_5" real,
  -- Full raw distribution for richer UI / debugging.
  "distribution" jsonb NOT NULL,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bout_simulation_rounds_unique"
    UNIQUE ("bout_id", "model_version")
);

DO $$ BEGIN
  ALTER TABLE "bout_simulation_rounds"
    ADD CONSTRAINT "bout_simulation_rounds_bout_id_fk"
    FOREIGN KEY ("bout_id") REFERENCES "public"."bout"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "bout_simulation_rounds_bout_idx"
  ON "bout_simulation_rounds" ("bout_id");
