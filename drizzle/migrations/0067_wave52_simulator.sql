-- Wave 52: fight simulator.
--
-- Wave 34 set `simulation` RLS to owner-only SELECT. The simulator UX
-- needs `is_public` rows readable by anyone (default for newly-created
-- sims; you share a /simulator/[id] link and the recipient needs to be
-- able to read it). Replace the policy with a union: public rows OR
-- owner rows.
--
-- INSERT / DELETE policies stay absent — writes happen exclusively via
-- the server action which talks through the postgres role (RLS bypassed).

DROP POLICY IF EXISTS "simulation_select_own" ON simulation;
DROP POLICY IF EXISTS "simulation_select_public_or_own" ON simulation;
CREATE POLICY "simulation_select_public_or_own" ON simulation
  FOR SELECT USING (
    is_public = true
    OR (
      user_id IS NOT NULL
      AND user_id IN (
        SELECT id FROM user_profile WHERE auth_user_id = auth.uid()
      )
    )
  );
