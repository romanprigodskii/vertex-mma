-- Wave 3.5 step 6A.3: rebalance the CURRENT score formula.
--
-- Three concurrent fixes applied to the vertex_score column only.
-- vertex_score_all_time formula stays exactly as it was in step 5E.
--
-- 1. Reweight positives toward performance components (lifts middle tier
--    out of the high-20s/low-30s where champion-driven weights buried
--    them):
--      QW         0.30 → 0.22
--      CP         0.18 → 0.12
--      Era        0.12 → 0.08
--      PerfDiff   0.10 → 0.18   (DOUBLED)
--      Finishing  0.15 → 0.12
--      Activity   0.15 → 0.18
--      Sum positives = 0.90 (was 1.00 — leaves room for soft multiplier)
--      RecentLoss 0.10 → 0.20   (DOUBLED penalty)
--
-- 2. Tighten is_active from 36 months → 12 months. Cejudo / Aldo / Jones
--    / DJ / GSP / Khabib (all retired) drop from current rankings,
--    leaving the leaderboard genuinely actively-competing fighters.
--    Activity scale also tightened: 6mo=100, 12mo=70, else=0.
--
-- 3. Soft-compression multiplier on the raw current total — lifts middle
--    without inflating the top:
--      raw <60   → raw * 1.4               (a raw 40 → 56)
--      raw <80   → 84 + (raw-60) * 0.8     (a raw 70 → 92)
--      raw ≥80   → 84 + (raw-80) * 0.4     (a raw 90 → 88, caps near 92)
--    This is intentionally non-monotonic at the 80 boundary so the
--    elite cluster collapses toward the high-80s while the middle gets
--    pulled up — matches the spec "caps near 92 for absolute top."
--
-- Tier breaks (80/60/40) and all visual styling are untouched.

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
performance_diff AS (
  SELECT
    fsa.fighter_id,
    LEAST(100, GREATEST(0, ROUND(
        0.55 * (50 + (COALESCE(fsa.slpm, 0)::float - COALESCE(fsa.sapm, 0)::float) * 20.0)
      + 0.45 * (50 + (
          COALESCE(fsa.td_avg, 0)::float
          - (1.0 - COALESCE(fsa.td_def, 0.5)::float) * 3.0
        ) * 20.0)
    ))) AS performance_diff_score
  FROM fighter_stats_aggregate fsa
),
finishing_dom AS (
  SELECT
    f.id AS fighter_id,
    COALESCE(SUM(brs.knockdowns), 0)::float
      / NULLIF(COUNT(DISTINCT b.id), 0) AS kd_per_fight,
    COALESCE(SUM(brs.sub_attempts), 0)::float
      / NULLIF(COUNT(DISTINCT b.id), 0) AS sa_per_fight,
    COUNT(DISTINCT b.id) FILTER (
      WHERE b.winner_id = f.id
        AND (
          LOWER(COALESCE(b.method::text, '')) LIKE 'ko%'
          OR LOWER(COALESCE(b.method::text, '')) LIKE 'tko%'
          OR (b.method IS NULL AND COALESCE(brs.knockdowns, 0) > 0)
        )
    )::float
      / NULLIF(
          COUNT(DISTINCT b.id) FILTER (WHERE b.winner_id = f.id),
          0
        ) AS ko_rate,
    COUNT(DISTINCT b.id) FILTER (
      WHERE b.winner_id = f.id
        AND (
          LOWER(COALESCE(b.method::text, '')) LIKE 'sub%'
          OR (b.method IS NULL AND COALESCE(brs.sub_attempts, 0) > 0)
        )
    )::float
      / NULLIF(
          COUNT(DISTINCT b.id) FILTER (WHERE b.winner_id = f.id),
          0
        ) AS sub_rate
  FROM fighter f
  LEFT JOIN bout b
    ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
    AND b.status = 'completed'
  LEFT JOIN bout_round_stats brs
    ON brs.bout_id = b.id
   AND brs.fighter_id = f.id
  GROUP BY f.id
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

    -- 12 months instead of 36 — Cejudo / Aldo / Khabib / GSP / DJ /
    -- Anderson / Jones (all retired) drop from current.
    (ur.last_fight_date IS NOT NULL
     AND ur.last_fight_date > NOW() - INTERVAL '12 months') AS is_active,

    COALESCE(rl.losses_last_3, 0) AS losses_last_3,
    COALESCE(rl.losses_last_5, 0) AS losses_last_5,
    COALESCE(rl.losses_24mo, 0) AS losses_24mo,

    COALESCE(f.quality_wins_score, 0)::float AS quality_wins,
    COALESCE(f.championship_pedigree, 0)::float AS championship_pedigree,
    COALESCE(f.era_dominance, 0)::float AS era_dominance_current,
    COALESCE(f.era_dominance_all_time, 0)::float AS era_dominance_all_time,
    COALESCE(f.apex_wins, 0) AS apex_wins,
    COALESCE(f.strong_wins, 0) AS strong_wins,
    COALESCE(f.solid_wins, 0) AS solid_wins,
    COALESCE(f.legacy_wins, 0) AS legacy_wins,
    COALESCE(f.ranked_wins, 0) AS ranked_wins,
    COALESCE(f.title_fight_count, 0) AS title_fight_count,

    -- Tightened activity bands matched to the 12mo is_active window.
    CASE
      WHEN ur.last_fight_date IS NULL THEN 0
      WHEN ur.last_fight_date > NOW() - INTERVAL '6 months' THEN 100
      WHEN ur.last_fight_date > NOW() - INTERVAL '12 months' THEN 70
      ELSE 0
    END::float AS activity,

    LEAST(100,
      COALESCE(rl.losses_last_3, 0) * 25
      + COALESCE(rl.losses_last_5, 0) * 12
      + COALESCE(rl.losses_24mo, 0) * 6
    )::float AS recent_loss_penalty,

    LEAST(100, COALESCE(ur.ufc_losses, 0) * 4)::float AS total_loss_penalty,

    COALESCE(pd.performance_diff_score, 50)::float AS performance_diff,

    LEAST(100, GREATEST(0,
      COALESCE(fd.kd_per_fight, 0) * 20.0
      + COALESCE(fd.sa_per_fight, 0) * 10.0
      + COALESCE(fd.ko_rate, 0) * 35.0
      + COALESCE(fd.sub_rate, 0) * 35.0
    ))::float AS finishing_dominance_score
  FROM fighter f
  LEFT JOIN ufc_record ur ON ur.fighter_id = f.id
  LEFT JOIN recent_losses rl ON rl.fighter_id = f.id
  LEFT JOIN performance_diff pd ON pd.fighter_id = f.id
  LEFT JOIN finishing_dom fd ON fd.fighter_id = f.id
),
raw_scores AS (
  SELECT
    *,
    -- Raw current uses the rebalanced weights. NULL when inactive (>12mo).
    CASE
      WHEN is_active AND ufc_bouts >= 3 THEN
        GREATEST(0,
            quality_wins * 0.22
          + championship_pedigree * 0.12
          + era_dominance_current * 0.08
          + performance_diff * 0.18
          + finishing_dominance_score * 0.12
          + activity * 0.18
          - recent_loss_penalty * 0.20
        )
      ELSE NULL
    END AS raw_current
  FROM components
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
  title_fight_count,
  quality_wins,
  championship_pedigree,
  era_dominance_current,
  era_dominance_all_time,
  performance_diff,
  finishing_dominance_score,
  activity,
  recent_loss_penalty,
  total_loss_penalty,
  raw_current,

  -- Soft-compression multiplier applied to raw current total.
  CASE
    WHEN raw_current IS NULL THEN NULL
    WHEN raw_current < 60 THEN ROUND(raw_current * 1.4)::integer
    WHEN raw_current < 80 THEN ROUND(60 * 1.4 + (raw_current - 60) * 0.8)::integer
    ELSE ROUND(84 + (raw_current - 80) * 0.4)::integer
  END AS vertex_score,

  -- ALL-TIME formula UNCHANGED from step 5E.
  CASE
    WHEN ufc_bouts >= 3 THEN
      GREATEST(0, ROUND(
          quality_wins * 0.28
        + championship_pedigree * 0.22
        + era_dominance_all_time * 0.22
        + performance_diff * 0.12
        + finishing_dominance_score * 0.16
        - total_loss_penalty * 0.10
      ))::integer
    ELSE NULL
  END AS vertex_score_all_time
FROM raw_scores;
