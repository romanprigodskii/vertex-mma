-- Wave 57: remove the predictions pick'em contest entirely.
--
-- Drops the contest's trigger, scoring functions, tables (Wave 45 / 0063, with
-- the on_bout_score_predictions body later extended in Wave 46 / 0064) and the
-- user_profile.prediction_count tally. Idempotent (IF EXISTS / CASCADE) and
-- touches NOTHING in the simulation, sportsbook or LMSR-market subsystems —
-- their "prediction" references mean the MODEL's predictions, not this contest.
--
-- RLS policies on the three tables are removed implicitly by DROP TABLE CASCADE
-- (an explicit DROP POLICY ... ON <table> would break idempotency once the table
-- is gone). Historical notification rows of type 'prediction_scored' are left in
-- place — only the emitting trigger is dropped, so no new ones are created.

-- Trigger first (it calls the scoring functions).
DROP TRIGGER IF EXISTS on_bout_score_predictions ON bout;

DROP FUNCTION IF EXISTS public.on_bout_score_predictions();
DROP FUNCTION IF EXISTS public.score_predictions_for_bout(uuid);
DROP FUNCTION IF EXISTS public.refresh_prediction_event_results(uuid);

-- Tables, child → parent. CASCADE clears indexes, FKs, RLS policies and rows.
DROP TABLE IF EXISTS prediction_pick CASCADE;
DROP TABLE IF EXISTS prediction_event_result CASCADE;
DROP TABLE IF EXISTS prediction_event CASCADE;

-- Lifetime contest tally — only the (now-deleted) predictions action wrote it.
ALTER TABLE user_profile DROP COLUMN IF EXISTS prediction_count;
