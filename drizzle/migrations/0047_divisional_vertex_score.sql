-- Wave 14A: per-(fighter, division) current_score backend foundation.
--
-- Adds:
--   1. table fighter_divisional_score — materialized destination, one row
--      per (fighter_id, division) for any fighter with ≥3 completed UFC
--      bouts in that division. Populated by
--      scripts/materialize_divisional_score.ts.
--   2. view fighter_divisional_vertex_score — parallel to
--      fighter_vertex_score (migration 0046) but scoped to (fighter,
--      division). Every CTE that was per-fighter is now per-(fighter,
--      division); ROW_NUMBER windows partition by both keys; the "last
--      5 bouts" recency window is scoped to bouts in that division.
--
-- The view exposes `raw_current_excl_cp` instead of a finished
-- raw_current: it weights every component EXCEPT current_cp, leaving
-- divisional CP injection to the TS materialize script (which has the
-- championship-history.ts data and can scope reigns to a division
-- cheaper than SQL can).
--
-- Wave 14A does NOT touch:
--   - fighter.vertex_score / fighter.vertex_score_all_time (still global)
--   - fighter_vertex_score view (still global)
--   - materialize_vertex_score.ts (still global)
--   - all-time formula (intentionally stays global; divisional all_time
--     is out of scope per the spec)
--   - any compute_* upstream script (this is a view + table addition)
--
-- Locked Wave 15.1 formula is preserved verbatim:
--   raw_current = qw_decayed × 0.16 + current_cp × 0.10
--               + era_dominance_current × 0.06 + perf_diff_current × 0.16
--               + finishing_decayed × 0.10 + activity × 0.12
--               + recent_form × 0.18 - recent_loss_penalty × 0.20
--   curve: ≥60 ×1.50 / ≥45 ×1.45 / ≥25 ×1.30 / <25 ×1.0
--   skid penalty: -25 if losses_last_3 ≥ 3
--   final clamp 0..100

CREATE TABLE IF NOT EXISTS fighter_divisional_score (
  id                          SERIAL PRIMARY KEY,
  fighter_id                  UUID NOT NULL REFERENCES fighter(id) ON DELETE CASCADE,
  division                    weight_class NOT NULL,

  raw_current                 DOUBLE PRECISION,
  multiplied_current          SMALLINT,
  vertex_score                SMALLINT,

  bouts_in_division           SMALLINT NOT NULL,
  last_bout_date_in_division  DATE,
  divisional_status           TEXT NOT NULL,

  quality_wins_decayed        DOUBLE PRECISION,
  divisional_cp               SMALLINT,
  divisional_current_cp       SMALLINT,
  era_dominance_current       DOUBLE PRECISION,
  performance_diff_current    DOUBLE PRECISION,
  finishing_dominance_decayed DOUBLE PRECISION,
  activity                    DOUBLE PRECISION,
  recent_form_score           SMALLINT,
  recent_loss_penalty         DOUBLE PRECISION,

  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fighter_divisional_unique UNIQUE (fighter_id, division)
);

CREATE INDEX IF NOT EXISTS fighter_divisional_fighter_idx
  ON fighter_divisional_score (fighter_id);
CREATE INDEX IF NOT EXISTS fighter_divisional_division_idx
  ON fighter_divisional_score (division);
CREATE INDEX IF NOT EXISTS fighter_divisional_score_idx
  ON fighter_divisional_score (division, vertex_score DESC NULLS LAST);

DROP VIEW IF EXISTS fighter_divisional_vertex_score CASCADE;

CREATE VIEW fighter_divisional_vertex_score AS
WITH
-- Per (fighter, division) record summary.
ufc_record_div AS (
  SELECT
    f.id AS fighter_id,
    b.weight_class AS division,
    COUNT(*)::int AS ufc_bouts,
    COUNT(*) FILTER (WHERE b.winner_id = f.id)::int AS ufc_wins,
    COUNT(*) FILTER (
      WHERE b.winner_id IS NOT NULL AND b.winner_id <> f.id
    )::int AS ufc_losses,
    MAX(e.date) AS last_fight_date
  FROM fighter f
  JOIN bout b ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
  JOIN event e ON e.id = b.event_id
  WHERE b.status = 'completed'
  GROUP BY f.id, b.weight_class
),
-- Recency rank per (fighter, division) for losses_last_N counts.
ranked_bouts_div AS (
  SELECT
    f.id AS f_id,
    b.weight_class AS division,
    b.winner_id,
    e.date AS event_date,
    ROW_NUMBER() OVER (
      PARTITION BY f.id, b.weight_class
      ORDER BY e.date DESC, b.id DESC
    ) AS rn_desc
  FROM fighter f
  JOIN bout b ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
  JOIN event e ON e.id = b.event_id
  WHERE b.status = 'completed'
),
recent_losses_div AS (
  SELECT
    f_id AS fighter_id,
    division,
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
  FROM ranked_bouts_div
  GROUP BY f_id, division
),
-- Per-bout severity (Wave 6E.4.4), partitioned per (fighter, division).
recent_losses_weighted_div AS (
  SELECT
    f.id AS fighter_id,
    b.weight_class AS division,
    e.date AS bout_date,
    (b.winner_id IS NOT NULL AND b.winner_id <> f.id) AS is_loss,
    LEAST(1.0, GREATEST(0.3,
      1.0 - COALESCE(bot.opp_tier_value, 0)::float / 30.0
    )) AS severity,
    ROW_NUMBER() OVER (
      PARTITION BY f.id, b.weight_class
      ORDER BY e.date DESC, b.id DESC
    ) AS rn_desc
  FROM fighter f
  JOIN bout b ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
  JOIN event e ON e.id = b.event_id
  LEFT JOIN bout_opponent_tier bot
    ON bot.bout_id = b.id AND bot.fighter_id = f.id
  WHERE b.status = 'completed'
),
recent_loss_penalty_calc_div AS (
  SELECT
    fighter_id,
    division,
    LEAST(100, ROUND(
        COALESCE(SUM(severity) FILTER (WHERE is_loss AND rn_desc <= 3), 0) * 25
      + COALESCE(SUM(severity) FILTER (WHERE is_loss AND rn_desc <= 5), 0) * 12
      + COALESCE(SUM(severity) FILTER (
          WHERE is_loss AND bout_date >= NOW() - INTERVAL '24 months'
        ), 0) * 6
    ))::int AS recent_loss_penalty
  FROM recent_losses_weighted_div
  GROUP BY fighter_id, division
),
-- Per-bout stats aggregation (division-agnostic — same shape as 0046).
bout_fighter_stats_div AS (
  SELECT
    brs.bout_id,
    brs.fighter_id,
    SUM(brs.sig_str_landed)::int          AS sig_str_landed_total,
    SUM(brs.control_time_seconds)::int    AS control_seconds_total,
    SUM(brs.takedowns_landed)::int        AS takedowns_landed_total,
    SUM(brs.knockdowns)::int              AS knockdowns_total,
    SUM(brs.sub_attempts)::int            AS sub_attempts_total
  FROM bout_round_stats brs
  GROUP BY brs.bout_id, brs.fighter_id
),
-- Last 5 bouts IN THIS DIVISION per fighter.
recent_bouts_window_div AS (
  SELECT
    bf.bout_id,
    bf.fighter_id,
    b.weight_class AS division,
    (b.winner_id = bf.fighter_id) AS is_win,
    e.date AS bout_date,
    b.method::text AS method,
    CASE
      WHEN b.round_finished IS NULL THEN COALESCE(b.scheduled_rounds, 3) * 300
      ELSE (b.round_finished - 1) * 300 + COALESCE(b.time_finished_seconds, 300)
    END AS bout_fight_seconds,
    COALESCE(bot.opp_tier_value, 0) AS opp_tier_value,
    COALESCE(bfs.sig_str_landed_total, 0)        AS sig_landed,
    COALESCE(bfs_opp.sig_str_landed_total, 0)    AS sig_absorbed,
    COALESCE(bfs.control_seconds_total, 0)       AS control_seconds,
    COALESCE(bfs.takedowns_landed_total, 0)      AS td_landed,
    COALESCE(bfs_opp.takedowns_landed_total, 0)  AS opp_td_landed,
    COALESCE(bfs.knockdowns_total, 0)            AS kd_total,
    COALESCE(bfs.sub_attempts_total, 0)          AS sa_total,
    ROW_NUMBER() OVER (
      PARTITION BY bf.fighter_id, b.weight_class
      ORDER BY e.date DESC, b.id DESC
    ) AS recency_rank
  FROM (
    SELECT id AS bout_id, fighter_a_id AS fighter_id, fighter_b_id AS opp_id
    FROM bout WHERE status = 'completed'
    UNION ALL
    SELECT id AS bout_id, fighter_b_id AS fighter_id, fighter_a_id AS opp_id
    FROM bout WHERE status = 'completed'
  ) bf
  JOIN bout b ON b.id = bf.bout_id
  JOIN event e ON e.id = b.event_id
  LEFT JOIN bout_opponent_tier bot
    ON bot.bout_id = bf.bout_id AND bot.fighter_id = bf.fighter_id
  LEFT JOIN bout_fighter_stats_div bfs
    ON bfs.bout_id = bf.bout_id AND bfs.fighter_id = bf.fighter_id
  LEFT JOIN bout_fighter_stats_div bfs_opp
    ON bfs_opp.bout_id = bf.bout_id AND bfs_opp.fighter_id = bf.opp_id
),
recent_performance_div AS (
  SELECT
    fighter_id,
    division,
    COUNT(*) AS recent_bout_count,
    AVG(
      LEAST(100, GREATEST(0,
        50 + ((sig_landed - sig_absorbed)::float * 60.0 / NULLIF(bout_fight_seconds, 0)) * 20.0
      ))
    ) AS recent_striking_dominance,
    AVG(
      CASE
        WHEN bout_fight_seconds = 0 THEN 50.0
        ELSE LEAST(100, GREATEST(0,
          50 + ((control_seconds::float / NULLIF(bout_fight_seconds, 0) * 60.0) - 15.0) * 2.6
        ))
      END
    ) AS recent_control_dominance,
    AVG(
      LEAST(100, GREATEST(0,
        50 + ((td_landed - opp_td_landed)::float * 900.0 / NULLIF(bout_fight_seconds, 0)) * 5.0
      ))
    ) AS recent_td_dominance,
    AVG(
      LEAST(100, GREATEST(0,
        50 + ((sig_landed - sig_absorbed)::float * 60.0 / NULLIF(bout_fight_seconds, 0)) * 20.0
      )) - LEAST(90.0, 50.0 + (50.0 - LEAST(50.0, opp_tier_value::float * 2.0)))
    ) AS recent_adjusted_delta
  FROM recent_bouts_window_div
  WHERE recency_rank <= 5
  GROUP BY fighter_id, division
),
-- recent_form contributions, then aggregator. Split into two CTEs to
-- avoid nested WITH inside a CTE expression.
recent_form_div_contributions AS (
  SELECT
    rbw.fighter_id,
    rbw.division,
    CASE
      WHEN rbw.is_win IS NULL THEN 0
      WHEN rbw.method IS NOT NULL
        AND LOWER(rbw.method) LIKE '%no_contest%' THEN 0
      WHEN rbw.is_win THEN rbw.opp_tier_value::float
      ELSE -(rbw.opp_tier_value::float) *
        CASE
          WHEN rbw.opp_tier_value >= 25 THEN 0.30
          WHEN rbw.opp_tier_value >= 22 THEN 0.45
          WHEN rbw.opp_tier_value >= 14 THEN 0.60
          WHEN rbw.opp_tier_value >= 8  THEN 0.75
          WHEN rbw.opp_tier_value >= 3  THEN 0.90
          ELSE 1.00
        END
    END AS contribution
  FROM recent_bouts_window_div rbw
  WHERE rbw.recency_rank <= 5
),
recent_form_div AS (
  SELECT
    fighter_id,
    division,
    LEAST(100, GREATEST(0, ROUND(50.0 + SUM(contribution) / 5.0)))::int AS recent_form_score,
    COUNT(*) AS recent_bout_count
  FROM recent_form_div_contributions
  GROUP BY fighter_id, division
),
months_since_last_div AS (
  SELECT
    ur.fighter_id,
    ur.division,
    CASE
      WHEN ur.last_fight_date IS NULL THEN NULL
      ELSE EXTRACT(EPOCH FROM (NOW() - ur.last_fight_date)) / (60.0 * 60 * 24 * 30.4375)
    END AS m
  FROM ufc_record_div ur
),
-- Title-fight count signals per (fighter, division). A title bout's
-- weight_class is the bout's weight_class (champion's division at bout
-- date), so the count is naturally division-scoped.
recent_title_fight_counts_div AS (
  SELECT
    f.id AS fighter_id,
    b.weight_class AS division,
    COUNT(*) FILTER (
      WHERE e.date >= NOW() - INTERVAL '24 months'
    )::int AS tf_24mo,
    COUNT(*) FILTER (
      WHERE e.date >= NOW() - INTERVAL '36 months'
    )::int AS tf_36mo
  FROM fighter f
  JOIN bout b ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
  JOIN event e ON e.id = b.event_id
  WHERE b.status = 'completed' AND b.is_title_fight = TRUE
  GROUP BY f.id, b.weight_class
),
-- Per-(fighter, bout) decay factor + opp_tier + finish flags, scoped to
-- bouts in a specific division. The fallback for NULL-method bouts uses
-- the bout-aggregated knockdowns/sub-attempts to identify finishes (same
-- as bout_decay in 0046).
bout_decay_div AS (
  SELECT
    f.id AS fighter_id,
    b.id AS bout_id,
    b.weight_class AS division,
    e.date AS bout_date,
    (b.winner_id = f.id) AS is_win,
    (
      LOWER(COALESCE(b.method::text, '')) LIKE 'ko%'
      OR LOWER(COALESCE(b.method::text, '')) LIKE 'tko%'
      OR LOWER(COALESCE(b.method::text, '')) LIKE 'sub%'
      OR (b.method IS NULL AND COALESCE(bfs.knockdowns_total, 0) > 0)
      OR (b.method IS NULL AND COALESCE(bfs.sub_attempts_total, 0) > 0)
    ) AS is_finish_method,
    COALESCE(bot.opp_tier_value, 0) AS opp_tier_value,
    GREATEST(0.1, LEAST(1.0,
      CASE
        WHEN (EXTRACT(EPOCH FROM (NOW() - e.date)) / (365.25 * 86400)) <= 1.0 THEN 1.0
        WHEN (EXTRACT(EPOCH FROM (NOW() - e.date)) / (365.25 * 86400)) <= 3.0 THEN
          1.0 - 0.7 * ((EXTRACT(EPOCH FROM (NOW() - e.date)) / (365.25 * 86400)) - 1.0) / 2.0
        WHEN (EXTRACT(EPOCH FROM (NOW() - e.date)) / (365.25 * 86400)) <= 5.0 THEN
          0.3 - 0.2 * ((EXTRACT(EPOCH FROM (NOW() - e.date)) / (365.25 * 86400)) - 3.0) / 2.0
        ELSE 0.1
      END
    ))::float AS decay_factor
  FROM fighter f
  JOIN bout b ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
  JOIN event e ON e.id = b.event_id
  LEFT JOIN bout_opponent_tier bot ON bot.bout_id = b.id AND bot.fighter_id = f.id
  LEFT JOIN bout_fighter_stats_div bfs ON bfs.bout_id = b.id AND bfs.fighter_id = f.id
  WHERE b.status = 'completed'
),
quality_wins_decayed_calc_div AS (
  SELECT
    fighter_id,
    division,
    LEAST(100.0, COALESCE(
      SUM(opp_tier_value::float * decay_factor) FILTER (WHERE is_win),
      0
    ))::float AS quality_wins_decayed
  FROM bout_decay_div
  GROUP BY fighter_id, division
),
finishing_dom_decayed_calc_div AS (
  SELECT
    fighter_id,
    division,
    CASE
      WHEN COALESCE(SUM(decay_factor) FILTER (WHERE is_win), 0) = 0 THEN 0.0
      ELSE 100.0
        * COALESCE(SUM(decay_factor) FILTER (WHERE is_win AND is_finish_method), 0)
        / SUM(decay_factor) FILTER (WHERE is_win)
    END::float AS finishing_dominance_decayed
  FROM bout_decay_div
  GROUP BY fighter_id, division
),
components_div AS (
  SELECT
    ur.fighter_id,
    ur.division,
    f.slug,
    f.gender,
    f.roster_status::text AS roster_status,
    f.current_division AS fighter_current_division,
    f.has_upcoming_bout,
    ur.ufc_bouts AS bouts_in_division,
    ur.ufc_wins,
    ur.ufc_losses,
    ur.last_fight_date AS last_fight_date_in_division,

    (
      f.roster_status = 'active'
      AND ur.last_fight_date IS NOT NULL
      AND ur.last_fight_date > NOW() - INTERVAL '24 months'
    ) AS is_active_in_division,

    COALESCE(rl.losses_last_3, 0) AS losses_last_3,
    COALESCE(rl.losses_last_5, 0) AS losses_last_5,
    COALESCE(rl.losses_24mo, 0) AS losses_24mo,

    COALESCE(qwd.quality_wins_decayed, 0)::float AS quality_wins_decayed,
    LEAST(10,
      (CASE WHEN COALESCE(rtfc.tf_24mo, 0) >= 1 THEN 5 ELSE 0 END)
    + (CASE WHEN COALESCE(rtfc.tf_36mo, 0) >= 2 THEN 5 ELSE 0 END)
    )::float AS era_dominance_current,
    (COALESCE(rtfc.tf_24mo, 0) >= 1) AS had_title_fight_recently,
    COALESCE(rfm.recent_form_score, 50)::int AS recent_form_score,

    -- Activity fade reuses the Wave 6E.4.4 curve. Active rostered
    -- fighters get 100 if their most recent bout in this division is
    -- ≤12mo, fading linearly to 50 at 24mo. Non-active fighters fade
    -- from 80 (≤9mo) to 0 (24mo). The has_upcoming_bout override only
    -- applies when the upcoming bout is in this division.
    CASE
      WHEN f.has_upcoming_bout AND f.current_division = ur.division::text THEN 100.0
      WHEN f.roster_status = 'active' AND f.current_division = ur.division::text AND msl.m IS NULL THEN 100.0
      WHEN f.roster_status = 'active' AND f.current_division = ur.division::text AND msl.m <= 12 THEN 100.0
      WHEN f.roster_status = 'active' AND f.current_division = ur.division::text AND msl.m >= 24 THEN 50.0
      WHEN f.roster_status = 'active' AND f.current_division = ur.division::text THEN
        GREATEST(50.0, 100.0 - (msl.m - 12.0) * (50.0 / 12.0))
      WHEN msl.m IS NULL THEN 0.0
      WHEN msl.m < 9 THEN 80.0
      WHEN msl.m < 24 THEN
        GREATEST(0.0, 80.0 - (msl.m - 9.0) * (80.0 / 15.0))
      ELSE 0.0
    END::float AS activity,

    COALESCE(rlp.recent_loss_penalty, 0)::float AS recent_loss_penalty,

    CASE
      WHEN rp.recent_bout_count IS NULL OR rp.recent_bout_count = 0 THEN 50.0
      ELSE LEAST(100, GREATEST(0, ROUND(
          0.45 * (COALESCE(rp.recent_striking_dominance, 50) + COALESCE(rp.recent_adjusted_delta, 0) * 0.5)
        + 0.35 * (COALESCE(rp.recent_control_dominance, 50)  + COALESCE(rp.recent_adjusted_delta, 0) * 0.3)
        + 0.20 * COALESCE(rp.recent_td_dominance, 50)
      )))
    END::float AS performance_diff_current,

    COALESCE(fdd.finishing_dominance_decayed, 0)::float AS finishing_dominance_decayed
  FROM ufc_record_div ur
  JOIN fighter f ON f.id = ur.fighter_id
  LEFT JOIN recent_losses_div rl
    ON rl.fighter_id = ur.fighter_id AND rl.division = ur.division
  LEFT JOIN recent_loss_penalty_calc_div rlp
    ON rlp.fighter_id = ur.fighter_id AND rlp.division = ur.division
  LEFT JOIN recent_performance_div rp
    ON rp.fighter_id = ur.fighter_id AND rp.division = ur.division
  LEFT JOIN recent_form_div rfm
    ON rfm.fighter_id = ur.fighter_id AND rfm.division = ur.division
  LEFT JOIN months_since_last_div msl
    ON msl.fighter_id = ur.fighter_id AND msl.division = ur.division
  LEFT JOIN recent_title_fight_counts_div rtfc
    ON rtfc.fighter_id = ur.fighter_id AND rtfc.division = ur.division
  LEFT JOIN quality_wins_decayed_calc_div qwd
    ON qwd.fighter_id = ur.fighter_id AND qwd.division = ur.division
  LEFT JOIN finishing_dom_decayed_calc_div fdd
    ON fdd.fighter_id = ur.fighter_id AND fdd.division = ur.division
)
SELECT
  fighter_id,
  slug,
  gender,
  division,
  roster_status,
  fighter_current_division,
  has_upcoming_bout,
  bouts_in_division,
  ufc_wins,
  ufc_losses,
  last_fight_date_in_division,
  is_active_in_division,
  losses_last_3,
  losses_last_5,
  losses_24mo,

  quality_wins_decayed,
  era_dominance_current,
  had_title_fight_recently,
  recent_form_score,
  activity,
  recent_loss_penalty,
  performance_diff_current,
  finishing_dominance_decayed,

  -- raw_current EXCLUDING current_cp contribution. The TS materialize
  -- script computes divisional_current_cp (championship-history.ts
  -- restricted to this division + Wave 12 V4c decay) and adds
  -- + divisional_current_cp × 0.10 before applying the curve and skid
  -- penalty. We keep raw_current_excl_cp ungated by GREATEST(0, …) so
  -- the script can audit negative pre-CP rows; downstream final
  -- multiplied is floored at 0 anyway.
  (
      quality_wins_decayed * 0.16
    + era_dominance_current * 0.06
    + performance_diff_current * 0.16
    + finishing_dominance_decayed * 0.10
    + activity * 0.12
    + recent_form_score::float * 0.18
    - recent_loss_penalty * 0.20
  )::float AS raw_current_excl_cp
FROM components_div
WHERE bouts_in_division >= 3;
