-- Wave 3.5 step 6A.5.4: roster_status drives is_active + activity.
--
-- Replaces the last_fight_date heuristic used since step 5E. The old rule
-- collapsed everything into three brackets keyed on last fight date:
--   <6mo → 100, 6-12mo → 70, >12mo → 0 (and is_active = fought in 12mo).
--
-- That mis-classified two cases the project actually cares about:
--   1. Rostered champions with long layoffs (Pereira: 7mo since UFC 320,
--      old rule gave him 70 — Activity*0.18 = -7 vs Merab's 100*0.18 = 18,
--      shifting Merab above the active LHW champ).
--   2. Released-but-recent fighters (Magny, Page in transition) kept full
--      Activity since they fought < 6mo ago, despite no contract.
--
-- New rule keys on roster_status + has_upcoming_bout (from
-- imports/roster_current.csv via scripts/import_roster_watch.ts) plus
-- last_fight_date as a tie-break/decay signal:
--
--   roster='active' + has_upcoming + last < 12mo → 100  (fully active)
--   roster='active' + has_upcoming                → 90   (booked, layoff)
--   roster='active' + last < 9mo                  → 100  (fought recently)
--   roster='active' + last < 18mo                 → 70   (mid layoff)
--   roster='active'                               → 50   (long layoff)
--   roster<>'active' + last < 9mo                 → 80   (transition)
--   else                                          → 0
--
-- is_active widens to 24mo OR rostered (was 12mo only), so the current
-- score covers freshly-released contenders alongside rostered fighters.
--
-- Tier breaks (80/60/40), all-time formula, current weights, multiplier
-- curve, skid penalty — all unchanged from step 6A.4 (commit 925d761).

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
    f.roster_status,
    f.has_upcoming_bout,
    COALESCE(ur.ufc_bouts, 0) AS ufc_bouts,
    COALESCE(ur.ufc_wins, 0) AS ufc_wins,
    COALESCE(ur.ufc_losses, 0) AS ufc_losses,
    ur.last_fight_date,

    -- Step 6A.5.4: rostered OR recent (24mo) counts as is_active. Widens
    -- the current-score gate so released-but-still-fighting contenders
    -- show up (they decay via the new activity bucket below).
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
    COALESCE(f.title_fight_count, 0) AS title_fight_count,

    -- Step 6A.5.4: replaces the 6mo/12mo/else bracket. has_upcoming_bout
    -- is the strongest signal that a layoff is intentional/transient
    -- (book a fight → still 90 even on a long camp), while non-rostered
    -- but recent gives transition-phase fighters partial credit.
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
