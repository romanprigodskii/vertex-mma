-- Wave 3.5 step 2: split into current (active-only) + all-time Vertex Score.
--
-- Why: the single-score formula from step 1 over-penalized retired legends
-- (Khabib, GSP, Anderson, DJ, Cain all ranked 30-48 despite legendary
-- careers) because Activity is one of five components. Splitting gives:
--
--   vertex_score (current)  — NULL for inactive fighters; includes Activity.
--   vertex_score_all_time   — populated for every fighter with >= 3 UFC
--                             bouts; Activity weight redistributed across
--                             the other four components.
--
-- "Active" cutoff is last_fight_date > NOW() - INTERVAL '36 months'. We use
-- the bout-derived date rather than fighter.status because the scraper left
-- every fighter labelled "active" in the DB.
--
-- Credibility floor (15-bout linear ramp) extended from Win Quality to also
-- gate Striking Excellence and Grappling Excellence so a 9-0 fighter with
-- ultra-clean rate stats can't out-score a 22-3 former champion on those
-- components alone.
--
-- New all-time weights (Activity 0.15 redistributed proportionally to the
-- four remaining components — 0.41 + 0.30 + 0.14 + 0.15 = 1.00 ✓):
--   Win Quality           0.41   (was 0.35)
--   Championship Pedigree 0.30   (was 0.25)
--   Striking Excellence   0.14   (was 0.12)
--   Grappling Excellence  0.15   (was 0.13)

ALTER TABLE fighter
  ADD COLUMN IF NOT EXISTS vertex_score_all_time integer;

CREATE INDEX IF NOT EXISTS fighter_vertex_score_all_time_idx
  ON fighter (vertex_score_all_time DESC NULLS LAST);

DROP VIEW IF EXISTS fighter_vertex_score CASCADE;

CREATE VIEW fighter_vertex_score AS
WITH
ufc_record AS (
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

    -- Active = had at least one fight in the last 36 months.
    (ur.last_fight_date IS NOT NULL
     AND ur.last_fight_date > NOW() - INTERVAL '36 months') AS is_active,

    COALESCE(mc.ufc_wins_ko, 0) AS ufc_wins_ko,
    COALESCE(mc.ufc_wins_sub, 0) AS ufc_wins_sub,
    COALESCE(mc.ufc_wins_dec, 0) AS ufc_wins_dec,

    -- Component 1: Win Quality (0-100). 60% raw wins + 40% win rate,
    -- scaled by a credibility floor that ramps linearly to 15 UFC bouts.
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

    -- Component 2: Championship Pedigree (0-100). Sourced from
    -- fighter.championship_pedigree (populated by
    -- scripts/compute_championship_pedigree.ts).
    COALESCE(f.championship_pedigree, 0)::float AS championship_pedigree,

    -- Component 3: Activity (0-100). Only feeds the current score; banded
    -- so anything older than 36 months is 0 (and that fighter would be
    -- flagged inactive and excluded from current anyway).
    CASE
      WHEN ur.last_fight_date IS NULL THEN 0
      WHEN ur.last_fight_date > NOW() - INTERVAL '12 months' THEN 100
      WHEN ur.last_fight_date > NOW() - INTERVAL '24 months' THEN 70
      WHEN ur.last_fight_date > NOW() - INTERVAL '36 months' THEN 40
      ELSE 0
    END::float AS activity,

    -- Component 4: Striking Excellence (0-100). Credibility floor ramps
    -- with bout count so small-sample rate stats don't dominate.
    (LEAST(100, GREATEST(0,
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
    )) * (LEAST(COALESCE(ur.ufc_bouts, 0), 15)::float / 15.0)) AS striking_excellence,

    -- Component 5: Grappling Excellence (0-100). Same credibility floor.
    (LEAST(100, GREATEST(0,
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
    )) * (LEAST(COALESCE(ur.ufc_bouts, 0), 15)::float / 15.0)) AS grappling_excellence
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
  is_active,
  ufc_wins_ko,
  ufc_wins_sub,
  ufc_wins_dec,
  win_quality,
  championship_pedigree,
  activity,
  striking_excellence,
  grappling_excellence,

  -- CURRENT score — NULL for inactive fighters. Original step-1 weights.
  CASE
    WHEN is_active AND ufc_bouts >= 3 THEN
      ROUND(
        win_quality * 0.35
        + championship_pedigree * 0.25
        + activity * 0.15
        + striking_excellence * 0.12
        + grappling_excellence * 0.13
      )::integer
    ELSE NULL
  END AS vertex_score,

  -- ALL-TIME score — populated for any fighter with >= 3 UFC bouts.
  -- Activity weight (0.15) redistributed proportionally:
  --   WQ 0.41, CP 0.30, STRK 0.14, GRAP 0.15  (sum = 1.00)
  CASE
    WHEN ufc_bouts >= 3 THEN
      ROUND(
        win_quality * 0.41
        + championship_pedigree * 0.30
        + striking_excellence * 0.14
        + grappling_excellence * 0.15
      )::integer
    ELSE NULL
  END AS vertex_score_all_time
FROM components;
