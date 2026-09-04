-- Wave 62 follow-up — index bout_round_stats by fighter.
--
-- getFighterBoutRounds (src/lib/fighter-detail.ts) feeds the round-by-round
-- chart and the striking heatmap on every profile:
--
--   ... FROM bout_round_stats brs
--       JOIN bout b ON b.id = brs.bout_id
--       JOIN event e ON e.id = b.event_id
--       LEFT JOIN bout_round_stats opp
--         ON opp.bout_id = brs.bout_id AND opp.round = brs.round
--        AND opp.fighter_id <> brs.fighter_id
--       WHERE brs.fighter_id = $2::uuid AND b.status = $15
--
-- The table carried indexes on bout_id and (bout_id, fighter_id, round) but
-- none on fighter_id alone, so the driving filter had nothing to use: every
-- profile scanned all 41,632 rows. pg_stat_user_tables had recorded 379,296
-- sequential scans over 15.6 billion tuples on a 12 MB table, and after the
-- fighter_vertex_score matview landed this became the single most expensive
-- statement left (1,147 ms mean).
--
-- The self-join's opp side is already served by bout_round_stats_bout_idx, so
-- only the fighter_id entry point is missing.
--
-- CONCURRENTLY so the live site keeps writing during the build; it cannot run
-- inside a transaction block, hence no BEGIN/COMMIT here.
--
--   psql "$DATABASE_URL" -f drizzle/migrations/0096_bout_round_stats_fighter_idx.sql

SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS bout_round_stats_fighter_idx
  ON bout_round_stats (fighter_id);

ANALYZE bout_round_stats;
