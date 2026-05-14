-- Wave 3.5 step 3.6: dominant champion flag.
--
-- Adds fighter.is_dominant_champion (boolean DEFAULT false). Backfilled by
-- scripts/compute_championship_pedigree.ts from
-- src/lib/championship-history.ts → isDominantChampion(): double champion
-- OR >= 2 years cumulative undisputed reign.
--
-- The Vertex Score view (migration 0010) applies a +3 post-cap bonus to
-- fighters with this flag so retired all-time greats (Anderson, GSP,
-- Khabib, DJ, Jones, Aldo, Holloway, etc.) reach the Elite tier without
-- indiscriminately boosting anyone who briefly held a belt.

ALTER TABLE fighter
  ADD COLUMN IF NOT EXISTS is_dominant_champion boolean DEFAULT false NOT NULL;

CREATE INDEX IF NOT EXISTS fighter_is_dominant_champion_idx
  ON fighter (is_dominant_champion)
  WHERE is_dominant_champion = true;
