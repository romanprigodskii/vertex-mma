-- Wave 14B.1: in_active_ranking eligibility flag on
-- fighter_divisional_score.
--
-- TRUE iff the fighter's primary current division (current_division ??
-- weight_class_primary) matches this row's division, OR the fighter has
-- a scheduled bout in this division. Set by
-- scripts/materialize_divisional_score.ts on every run.
--
-- Default FALSE so any (fighter, division) row inserted before the next
-- materialize run is conservatively hidden from ranking queries.

ALTER TABLE fighter_divisional_score
  ADD COLUMN IF NOT EXISTS in_active_ranking BOOLEAN NOT NULL DEFAULT FALSE;
