-- Wave 6E.4 Part A: persistent per-bout opponent tier table.
--
-- Foundation for the opp-adjusted recent-performance refactor in Part B
-- (current_score only). compute_opponent_quality.ts already classifies each
-- opponent per bout for the counter aggregations (apex_wins, strong_wins,
-- solid_wins, legacy_wins, ranked_wins, top5_wins, top10_wins, top15_wins)
-- but discards the per-bout classification once the running counters are
-- updated.
--
-- This migration adds bout_opponent_tier — one row per (bout_id, fighter_id)
-- pair persisting the MAX of champion-tier and rank-tier (25 apex / 22 top5
-- / 15 strong / 14 top10 / 8 solid|top15 / 4 legacy / 3 ranked / 0 prospect)
-- — same scheme as the streak_opp_avg_tier idea from Wave 6E.3 that's being
-- materialized as part of this wave.
--
-- compute_opponent_quality.ts will be extended in the same wave to also
-- UPSERT into this table during its bout walk, then the view (Part B,
-- migration 0035) joins to it for the recent_bouts_window CTE.
--
-- Idempotent: IF NOT EXISTS guards both the table and its index. Re-running
-- this migration is a no-op.

CREATE TABLE IF NOT EXISTS bout_opponent_tier (
  bout_id UUID NOT NULL REFERENCES bout(id) ON DELETE CASCADE,
  fighter_id UUID NOT NULL REFERENCES fighter(id) ON DELETE CASCADE,
  opp_tier_value INTEGER NOT NULL DEFAULT 0,
  opp_tier_label TEXT NOT NULL DEFAULT 'prospect',
  PRIMARY KEY (bout_id, fighter_id)
);

CREATE INDEX IF NOT EXISTS bout_opponent_tier_fighter_id_idx
  ON bout_opponent_tier(fighter_id);
