-- Wave 62 — turn fighter_vertex_score into a MATERIALIZED VIEW.
--
-- WHY (production incident 2026-09-04): fighter_vertex_score was a plain VIEW
-- of ~15 CTEs joining fighter × bout on
--   (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
-- plus window functions over bout_opponent_tier / bout_round_stats /
-- bout_fighter_stats. `WHERE id = $1` cannot be pushed through the aggregates,
-- so every profile render recomputed ratings for the whole roster and threw
-- away 4,612 of 4,613 rows. Measured on prod: 938 ms mean per call across
-- 108,995 calls (~28 h of CPU on that one statement; ~40 h counting its
-- column-list variants), and 107 s for one full unfiltered pass. On the Nano
-- instance (224 MB shared_buffers) that saturated the CPU, queries began
-- hitting the 2 min statement_timeout, the app's session-mode pool stopped
-- handing out connections after its 15 s wait, and the site stopped answering.
--
-- SHAPE: the 559-line definition stays the single source of truth, renamed to
-- fighter_vertex_score_live. The name the app reads becomes a thin matview over
-- it, so no application code changes and no redeploy is needed. A single-row
-- read is now a unique-index lookup instead of a roster-wide recompute.
--
-- FRESHNESS: the body calls now() 18 times (layoff penalty, decay, activity
-- windows), so the snapshot is time-dependent and must be rebuilt daily. The
-- recompute chain (ops/cron/recompute.sh) refreshes it via
-- scripts/refresh_vertex_score_matview.ts immediately before
-- materialize_vertex_score, which copies the same snapshot into the fighter
-- columns — so the columns and the matview can no longer disagree. Daily
-- granularity matches inputs that move in months.
--
-- COLUMN DRIFT: `SELECT *` freezes the column list at CREATE time. A later wave
-- that adds a column to the live view will NOT reach the matview by REFRESH.
-- refresh_vertex_score_matview.ts compares both column lists on every run and
-- rebuilds instead of refreshing when they diverge; the wave scripts must
-- target fighter_vertex_score_live from now on.
--
-- Run with drizzle-kit disabled (it does not manage views):
--   psql "$DATABASE_URL" -f drizzle/migrations/0095_fighter_vertex_score_matview.sql
-- Building the matview runs one full pass of the view, so raise the timeout.

SET statement_timeout = 0;

BEGIN;

ALTER VIEW fighter_vertex_score RENAME TO fighter_vertex_score_live;

CREATE MATERIALIZED VIEW fighter_vertex_score AS
  SELECT * FROM fighter_vertex_score_live;

-- Unique index serves both purposes: it makes `WHERE id = $1` an index lookup,
-- and REFRESH MATERIALIZED VIEW CONCURRENTLY requires one (so the daily rebuild
-- never blocks readers). Verified before the migration: 4,613 rows,
-- 4,613 distinct ids, 0 nulls.
CREATE UNIQUE INDEX fighter_vertex_score_id_uidx
  ON fighter_vertex_score (id);

-- Mirror the grants the view carried (Supabase's default GRANT ALL to the API
-- roles); RENAME kept them on _live, the new relation starts owner-only.
GRANT ALL ON fighter_vertex_score TO anon, authenticated, service_role;

COMMIT;

ANALYZE fighter_vertex_score;
