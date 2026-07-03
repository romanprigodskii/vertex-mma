-- Wave 62 — custom "dream fight" simulations.
--
-- Users pick two fighters and, per fighter, the bout whose form to take
-- (NULL as_of = current form). Rows are a work QUEUE: the Next.js server
-- action INSERTs status='pending'; the Python worker
-- (scripts/simulation/scripts/run_custom.py, systemd vertex-sim-worker on
-- the VPS) scores it with the committed ensemble + Monte Carlo and writes
-- the full payload into result jsonb with status='done' (or 'failed' +
-- error). Results are immutable after completion; re-requests of the same
-- matchup/forms are served from cache by the action.
--
-- Apply with: pnpm tsx scripts/apply_custom_simulation.ts
-- (idempotent; drizzle-kit push must never be pointed at this — the table
-- is also declared in src/lib/db/schema/simulation.ts so push won't drop it)

CREATE TABLE IF NOT EXISTS custom_simulation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_profile_id uuid REFERENCES user_profile(id) ON DELETE SET NULL,
  fighter_a_id uuid NOT NULL REFERENCES fighter(id) ON DELETE CASCADE,
  fighter_b_id uuid NOT NULL REFERENCES fighter(id) ON DELETE CASCADE,
  -- Form anchors: the fighter's history up to AND INCLUDING this bout
  -- (post-fight form). NULL = current form (full history to date).
  as_of_bout_a_id uuid REFERENCES bout(id) ON DELETE SET NULL,
  as_of_bout_b_id uuid REFERENCES bout(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  model_version text,
  result jsonb,
  error text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT custom_simulation_distinct_fighters CHECK (fighter_a_id <> fighter_b_id),
  CONSTRAINT custom_simulation_status_check CHECK (status IN ('pending', 'done', 'failed'))
);

-- Worker queue scan.
CREATE INDEX IF NOT EXISTS custom_simulation_queue_idx
  ON custom_simulation (status, requested_at)
  WHERE status = 'pending';

-- "My simulations" listing.
CREATE INDEX IF NOT EXISTS custom_simulation_user_idx
  ON custom_simulation (user_profile_id, requested_at DESC);

-- Cache lookups (action checks both fighter orders).
CREATE INDEX IF NOT EXISTS custom_simulation_pair_idx
  ON custom_simulation (fighter_a_id, fighter_b_id, status);
