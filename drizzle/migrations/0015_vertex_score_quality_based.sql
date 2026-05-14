-- Wave 3.5 step 5A: Vertex Score formula rewritten around opponent quality.
--
-- Why: the previous volume-bias formula (peak window + raw wins) ranked
-- journeymen like Neil Magny (47 UFC bouts, 31 wins, never beat a champion)
-- in the all-time top 10 alongside Jon Jones and Islam. Tuning the weights
-- 9 times couldn't fix it because the underlying signal (raw counts) didn't
-- distinguish "31 wins over journeymen" from "20 wins over champions."
--
-- New formula uses fighter.quality_wins_score (populated by
-- scripts/compute_opponent_quality.ts) as the primary signal:
--
--   apex_wins   * 25  (active champion at bout date)
-- + strong_wins * 15  (within ±3 fights of own reign boundary)
-- + solid_wins  *  8  (former champion outside that window)
-- + legacy_wins *  4  (former champion with 3+ post-reign losses)
-- + ranked_wins *  3  (never champion but has apex/strong wins themselves)
-- → cap 100
--
-- Weights (positives sum to 1.00 before penalty subtraction):
--
--   CURRENT   QualityWins 0.50 + Pedigree 0.25 + Activity 0.15
--             - RecentLossPenalty 0.10
--   ALL-TIME  QualityWins 0.50 + Pedigree 0.40
--             - TotalLossPenalty 0.10
--
-- Step 5B will add Performance Differential, Finishing rate, and Era
-- Dominance components on top of this foundation.

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
ranked_bouts AS (
  SELECT
    f.id AS f_id,
    b.winner_id,
    e.date AS event_date,
    ROW_NUMBER() OVER (
      PARTITION BY f.id
      ORDER BY e.date DESC, b.id DESC
    ) AS rn_desc
  FROM fighter f
  JOIN bout b ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
  JOIN event e ON e.id = b.event_id
  WHERE b.status = 'completed'
),
recent_losses AS (
  SELECT
    f_id AS fighter_id,
    COUNT(*) FILTER (
      WHERE rn_desc <= 3 AND winner_id IS NOT NULL AND winner_id <> f_id
    )::int AS losses_last_3,
    COUNT(*) FILTER (
      WHERE rn_desc <= 5 AND winner_id IS NOT NULL AND winner_id <> f_id
    )::int AS losses_last_5,
    COUNT(*) FILTER (
      WHERE event_date > NOW() - INTERVAL '24 months'
        AND winner_id IS NOT NULL AND winner_id <> f_id
    )::int AS losses_24mo
  FROM ranked_bouts
  GROUP BY f_id
),
components AS (
  SELECT
    f.id,
    f.slug,
    f.is_dominant_champion,
    COALESCE(ur.ufc_bouts, 0) AS ufc_bouts,
    COALESCE(ur.ufc_wins, 0) AS ufc_wins,
    COALESCE(ur.ufc_losses, 0) AS ufc_losses,
    ur.last_fight_date,

    (ur.last_fight_date IS NOT NULL
     AND ur.last_fight_date > NOW() - INTERVAL '36 months') AS is_active,

    COALESCE(rl.losses_last_3, 0) AS losses_last_3,
    COALESCE(rl.losses_last_5, 0) AS losses_last_5,
    COALESCE(rl.losses_24mo, 0) AS losses_24mo,

    COALESCE(f.quality_wins_score, 0)::float AS quality_wins,
    COALESCE(f.championship_pedigree, 0)::float AS championship_pedigree,
    COALESCE(f.apex_wins, 0) AS apex_wins,
    COALESCE(f.strong_wins, 0) AS strong_wins,
    COALESCE(f.solid_wins, 0) AS solid_wins,
    COALESCE(f.legacy_wins, 0) AS legacy_wins,
    COALESCE(f.ranked_wins, 0) AS ranked_wins,

    CASE
      WHEN ur.last_fight_date IS NULL THEN 0
      WHEN ur.last_fight_date > NOW() - INTERVAL '12 months' THEN 100
      WHEN ur.last_fight_date > NOW() - INTERVAL '24 months' THEN 70
      WHEN ur.last_fight_date > NOW() - INTERVAL '36 months' THEN 40
      ELSE 0
    END::float AS activity,

    LEAST(100,
      COALESCE(rl.losses_last_3, 0) * 25
      + COALESCE(rl.losses_last_5, 0) * 12
      + COALESCE(rl.losses_24mo, 0) * 6
    )::float AS recent_loss_penalty,

    LEAST(100, COALESCE(ur.ufc_losses, 0) * 4)::float AS total_loss_penalty
  FROM fighter f
  LEFT JOIN ufc_record ur ON ur.fighter_id = f.id
  LEFT JOIN recent_losses rl ON rl.fighter_id = f.id
)
SELECT
  id,
  slug,
  ufc_bouts,
  ufc_wins,
  ufc_losses,
  last_fight_date,
  is_active,
  is_dominant_champion,
  losses_last_3,
  losses_last_5,
  losses_24mo,
  apex_wins,
  strong_wins,
  solid_wins,
  legacy_wins,
  ranked_wins,
  quality_wins,
  championship_pedigree,
  activity,
  recent_loss_penalty,
  total_loss_penalty,

  CASE
    WHEN is_active AND ufc_bouts >= 3 THEN
      LEAST(100, GREATEST(0, ROUND(
        quality_wins * 0.50
        + championship_pedigree * 0.25
        + activity * 0.15
        - recent_loss_penalty * 0.10
      )))::integer
    ELSE NULL
  END AS vertex_score,

  CASE
    WHEN ufc_bouts >= 3 THEN
      LEAST(100, GREATEST(0, ROUND(
        quality_wins * 0.50
        + championship_pedigree * 0.40
        - total_loss_penalty * 0.10
      )))::integer
    ELSE NULL
  END AS vertex_score_all_time
FROM components;
