-- Wave 6C.2: rank-tier wins from ranking_snapshot.
--
-- compute_opponent_quality.ts now computes a rank-tier (top5/top10/top15)
-- per win in addition to the existing champion-tier (apex/strong/solid/
-- legacy/ranked). When the rank-tier multiplier exceeds the champion-tier
-- multiplier for a given win, the win counts as a top5/top10/top15 win
-- instead of one of the legacy buckets. These three columns hold the
-- per-fighter totals.
--
-- quality_wins_score formula gains an additive term:
--   + top5_wins  × 15  (matches the strong-tier weight)
--   + top10_wins ×  8  (matches solid)
--   + top15_wins ×  4  (matches legacy)
-- The cap of 100 still applies (Math.min(100, ...) in the TS script).
--
-- Defaults are 0 so re-running compute_opponent_quality.ts is the
-- single source of truth.

ALTER TABLE fighter
  ADD COLUMN IF NOT EXISTS top5_wins  integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS top10_wins integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS top15_wins integer DEFAULT 0 NOT NULL;
