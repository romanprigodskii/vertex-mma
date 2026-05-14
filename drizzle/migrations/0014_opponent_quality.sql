-- Wave 3.5 step 5A: opponent-quality columns.
--
-- Populated by scripts/compute_opponent_quality.ts which classifies every
-- UFC win by the opponent's championship status at the bout date:
--
--   apex_wins    — opponent was the active undisputed champion (any belt) at
--                  the bout date
--   strong_wins  — opponent was within ±3 fights of one of their reigns (just
--                  before winning the belt or just after losing it)
--   solid_wins   — opponent was a former undisputed champion outside that
--                  ±3 window, fewer than 3 post-reign losses
--   legacy_wins  — former champion with >= 3 post-reign losses by bout date
--                  (clearly in their decline phase)
--   ranked_wins  — opponent was never undisputed champion but has >= 1
--                  apex/strong win of their own
--
-- quality_wins_score caps the weighted sum at 100:
--   apex*25 + strong*15 + solid*8 + legacy*4 + ranked*3, LEAST(100, sum)

ALTER TABLE fighter
  ADD COLUMN IF NOT EXISTS apex_wins integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS strong_wins integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS solid_wins integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS legacy_wins integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS ranked_wins integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS quality_wins_score integer DEFAULT 0 NOT NULL;

CREATE INDEX IF NOT EXISTS fighter_quality_wins_score_idx
  ON fighter (quality_wins_score DESC NULLS LAST);
