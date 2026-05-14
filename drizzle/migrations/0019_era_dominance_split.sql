-- Wave 3.5 step 5E: split era_dominance into current vs all-time.
--
-- Before this migration, fighter.era_dominance baked in the
-- active-champion bonus (+10) and was used for BOTH current and all-time
-- scores. That's a logical bug — "active champion" is a transient state
-- and shouldn't lift a fighter's career-independent all-time score.
--
-- After:
--   era_dominance          — title_fight_count * 10 + active_bonus(10)
--                            + double_bonus(5) — used by CURRENT score
--   era_dominance_all_time — title_fight_count * 10 + double_bonus(5)
--                            (no active bonus) — used by ALL-TIME score
--
-- Both populated by scripts/compute_era_dominance.ts.

ALTER TABLE fighter
  ADD COLUMN IF NOT EXISTS era_dominance_all_time integer DEFAULT 0 NOT NULL;

COMMENT ON COLUMN fighter.era_dominance IS
  'Current score component: TF*10 + active(10) + double(5), cap 100';

COMMENT ON COLUMN fighter.era_dominance_all_time IS
  'All-time score component: TF*10 + double(5), cap 100. No active bonus.';
