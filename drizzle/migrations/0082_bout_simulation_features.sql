-- bout_simulation_features: per-bout SHAP attributions written alongside
-- the bout_simulation row by scripts/simulation/src/predict.py. One row
-- per (bout, model_version, feature) — typically the top N features the
-- model leaned on for that prediction (Phase 2 ships with N=8). Both
-- signed shap_value (so the UI can render direction) and abs_rank (so
-- the UI can sort + cap without re-sorting).

CREATE TABLE IF NOT EXISTS "bout_simulation_features" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bout_id" uuid NOT NULL,
  "model_version" text NOT NULL,
  "feature_name" text NOT NULL,
  "shap_value" real NOT NULL,
  "feature_value" real,
  "abs_rank" smallint NOT NULL,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bout_simulation_features_unique"
    UNIQUE ("bout_id", "model_version", "feature_name")
);

DO $$ BEGIN
  ALTER TABLE "bout_simulation_features"
    ADD CONSTRAINT "bout_simulation_features_bout_id_fk"
    FOREIGN KEY ("bout_id") REFERENCES "public"."bout"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "bout_simulation_features_bout_idx"
  ON "bout_simulation_features" ("bout_id");
CREATE INDEX IF NOT EXISTS "bout_simulation_features_bout_rank_idx"
  ON "bout_simulation_features" ("bout_id", "model_version", "abs_rank");
