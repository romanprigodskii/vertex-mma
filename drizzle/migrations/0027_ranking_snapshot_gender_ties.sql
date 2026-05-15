-- Wave 6C.1 follow-up to migration 0026.
--
-- Two findings from the parser dry-run on the 233-file Wayback corpus:
--
--   1. weight_class is a gender-agnostic enum (flyweight, bantamweight,
--      strawweight). Without a gender flag, men's flyweight #1 (e.g.
--      Brandon Moreno) collides with women's flyweight #1 (Valentina
--      Shevchenko) on (snapshot_date, division, rank). We add an
--      is_women boolean to disambiguate.
--
--   2. UFC.com publishes tied ranks in real source HTML — e.g.
--      20170121.html lists both Aleksei Oleinik and Tim Johnson at HW #14
--      with no #15. ~406 such tied rows across 38,490 total. The original
--      UNIQUE (snapshot_date, division, rank) cannot represent ties at
--      all, so we widen the constraint to include fighter_name_raw and
--      is_women. The importer's ON CONFLICT clause matches this shape so
--      re-runs remain idempotent (re-resolves fighter_id without
--      duplicating rows).
--
-- This file is written defensively (IF [NOT] EXISTS guards everywhere)
-- because an interactive run during the spike applied the same shape
-- under slightly different auto-generated names. Re-running here is a
-- no-op when the target state already exists.

ALTER TABLE ranking_snapshot
  ADD COLUMN IF NOT EXISTS is_women boolean NOT NULL DEFAULT false;

-- Drop the old unique constraint regardless of which name Postgres
-- assigned during 0026 (the inline form in CREATE TABLE got an auto-
-- generated suffix and we don't want to depend on its exact spelling).
DO $$
DECLARE
  cname text;
BEGIN
  FOR cname IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'ranking_snapshot'::regclass
      AND contype = 'u'
      AND conname <> 'ranking_snapshot_unique'
      AND pg_get_constraintdef(oid) = 'UNIQUE (snapshot_date, division, rank)'
  LOOP
    EXECUTE format('ALTER TABLE ranking_snapshot DROP CONSTRAINT %I', cname);
  END LOOP;
END $$;

-- Add the new unique constraint if it isn't there yet.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ranking_snapshot'::regclass
      AND conname = 'ranking_snapshot_unique'
  ) THEN
    ALTER TABLE ranking_snapshot
      ADD CONSTRAINT ranking_snapshot_unique
      UNIQUE (snapshot_date, division, rank, fighter_name_raw, is_women);
  END IF;
END $$;

-- Helps queries that filter by gender within a division (Wave 6C.2 will
-- look up "rank N at date D in (division, is_women)" per fighter).
CREATE INDEX IF NOT EXISTS ranking_snapshot_gender_div_date_idx
  ON ranking_snapshot(division, is_women, snapshot_date DESC);
