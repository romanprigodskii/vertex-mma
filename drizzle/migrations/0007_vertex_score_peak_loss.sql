-- Wave 3.5 step 3: Peak window + asymmetric loss penalty.
--
-- Adds two penalty components to the fighter_vertex_score view and pulls
-- fighter.peak_score (populated by scripts/compute_peak_scores.ts) into the
-- all-time formula:
--
--   recent_loss_penalty (current only) — losses_last_3 * 25 +
--     losses_last_5 * 12 + losses_24mo * 6  (cap 100). Heavily punishes a
--     fighter on a recent skid; legends in their prime score 0.
--
--   total_loss_penalty (all-time only) — ufc_losses * 4 (cap 100). Flat
--     penalty for journeymen with double-digit career losses.
--
-- New weights (each row sums to 1.00 plus penalty subtractions):
--
--   CURRENT     WQ 0.30 + CP 0.22 + ACT 0.13 + STRK 0.10 + GRAP 0.10
--               - RecentLossPenalty 0.15
--   ALL-TIME    WQ 0.30 + CP 0.22 + STRK 0.10 + GRAP 0.10 + Peak 0.18
--               - TotalLossPenalty 0.10
--
-- Peak is included only in all-time so the current score keeps rewarding
-- right-now form, while the all-time score recognises a 5-fight prime run
-- (Pereira 2022-24, Khabib 2018-20, GSP 2007-09 etc.).

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
-- Recent loss buckets — used only by the current score. Builds a per-bout
-- ROW_NUMBER() over each fighter's career-DESC ordering so we can grade the
-- last 3 / 5 fights without nested LIMITs.
ranked_bouts AS (
  SELECT
    CASE WHEN b.fighter_a_id = f.id THEN f.id ELSE f.id END AS fighter_id,
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

    -- Win Quality (credibility-floored to 15 bouts).
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

    -- Peak window (computed by scripts/compute_peak_scores.ts). NULL for
    -- fighters with < 10 UFC bouts ⇒ COALESCE'd to 0.
    COALESCE(f.peak_score, 0)::float AS peak_score,

    -- Recent-loss penalty (current only).
    LEAST(100,
      COALESCE(rl.losses_last_3, 0) * 25
      + COALESCE(rl.losses_last_5, 0) * 12
      + COALESCE(rl.losses_24mo, 0) * 6
    )::float AS recent_loss_penalty,

    -- Total-loss penalty (all-time only).
    LEAST(100, COALESCE(ur.ufc_losses, 0) * 4)::float AS total_loss_penalty
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
  recent_loss_penalty,
  total_loss_penalty,

  -- CURRENT score — active fighters only.
  CASE
    WHEN is_active AND ufc_bouts >= 3 THEN
      GREATEST(0, ROUND(
        win_quality * 0.30
        + championship_pedigree * 0.22
        + activity * 0.13
        + striking_excellence * 0.10
        + grappling_excellence * 0.10
        - recent_loss_penalty * 0.15
      ))::integer
    ELSE NULL
  END AS vertex_score,

  -- ALL-TIME score — every fighter with >= 3 UFC bouts. Includes Peak,
  -- excludes Activity, applies a flat total-loss penalty.
  CASE
    WHEN ufc_bouts >= 3 THEN
      GREATEST(0, ROUND(
        win_quality * 0.30
        + championship_pedigree * 0.22
        + striking_excellence * 0.10
        + grappling_excellence * 0.10
        + peak_score * 0.18
        - total_loss_penalty * 0.10
      ))::integer
    ELSE NULL
  END AS vertex_score_all_time
FROM components;
