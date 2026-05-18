-- Wave 37: user-generated custom rankings.
--
-- Two tables:
--   custom_ranking         — list metadata (title, description, author)
--   custom_ranking_entry   — positioned fighter slots (one row per slot)
--
-- RLS: public SELECT, owner-only INSERT/UPDATE/DELETE on both tables.
-- Re-runnable.

CREATE TABLE IF NOT EXISTS custom_ranking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES user_profile(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS custom_ranking_user_idx
  ON custom_ranking(user_id);
CREATE INDEX IF NOT EXISTS custom_ranking_created_idx
  ON custom_ranking(created_at);

CREATE TABLE IF NOT EXISTS custom_ranking_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ranking_id uuid NOT NULL REFERENCES custom_ranking(id) ON DELETE CASCADE,
  fighter_id uuid NOT NULL REFERENCES fighter(id) ON DELETE CASCADE,
  position integer NOT NULL,
  note text
);

CREATE INDEX IF NOT EXISTS custom_ranking_entry_ranking_idx
  ON custom_ranking_entry(ranking_id);

-- ALTER ... ADD CONSTRAINT isn't IF NOT EXISTS in PG <17; wrap in DO block
-- so the migration is re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'custom_ranking_entry_pos_unique'
  ) THEN
    ALTER TABLE custom_ranking_entry
      ADD CONSTRAINT custom_ranking_entry_pos_unique UNIQUE (ranking_id, position);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'custom_ranking_entry_fighter_unique'
  ) THEN
    ALTER TABLE custom_ranking_entry
      ADD CONSTRAINT custom_ranking_entry_fighter_unique UNIQUE (ranking_id, fighter_id);
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE custom_ranking       ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_ranking_entry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "custom_ranking_select_all" ON custom_ranking;
CREATE POLICY "custom_ranking_select_all" ON custom_ranking
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "custom_ranking_insert_own" ON custom_ranking;
CREATE POLICY "custom_ranking_insert_own" ON custom_ranking
  FOR INSERT WITH CHECK (
    user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "custom_ranking_update_own" ON custom_ranking;
CREATE POLICY "custom_ranking_update_own" ON custom_ranking
  FOR UPDATE USING (
    user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "custom_ranking_delete_own" ON custom_ranking;
CREATE POLICY "custom_ranking_delete_own" ON custom_ranking
  FOR DELETE USING (
    user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "custom_ranking_entry_select_all" ON custom_ranking_entry;
CREATE POLICY "custom_ranking_entry_select_all" ON custom_ranking_entry
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "custom_ranking_entry_modify_owner" ON custom_ranking_entry;
CREATE POLICY "custom_ranking_entry_modify_owner" ON custom_ranking_entry
  FOR ALL USING (
    ranking_id IN (
      SELECT id FROM custom_ranking
      WHERE user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
    )
  )
  WITH CHECK (
    ranking_id IN (
      SELECT id FROM custom_ranking
      WHERE user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
    )
  );
