-- Wave 3.5 step 3: peak window component for the all-time score.
--
-- Adds fighter.peak_score (0-100, nullable). Populated by
-- scripts/compute_peak_scores.ts which slides a 5-fight window over each
-- fighter's UFC career and computes:
--
--   peak = wins * 12 + KO_wins * 5 + sub_wins * 5 + title_fights * 4
--   (capped at 100, only computed for fighters with >= 10 UFC bouts)
--
-- NULL for fighters with < 10 UFC bouts — the all-time formula treats NULL
-- as 0 via COALESCE.

ALTER TABLE fighter
  ADD COLUMN IF NOT EXISTS peak_score integer;

CREATE INDEX IF NOT EXISTS fighter_peak_score_idx
  ON fighter (peak_score DESC NULLS LAST);
