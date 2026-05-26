-- Wave 53: remove the fight simulator.
--
-- Drops the `simulation` table (along with its RLS policies + indexes)
-- and the now-orphaned `simulation_count` column on `user_profile`.
--
-- Re-runnable.

DROP TABLE IF EXISTS simulation CASCADE;
ALTER TABLE user_profile DROP COLUMN IF EXISTS simulation_count;
