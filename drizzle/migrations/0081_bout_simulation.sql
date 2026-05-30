-- bout_simulation: per-bout ML prediction written by scripts/simulation
-- (Phase 1: LightGBM winner-prediction + calibrated probability +
-- confidence label). One row per (bout_id, model_version) so re-runs
-- under a new model version create a new row instead of clobbering.

CREATE TABLE IF NOT EXISTS "bout_simulation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bout_id" uuid NOT NULL,
  "model_version" text NOT NULL,
  "prob_a" real NOT NULL,
  "prob_b" real NOT NULL,
  "predicted_winner_id" uuid,
  "confidence_label" text NOT NULL,
  "market_prob_a" real,
  "edge_a" real,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bout_simulation_unique" UNIQUE ("bout_id", "model_version")
);

DO $$ BEGIN
  ALTER TABLE "bout_simulation"
    ADD CONSTRAINT "bout_simulation_bout_id_fk"
    FOREIGN KEY ("bout_id") REFERENCES "public"."bout"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "bout_simulation"
    ADD CONSTRAINT "bout_simulation_winner_fk"
    FOREIGN KEY ("predicted_winner_id") REFERENCES "public"."fighter"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "bout_simulation_bout_idx" ON "bout_simulation" ("bout_id");
CREATE INDEX IF NOT EXISTS "bout_simulation_version_idx" ON "bout_simulation" ("model_version");
