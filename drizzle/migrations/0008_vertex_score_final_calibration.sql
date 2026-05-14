-- Wave 3.5 step 3.5: final Vertex Score recalibration.
--
-- Targets:
--   - Positive components sum to 1.00 so a perfect-score fighter caps at
--     100 (Elite tier 80+ was empty after step 3 because the old weights
--     summed to 0.85 / 0.90).
--   - Peak threshold lowered from 10 → 5 UFC bouts; weight scales by
--     tenure_factor = LEAST(bouts, 15) / 15. The "missing" peak weight is
--     redistributed to Win Quality so the all-time formula always sums
--     to 1.00 regardless of tenure.
--   - Penalties (recent / total loss) are applied AFTER the cap, scaling
--     [-15, -20] of the score range so a clean fighter can hit 100 and a
--     skidder can drop below 0 (clamped via GREATEST).
--
-- Per-row weight verification:
--   CURRENT  WQ 0.35 + CP 0.25 + ACT 0.15 + STRK 0.12 + GRAP 0.13 = 1.00
--            - RecentLossPenalty 0.20
--   ALL-TIME (tenure 1.0)
--            WQ 0.32 + CP 0.25 + STRK 0.12 + GRAP 0.13 + Peak 0.18 = 1.00
--   ALL-TIME (tenure 0.6, 9 UFC bouts)
--            WQ (0.32 + 0.18 * 0.4) = 0.392 + CP 0.25 + STRK 0.12
--            + GRAP 0.13 + Peak (0.18 * 0.6) = 0.108 = 1.00
--   ALL-TIME (tenure 0.0, < 5 UFC bouts)
--            WQ (0.32 + 0.18) = 0.50 + CP 0.25 + STRK 0.12 + GRAP 0.13
--            + Peak 0 = 1.00
--   - TotalLossPenalty 0.15

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
ranked_bouts AS (
  SELECT
    f.id AS f_id,
    b.id AS bout_id,
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
      WHERE rn_desc <= 3
        AND winner_id IS NOT NULL
        AND winner_id <> f_id
    )::int AS losses_last_3,
    COUNT(*) FILTER (
      WHERE rn_desc <= 5
        AND winner_id IS NOT NULL
        AND winner_id <> f_id
    )::int AS losses_last_5,
    COUNT(*) FILTER (
      WHERE event_date > NOW() - INTERVAL '24 months'
        AND winner_id IS NOT NULL
        AND winner_id <> f_id
    )::int AS losses_24mo
  FROM ranked_bouts
  GROUP BY f_id
),
components AS (
  SELECT
    f.id,
    f.slug,
    COALESCE(ur.ufc_bouts, 0) AS ufc_bouts,
    COALESCE(ur.ufc_wins, 0) AS ufc_wins,
    COALESCE(ur.ufc_losses, 0) AS ufc_losses,
    ur.last_fight_date,

    (ur.last_fight_date IS NOT NULL
     AND ur.last_fight_date > NOW() - INTERVAL '36 months') AS is_active,

    COALESCE(mc.ufc_wins_ko, 0) AS ufc_wins_ko,
    COALESCE(mc.ufc_wins_sub, 0) AS ufc_wins_sub,
    COALESCE(mc.ufc_wins_dec, 0) AS ufc_wins_dec,
    COALESCE(rl.losses_last_3, 0) AS losses_last_3,
    COALESCE(rl.losses_last_5, 0) AS losses_last_5,
    COALESCE(rl.losses_24mo, 0) AS losses_24mo,

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

    COALESCE(f.championship_pedigree, 0)::float AS championship_pedigree,

    CASE
      WHEN ur.last_fight_date IS NULL THEN 0
      WHEN ur.last_fight_date > NOW() - INTERVAL '12 months' THEN 100
      WHEN ur.last_fight_date > NOW() - INTERVAL '24 months' THEN 70
      WHEN ur.last_fight_date > NOW() - INTERVAL '36 months' THEN 40
      ELSE 0
    END::float AS activity,

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
    )) * (LEAST(COALESCE(ur.ufc_bouts, 0), 15)::float / 15.0)) AS grappling_excellence,

    COALESCE(f.peak_score, 0)::float AS peak_score,

    LEAST(100,
      COALESCE(rl.losses_last_3, 0) * 25
      + COALESCE(rl.losses_last_5, 0) * 12
      + COALESCE(rl.losses_24mo, 0) * 6
    )::float AS recent_loss_penalty,

    LEAST(100, COALESCE(ur.ufc_losses, 0) * 4)::float AS total_loss_penalty,

    -- Tenure factor for the all-time peak weight. < 5 bouts: 0 (no peak),
    -- 5-15: linear ramp, >= 15: full weight.
    CASE
      WHEN COALESCE(ur.ufc_bouts, 0) < 5 THEN 0::float
      ELSE LEAST(COALESCE(ur.ufc_bouts, 0), 15)::float / 15.0
    END AS peak_tenure_factor
  FROM fighter f
  LEFT JOIN ufc_record ur ON ur.fighter_id = f.id
  LEFT JOIN method_counts mc ON mc.fighter_id = f.id
  LEFT JOIN recent_losses rl ON rl.fighter_id = f.id
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
  losses_last_3,
  losses_last_5,
  losses_24mo,
  win_quality,
  championship_pedigree,
  activity,
  striking_excellence,
  grappling_excellence,
  peak_score,
  peak_tenure_factor,
  recent_loss_penalty,
  total_loss_penalty,

  -- CURRENT score — active only. Positives sum to 1.00, recent-loss
  -- penalty deducts up to 20 points.
  CASE
    WHEN is_active AND ufc_bouts >= 3 THEN
      GREATEST(0, LEAST(100, ROUND(
        win_quality * 0.35
        + championship_pedigree * 0.25
        + activity * 0.15
        + striking_excellence * 0.12
        + grappling_excellence * 0.13
        - recent_loss_penalty * 0.20
      )))::integer
    ELSE NULL
  END AS vertex_score,

  -- ALL-TIME score. Peak weight scales by tenure_factor; the difference
  -- redistributes to Win Quality so the formula always sums to 1.00.
  -- Total-loss penalty deducts up to 15 points.
  CASE
    WHEN ufc_bouts >= 3 THEN
      GREATEST(0, LEAST(100, ROUND(
        win_quality * (0.32 + 0.18 * (1.0 - peak_tenure_factor))
        + championship_pedigree * 0.25
        + striking_excellence * 0.12
        + grappling_excellence * 0.13
        + peak_score * (0.18 * peak_tenure_factor)
        - total_loss_penalty * 0.15
      )))::integer
    ELSE NULL
  END AS vertex_score_all_time
FROM components;
