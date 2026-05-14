-- Wave 3.5 step 5F: undefeated champion bonus.
--
-- Adds fighter.undefeated_bonus (0 or 30, default 0). Populated by
-- scripts/compute_opponent_quality.ts when ALL three conditions hold:
--   1. ufc_real_losses = 0   (DQ-only losses excluded — Jon Jones's
--                              Hamill loss is `method='dq'` in our data)
--   2. ufc_wins >= 8         (substantial sample; not a 3-0 newcomer)
--   3. fighter is in championship-history.ts (any reign, incl. interim)
--
-- The bonus adds 30 to quality_wins_score above its normal 100 cap so
-- Jon Jones / Khabib (the two real-world hits) can break the QW
-- ceiling and pull above 80 / 90 all-time without inflating scores for
-- non-champions.

ALTER TABLE fighter
  ADD COLUMN IF NOT EXISTS undefeated_bonus integer DEFAULT 0 NOT NULL;
