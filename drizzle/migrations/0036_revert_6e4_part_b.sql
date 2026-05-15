-- Wave 6E.4 Part B REVERT.
--
-- Wave 6E.4 Part B (migration 0035) bundled five coupled architectural
-- changes into a single migration:
--   1. performance_diff_current using last-5-bouts opp-adjusted dominance
--   2. finishing_dominance_current opp-weighted realized-finish rate
--   3. era_dominance_current dropping the title_fight_count*10 term
--   4. activity smooth linear fade replacing bucket-based step jumps
--   5. activity weight reduction 0.18 → 0.12
--   6. streak_bonus quality-scaled by streak_opp_avg_tier / 15
--
-- Each change was independently reasonable, but stacked together they
-- compounded to -15 to -25 drops across the top-5 of most divisions,
-- and flipped one division's #1 (welterweight Shavkat 89→60 vs Morales
-- 85→63). The spec's STOP condition triggered:
--   - top-1 of WW changed
--   - 27 top-5 movers exceeded the ±15 threshold
--
-- This migration reverts to the post-6E.2 view definition (verbatim from
-- migration 0033) so the rankings return to their pre-6E.4-Part-B state.
--
-- bout_opponent_tier (Part A, migration 0034) is INTENTIONALLY KEPT — the
-- table is a no-op when nothing references it, and stays available as
-- foundation for a future smaller-scope re-attempt (potentially split
-- across multiple waves to avoid the same compounding issue).
--
-- The view body below is character-identical to migration 0033's CREATE
-- VIEW (Wave 6E.1 + Wave 6C.3.1 + Wave 6E carried forward). No formula
-- changes here; this is purely a state restoration.

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
control_time_per_fighter AS (
  SELECT
    brs.fighter_id,
    SUM(brs.control_time_seconds)::float AS total_control_seconds,
    SUM(CASE
      WHEN brs.round < b.round_finished THEN 300
      WHEN brs.round = b.round_finished THEN b.time_finished_seconds
      ELSE 0
    END)::float AS total_fight_seconds
  FROM bout_round_stats brs
  JOIN bout b ON b.id = brs.bout_id
  WHERE b.status = 'completed'
  GROUP BY brs.fighter_id
),
performance_diff AS (
  SELECT
    fsa.fighter_id,
    LEAST(100, GREATEST(0, ROUND(
        -- Striking part (0.45): SLpM - SApM differential, ×20 around 50.
        0.45 * (50 + (COALESCE(fsa.slpm, 0)::float - COALESCE(fsa.sapm, 0)::float) * 20.0)
        -- Control part (0.35): control seconds per minute of fight time.
        -- Wave 6C.3.1 recalibration: baseline 15 sec/min → 50, slope 2.6.
        -- 30 sec/min (Khabib-tier real-data peak) → ~89; cap near 34 sec/min.
      + 0.35 * (
          CASE
            WHEN ctp.total_fight_seconds IS NULL OR ctp.total_fight_seconds = 0 THEN 50
            ELSE LEAST(100, GREATEST(0,
              50 + ((ctp.total_control_seconds / ctp.total_fight_seconds * 60.0) - 15.0) * 2.6
            ))
          END
        )
        -- Takedown part (0.20): td_avg vs failed-defense expectation.
      + 0.20 * (50 + (
          COALESCE(fsa.td_avg, 0)::float
          - (1.0 - COALESCE(fsa.td_def, 0.5)::float) * 3.0
        ) * 20.0)
    ))) AS performance_diff_score
  FROM fighter_stats_aggregate fsa
  LEFT JOIN control_time_per_fighter ctp ON ctp.fighter_id = fsa.fighter_id
),
finishing_dom AS (
  -- Wave 6E: per-15-minute KD / SA rates. total_seconds sums the actual
  -- time-on-the-mat per round (full 5 min for non-finishing rounds, partial
  -- for the finishing round) so fast finishers aren't dragged down by the
  -- per-bout denominator. Mirrors `control_time_per_fighter` above.
  --
  -- Wave 6E.1: also count realized KO/TKO wins and submission wins, exposed
  -- to the components CTE as ko_wins_count / sub_wins_count and turned into
  -- per-15min rates downstream. NULL-method fallback via brs (knockdowns >0
  -- ⇒ KO, sub_attempts >0 ⇒ Sub) mirrors the ko_rate/sub_rate inference.
  SELECT
    f.id AS fighter_id,
    COALESCE(SUM(brs.knockdowns), 0)::float   AS total_kd,
    COALESCE(SUM(brs.sub_attempts), 0)::float AS total_sa,
    COALESCE(SUM(CASE
      WHEN brs.round < b.round_finished THEN 300
      WHEN brs.round = b.round_finished THEN b.time_finished_seconds
      ELSE 0
    END), 0)::float AS total_seconds,
    COUNT(DISTINCT b.id) FILTER (
      WHERE b.winner_id = f.id
        AND (
          LOWER(COALESCE(b.method::text, '')) LIKE 'ko%'
          OR LOWER(COALESCE(b.method::text, '')) LIKE 'tko%'
          OR (b.method IS NULL AND COALESCE(brs.knockdowns, 0) > 0)
        )
    )::float AS ko_wins_count,
    COUNT(DISTINCT b.id) FILTER (
      WHERE b.winner_id = f.id
        AND (
          LOWER(COALESCE(b.method::text, '')) LIKE 'sub%'
          OR (b.method IS NULL AND COALESCE(brs.sub_attempts, 0) > 0)
        )
    )::float AS sub_wins_count,
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
    f.roster_status,
    f.has_upcoming_bout,
    COALESCE(ur.ufc_bouts, 0) AS ufc_bouts,
    COALESCE(ur.ufc_wins, 0) AS ufc_wins,
    COALESCE(ur.ufc_losses, 0) AS ufc_losses,
    ur.last_fight_date,

    (f.roster_status = 'active'
     OR (ur.last_fight_date IS NOT NULL
         AND ur.last_fight_date > NOW() - INTERVAL '24 months')) AS is_active,

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
    COALESCE(f.top5_wins, 0) AS top5_wins,
    COALESCE(f.top10_wins, 0) AS top10_wins,
    COALESCE(f.top15_wins, 0) AS top15_wins,
    COALESCE(f.title_fight_count, 0) AS title_fight_count,
    COALESCE(f.current_streak, 0) AS current_streak,

    CASE
      WHEN f.roster_status = 'active' AND f.has_upcoming_bout
           AND ur.last_fight_date > NOW() - INTERVAL '12 months' THEN 100
      WHEN f.roster_status = 'active' AND f.has_upcoming_bout THEN 90
      WHEN f.roster_status = 'active'
           AND ur.last_fight_date > NOW() - INTERVAL '9 months' THEN 100
      WHEN f.roster_status = 'active'
           AND ur.last_fight_date > NOW() - INTERVAL '18 months' THEN 70
      WHEN f.roster_status = 'active' THEN 50
      WHEN ur.last_fight_date > NOW() - INTERVAL '9 months' THEN 80
      ELSE 0
    END::float AS activity,

    LEAST(100,
      COALESCE(rl.losses_last_3, 0) * 25
      + COALESCE(rl.losses_last_5, 0) * 12
      + COALESCE(rl.losses_24mo, 0) * 6
    )::float AS recent_loss_penalty,

    LEAST(100, COALESCE(ur.ufc_losses, 0) * 4)::float AS total_loss_penalty,

    COALESCE(pd.performance_diff_score, 50)::float AS performance_diff,

    -- Wave 6E.1: rebalanced multipliers across six terms — attempt rates
    -- (KD/SA per 15min, ×10 each), method ratios (ko_rate/sub_rate, ×25
    -- each), and realized-finish rates (ko_wins/sub_wins per 15min, ×20
    -- each). The last pair closes the loop on high-closure submission
    -- specialists (Khabib) whose attempt counts under-represent their
    -- finishing dominance.
    LEAST(100, GREATEST(0,
      CASE
        WHEN COALESCE(fd.total_seconds, 0) > 0 THEN
          (fd.total_kd / fd.total_seconds * 900.0) * 10.0
        + (fd.total_sa / fd.total_seconds * 900.0) * 10.0
        + (COALESCE(fd.ko_wins_count, 0) / fd.total_seconds * 900.0) * 20.0
        + (COALESCE(fd.sub_wins_count, 0) / fd.total_seconds * 900.0) * 100.0
        ELSE 0
      END
      + COALESCE(fd.ko_rate, 0) * 25.0
      + COALESCE(fd.sub_rate, 0) * 25.0
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
    CASE
      WHEN current_streak >= 3 AND quality_wins >= 20
      THEN LEAST(current_streak, 5)::float * 4.0
      ELSE 0::float
    END AS current_streak_bonus,
    CASE
      WHEN is_active AND ufc_bouts >= 5 THEN
        GREATEST(0,
            quality_wins * 0.22
          + championship_pedigree * 0.12
          + era_dominance_current * 0.08
          + performance_diff * 0.18
          + finishing_dominance_score * 0.12
          + (CASE WHEN current_streak >= 3 AND quality_wins >= 20
                  THEN LEAST(current_streak, 5)::float * 4.0
                  ELSE 0::float END)
          + activity * 0.18
          - recent_loss_penalty * 0.20
        )
      ELSE NULL
    END AS raw_current
  FROM components
),
multiplied AS (
  SELECT
    *,
    CASE
      WHEN raw_current IS NULL THEN NULL
      WHEN raw_current < 40 THEN
        LEAST(100, ROUND(raw_current * 1.3))::int
      WHEN raw_current < 65 THEN
        LEAST(100, ROUND(40 * 1.3 + (raw_current - 40) * 1.25))::int
      WHEN raw_current < 85 THEN
        LEAST(100, ROUND(40 * 1.3 + 25 * 1.25 + (raw_current - 65) * 1.0))::int
      ELSE
        LEAST(100, ROUND(40 * 1.3 + 25 * 1.25 + 20 * 1.0 + (raw_current - 85) * 0.4))::int
    END AS multiplied_current
  FROM raw_scores
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
  roster_status,
  has_upcoming_bout,
  losses_last_3,
  losses_last_5,
  losses_24mo,
  apex_wins,
  strong_wins,
  solid_wins,
  legacy_wins,
  ranked_wins,
  top5_wins,
  top10_wins,
  top15_wins,
  title_fight_count,
  current_streak,
  current_streak_bonus,
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
  multiplied_current,

  CASE
    WHEN multiplied_current IS NULL THEN NULL
    WHEN COALESCE(losses_last_3, 0) >= 3 THEN
      GREATEST(0, multiplied_current - 25)
    ELSE multiplied_current
  END AS vertex_score,

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
FROM multiplied;
