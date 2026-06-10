-- Wave 61: ScoreBreakdown transparency — surface the layoff deduction.
--
-- raw_current already bakes in `- layoff_penalty` (Wave 31) and the
-- win-streak bonus (Wave 32), but the breakdown table only listed the
-- nine weighted components, so the rows never summed to the raw
-- subtotal and the layoff decline was invisible. The global view
-- exposes months_since_last / layoff_penalty directly; the divisional
-- path reads the materialized fighter_divisional_score table, which
-- did not store them. Add the two display columns — populated by
-- scripts/materialize_divisional_score.ts on every run.

ALTER TABLE fighter_divisional_score
  ADD COLUMN IF NOT EXISTS months_since_last double precision,
  ADD COLUMN IF NOT EXISTS layoff_penalty double precision;
