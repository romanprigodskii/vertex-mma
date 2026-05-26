-- Wave 31.7++: monthly synthetic snapshots between bouts.
--
-- The bout anchors in fighter_score_history capture the score
-- right after each fight. With long layoffs between fights, the
-- chart would draw a straight line for months even though the
-- formula's time-windowed components (activity, recent_form,
-- recent_loss_penalty, layoff) decay continuously. To make that
-- decay visible we emit one synthetic monthly anchor per
-- (fighter, month) between bouts and from the last bout to today.
--
-- Schema changes:
--   - as_of_bout_id becomes nullable (monthly rows carry NULL).
--   - kind column distinguishes 'bout' rows from 'monthly' rows.
--   - Replace the composite PK (fighter_id, as_of_bout_id) with a
--     surrogate id, because legacy data has at least one fighter
--     with two bouts on the same date (UFC 11/12-era tournament
--     night), so (fighter_id, as_of_date) isn't unique. Coupled
--     with partial unique indexes that enforce the natural keys
--     per kind: (fighter, bout) for bouts, (fighter, date) for
--     monthlies.
--
-- Re-runnable: every change uses IF EXISTS / IF NOT EXISTS.

ALTER TABLE fighter_score_history
  DROP CONSTRAINT IF EXISTS fighter_score_history_pkey;

ALTER TABLE fighter_score_history
  ALTER COLUMN as_of_bout_id DROP NOT NULL;

ALTER TABLE fighter_score_history
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'bout';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fighter_score_history_kind_check'
  ) THEN
    ALTER TABLE fighter_score_history
      ADD CONSTRAINT fighter_score_history_kind_check
      CHECK (kind IN ('bout', 'monthly'));
  END IF;
END $$;

ALTER TABLE fighter_score_history
  ADD COLUMN IF NOT EXISTS id BIGSERIAL PRIMARY KEY;

CREATE UNIQUE INDEX IF NOT EXISTS fighter_score_history_bout_unique
  ON fighter_score_history (fighter_id, as_of_bout_id)
  WHERE as_of_bout_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS fighter_score_history_monthly_unique
  ON fighter_score_history (fighter_id, as_of_date)
  WHERE kind = 'monthly';
