-- Run manually in Supabase SQL Editor (or via scripts/apply_vertex_score_migration.ts).
-- Wave 3.5 step 1: Vertex Score data foundation.
--
-- Adds two persisted columns to fighter:
--   championship_pedigree  — 0-100, derived from championship-history.ts +
--                            title-challenger-history.ts in TypeScript and
--                            backfilled by scripts/compute_championship_pedigree.ts
--   vertex_score           — 0-100 weighted total from the five Vertex Score
--                            components, materialized from `fighter_vertex_score`
--                            for fighters with >= 3 UFC bouts
--
-- Then (re)creates the `fighter_vertex_score` view that exposes all five
-- components + the weighted total. The view reads from fighter (for
-- championship_pedigree), bout (for UFC record + method), bout_round_stats
-- (for method fallback when bout.method is NULL), and fighter_stats_aggregate
-- (for striking / grappling per-minute stats).

ALTER TABLE fighter
  ADD COLUMN IF NOT EXISTS championship_pedigree integer DEFAULT 0 NOT NULL;

ALTER TABLE fighter
  ADD COLUMN IF NOT EXISTS vertex_score integer;

CREATE INDEX IF NOT EXISTS fighter_vertex_score_idx
  ON fighter (vertex_score DESC NULLS LAST);

-- The view itself.
DROP VIEW IF EXISTS fighter_vertex_score CASCADE;

CREATE VIEW fighter_vertex_score AS
WITH
ufc_record AS (
  -- UFC-only bouts (we treat every bout in the `bout` table as UFC since
  -- that's what the scraper ingests). `last_fight_date` drives the Activity
  -- component.
  SELECT
    f.id AS fighter_id,
    COUNT(*) FILTER (WHERE b.status = 'completed') AS ufc_bouts,
    COUNT(*) FILTER (WHERE b.winner_id = f.id AND b.status = 'completed') AS ufc_wins,
    COUNT(*) FILTER (
      WHERE b.status = 'completed'
        AND b.winner_id IS NOT NULL
        AND b.winner_id <> f.id
    ) AS ufc_losses,
    MAX(e.date) FILTER (WHERE b.status = 'completed') AS last_fight_date
  FROM fighter f
  LEFT JOIN bout b
    ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
  LEFT JOIN event e ON e.id = b.event_id
  GROUP BY f.id
),
method_counts AS (
  -- Method breakdown for UFC wins. Falls back to round-stat signals when
  -- bout.method is NULL (~half of completed bouts before the Wave 3.5 data
  -- backfill). The fallback rule matches `fighter_with_stats`: knockdowns >0
  -- in the finishing round ⇒ KO, sub_attempts >0 ⇒ Sub, otherwise unknown.
  SELECT
    f.id AS fighter_id,
    COUNT(*) FILTER (
      WHERE b.winner_id = f.id
        AND b.status = 'completed'
        AND (
          LOWER(b.method::text) LIKE 'ko%'
          OR LOWER(b.method::text) LIKE 'tko%'
          OR (b.method IS NULL AND COALESCE(brs_win.knockdowns, 0) > 0)
        )
    ) AS ufc_wins_ko,
    COUNT(*) FILTER (
      WHERE b.winner_id = f.id
        AND b.status = 'completed'
        AND (
          LOWER(b.method::text) LIKE 'sub%'
          OR (
            b.method IS NULL
            AND COALESCE(brs_win.knockdowns, 0) = 0
            AND COALESCE(brs_win.sub_attempts, 0) > 0
          )
        )
    ) AS ufc_wins_sub,
    COUNT(*) FILTER (
      WHERE b.winner_id = f.id
        AND b.status = 'completed'
        AND LOWER(b.method::text) LIKE '%dec%'
    ) AS ufc_wins_dec
  FROM fighter f
  LEFT JOIN bout b
    ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
  LEFT JOIN bout_round_stats brs_win
    ON brs_win.bout_id = b.id
   AND brs_win.fighter_id = b.winner_id
   AND brs_win.round = b.round_finished
  GROUP BY f.id
),
components AS (
  SELECT
    f.id,
    f.slug,
    COALESCE(ur.ufc_bouts, 0) AS ufc_bouts,
    COALESCE(ur.ufc_wins, 0) AS ufc_wins,
    COALESCE(ur.ufc_losses, 0) AS ufc_losses,
    ur.last_fight_date,
    COALESCE(mc.ufc_wins_ko, 0) AS ufc_wins_ko,
    COALESCE(mc.ufc_wins_sub, 0) AS ufc_wins_sub,
    COALESCE(mc.ufc_wins_dec, 0) AS ufc_wins_dec,

    -- COMPONENT 1: Win Quality (0-100).
    -- 60% from raw wins (Jon Jones tops at ~28 UFC wins → cap at 30) and
    -- 40% from win rate, both scaled by a credibility floor that ramps in
    -- linearly to 15 UFC bouts (so a 3-0 fighter doesn't out-score a 22-5
    -- former champion).
    LEAST(100, GREATEST(0,
      (
        (LEAST(COALESCE(ur.ufc_wins, 0), 30)::float / 30.0 * 60.0)
        + (
          COALESCE(
            COALESCE(ur.ufc_wins, 0)::float
              / NULLIF(COALESCE(ur.ufc_wins, 0) + COALESCE(ur.ufc_losses, 0), 0),
            0.5
          ) * 40.0
        )
      ) * (LEAST(COALESCE(ur.ufc_bouts, 0), 15)::float / 15.0)
    )) AS win_quality,

    -- COMPONENT 2: Championship Pedigree (0-100).
    -- Sourced from fighter.championship_pedigree (populated by
    -- scripts/compute_championship_pedigree.ts).
    COALESCE(f.championship_pedigree, 0)::float AS championship_pedigree,

    -- COMPONENT 3: Activity (0-100). Recency bands.
    CASE
      WHEN ur.last_fight_date IS NULL THEN 0
      WHEN ur.last_fight_date > NOW() - INTERVAL '12 months' THEN 100
      WHEN ur.last_fight_date > NOW() - INTERVAL '24 months' THEN 70
      WHEN ur.last_fight_date > NOW() - INTERVAL '36 months' THEN 40
      WHEN ur.last_fight_date > NOW() - INTERVAL '48 months' THEN 20
      ELSE 5
    END::float AS activity,

    -- COMPONENT 4: Striking Excellence (0-100).
    -- 35 SLpM (top ~7) + 25 Str.Acc (top 60%) + 25 Str.Def (top 70%)
    -- + 15 KO finish rate among UFC wins.
    LEAST(100, GREATEST(0,
      LEAST(COALESCE(fsa.slpm, 0)::float / 7.0 * 35.0, 35.0)
      + LEAST(COALESCE(fsa.str_acc, 0)::float / 0.6 * 25.0, 25.0)
      + LEAST(COALESCE(fsa.str_def, 0)::float / 0.7 * 25.0, 25.0)
      + LEAST(
          COALESCE(
            COALESCE(mc.ufc_wins_ko, 0)::float
              / NULLIF(COALESCE(ur.ufc_wins, 0), 0),
            0
          ) * 15.0,
          15.0
        )
    )) AS striking_excellence,

    -- COMPONENT 5: Grappling Excellence (0-100).
    -- 25 TD.Avg (top ~5) + 30 TD.Def (top 85%) + 25 Sub.Avg (top ~3)
    -- + 20 Sub finish rate among UFC wins.
    LEAST(100, GREATEST(0,
      LEAST(COALESCE(fsa.td_avg, 0)::float / 5.0 * 25.0, 25.0)
      + LEAST(COALESCE(fsa.td_def, 0)::float / 0.85 * 30.0, 30.0)
      + LEAST(COALESCE(fsa.sub_avg, 0)::float / 3.0 * 25.0, 25.0)
      + LEAST(
          COALESCE(
            COALESCE(mc.ufc_wins_sub, 0)::float
              / NULLIF(COALESCE(ur.ufc_wins, 0), 0),
            0
          ) * 20.0,
          20.0
        )
    )) AS grappling_excellence
  FROM fighter f
  LEFT JOIN ufc_record ur ON ur.fighter_id = f.id
  LEFT JOIN method_counts mc ON mc.fighter_id = f.id
  LEFT JOIN fighter_stats_aggregate fsa ON fsa.fighter_id = f.id
)
SELECT
  id,
  slug,
  ufc_bouts,
  ufc_wins,
  ufc_losses,
  last_fight_date,
  ufc_wins_ko,
  ufc_wins_sub,
  ufc_wins_dec,
  win_quality,
  championship_pedigree,
  activity,
  striking_excellence,
  grappling_excellence,
  ROUND(
    win_quality * 0.35
    + championship_pedigree * 0.25
    + activity * 0.15
    + striking_excellence * 0.12
    + grappling_excellence * 0.13
  )::integer AS vertex_score
FROM components;
