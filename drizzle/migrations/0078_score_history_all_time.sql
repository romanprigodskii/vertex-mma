-- Wave 31.7+: add per-bout all-time score to the replay history.
--
-- vertex_score_all_time mirrors the Wave 53/54/55 all-time formula
-- computed AS OF each anchor bout. Nullable so legacy rows + retired
-- fighters whose <3-bout careers never trigger the gate stay rendered
-- as gaps rather than zeros.
--
-- Populated by the same scripts/compute_score_history.ts pass that
-- already writes vertex_score (current replay) — both columns get
-- updated together on every full re-run.

ALTER TABLE fighter_score_history
  ADD COLUMN IF NOT EXISTS vertex_score_all_time SMALLINT;
