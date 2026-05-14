-- Wave 3.5 step 5C: gender column for gender-split leaderboards.
--
-- The UFCStats scrape doesn't carry a gender field and the weight_class
-- enum is shared across men and women (e.g. women's bantamweight and
-- men's bantamweight both store as 'bantamweight'). Strawweight is the
-- only UFC women-exclusive division.
--
-- Populated by scripts/infer_fighter_gender.ts which:
--   1. Marks every strawweight fighter as female.
--   2. Seeds known-female slugs from championship-history.ts +
--      title-challenger-history.ts women's entries.
--   3. Expands transitively through bouts — UFC has never had a
--      mixed-gender bout, so any fighter who shares a bout with a known
--      woman is also a woman. Iterates to convergence.
-- Everyone not flagged female after expansion defaults to male.

ALTER TABLE fighter
  ADD COLUMN IF NOT EXISTS gender text NOT NULL DEFAULT 'male'
  CHECK (gender IN ('male', 'female'));

CREATE INDEX IF NOT EXISTS fighter_gender_idx
  ON fighter (gender);
