-- Wave 31.5: divisional view parity with Wave 31.
--
-- fighter_divisional_vertex_score was intentionally locked at Wave 15.1
-- formula by 0047. Wave 31 changes need to mirror here so global and
-- divisional scores don't drift out of sync at the top end:
--
--   1. AGE CURVE — new column age_factor on the view output. Applied as
--      multiplier in materialize_divisional_score.ts (after CP injection,
--      before curve), matching the global flow which applies it in-view
--      because global has all positives in one place.
--
--   2. LAYOFF PENALTY — subtracted directly inside raw_current_excl_cp.
--      Same formula as global: LEAST(15, GREATEST(0, (m-12)×0.5)).
--      Conservative: only triggered when m > 12.
--
--   3. RECENCY-WEIGHTED recent_form_div — same rn=1→2.0, rn=5→0.5 schedule
--      and same `× 1.50` post-normalisation as global Wave 31. All-wins
--      case remains identical to Wave 15.1; mixed case bites the most
--      recent loss harder.
--
--   4. MOST_RECENT_IS_LOSS flag — exposed for TS to apply fresh-loss
--      penalty after skid.
--
-- The view does NOT apply the age multiplier or the new curve; those
-- happen in TS because:
--   (a) divisional_current_cp is computed in TS from championship-history
--       and added to raw_current_excl_cp there.
--   (b) the curve and skid penalty are already in TS (applyCurve +
--       skidPenalty constant in materialize_divisional_score.ts), so it's
--       cleaner to keep all post-CP math in one place.
--
-- Out of scope (divisional still trails global on these):
--   - Wave 22 max+balance performance_diff_current
--   - Wave 26 defensive_vulnerability subtraction
--   - Wave 30 graduated skid (-10/-15/-25)
-- These can land in a future divisional parity pass. The Wave 31
-- ceiling/recency/age fixes are the load-bearing ones — without them
-- divisional rankings would still have the Pereira-at-100 problem.
--
-- materialize_divisional_score.ts is updated in the same commit:
--   - SELECT now includes age_factor, months_since_last, layoff_penalty,
--     most_recent_is_loss
--   - rawCurrent = (raw_current_excl_cp + cp×0.1) × (1 + age_factor)
--   - applyCurve uses Wave 31 anchors: (0,0)/(25,25)/(45,60)/(60,80)/(75,93)/(88,100)
--   - vertexScore subtracts 5 when most_recent_is_loss AND skid didn't fire
--
-- All other CTEs in this view — byte-identical to 0047.

DROP VIEW IF EXISTS fighter_divisional_vertex_score CASCADE;

CREATE VIEW fighter_divisional_vertex_score AS
WITH
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
-- Wave 31.5: most-recent-bout-in-division flag.
most_recent_bout_div AS (
  SELECT
    f_id AS fighter_id,
    division,
    (winner_id IS NOT NULL AND winner_id <> f_id) AS most_recent_is_loss
  FROM ranked_bouts_div
  WHERE rn_desc = 1
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
-- Wave 31.5: recency-weighted contributions. Mirrors the global view's
-- recent_form recency weights (rn=1 → 2.0 down to rn=5 → 0.5).
recent_form_div_contributions AS (
  SELECT
    rbw.fighter_id,
    rbw.division,
    rbw.recency_rank,
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
    END AS contribution,
    CASE rbw.recency_rank
      WHEN 1 THEN 2.00
      WHEN 2 THEN 1.50
      WHEN 3 THEN 1.00
      WHEN 4 THEN 0.75
      WHEN 5 THEN 0.50
      ELSE 0.00
    END::float AS recency_weight
  FROM recent_bouts_window_div rbw
  WHERE rbw.recency_rank <= 5
),
recent_form_div AS (
  SELECT
    fighter_id,
    division,
    LEAST(100, GREATEST(0, ROUND(
      50.0
      + (SUM(contribution * recency_weight) / NULLIF(SUM(recency_weight), 0))
        * 1.50
    )))::int AS recent_form_score,
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
-- Wave 31.5: age curve. Per-fighter (not div-scoped) — same fighter has
-- same age across all their divisions.
fighter_age_calc_div AS (
  SELECT
    f.id AS fighter_id,
    CASE
      WHEN f.dob IS NULL THEN NULL
      ELSE FLOOR(EXTRACT(EPOCH FROM (NOW() - f.dob)) / (365.25 * 86400))::int
    END AS age_years,
    CASE
      WHEN f.dob IS NULL THEN 0.00
      WHEN FLOOR(EXTRACT(EPOCH FROM (NOW() - f.dob)) / (365.25 * 86400)) < 26 THEN 0.00
      WHEN FLOOR(EXTRACT(EPOCH FROM (NOW() - f.dob)) / (365.25 * 86400)) <= 30 THEN  0.05
      WHEN FLOOR(EXTRACT(EPOCH FROM (NOW() - f.dob)) / (365.25 * 86400)) <= 32 THEN  0.02
      WHEN FLOOR(EXTRACT(EPOCH FROM (NOW() - f.dob)) / (365.25 * 86400)) <= 34 THEN  0.00
      WHEN FLOOR(EXTRACT(EPOCH FROM (NOW() - f.dob)) / (365.25 * 86400)) <= 36 THEN -0.04
      WHEN FLOOR(EXTRACT(EPOCH FROM (NOW() - f.dob)) / (365.25 * 86400)) <= 38 THEN -0.08
      ELSE -0.12
    END::float AS age_factor
  FROM fighter f
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

    -- Wave 31.5: surface most_recent_is_loss for the TS fresh-loss branch.
    COALESCE(mrb.most_recent_is_loss, FALSE) AS most_recent_is_loss,

    COALESCE(qwd.quality_wins_decayed, 0)::float AS quality_wins_decayed,
    LEAST(10,
      (CASE WHEN COALESCE(rtfc.tf_24mo, 0) >= 1 THEN 5 ELSE 0 END)
    + (CASE WHEN COALESCE(rtfc.tf_36mo, 0) >= 2 THEN 5 ELSE 0 END)
    )::float AS era_dominance_current,
    (COALESCE(rtfc.tf_24mo, 0) >= 1) AS had_title_fight_recently,
    COALESCE(rfm.recent_form_score, 50)::int AS recent_form_score,

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

    COALESCE(fdd.finishing_dominance_decayed, 0)::float AS finishing_dominance_decayed,

    -- Wave 31.5: age + layoff signals.
    fac.age_years,
    COALESCE(fac.age_factor, 0.0)::float AS age_factor,
    msl.m::float AS months_since_last,
    CASE
      WHEN msl.m IS NULL OR msl.m <= 12 THEN 0.0
      ELSE LEAST(15.0, (msl.m - 12.0) * 0.5)
    END::float AS layoff_penalty

  FROM ufc_record_div ur
  JOIN fighter f ON f.id = ur.fighter_id
  LEFT JOIN recent_losses_div rl
    ON rl.fighter_id = ur.fighter_id AND rl.division = ur.division
  LEFT JOIN most_recent_bout_div mrb
    ON mrb.fighter_id = ur.fighter_id AND mrb.division = ur.division
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
  LEFT JOIN fighter_age_calc_div fac
    ON fac.fighter_id = ur.fighter_id
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
  most_recent_is_loss,

  quality_wins_decayed,
  era_dominance_current,
  had_title_fight_recently,
  recent_form_score,
  activity,
  recent_loss_penalty,
  performance_diff_current,
  finishing_dominance_decayed,

  age_years,
  age_factor,
  months_since_last,
  layoff_penalty,

  -- Wave 31.5: layoff_penalty subtracted in-view. The age multiplier is
  -- applied in TS (after CP injection) so the multiplication semantically
  -- matches the global view (positives + CP, then × (1+age_factor)).
  (
      quality_wins_decayed * 0.16
    + era_dominance_current * 0.06
    + performance_diff_current * 0.16
    + finishing_dominance_decayed * 0.10
    + activity * 0.12
    + recent_form_score::float * 0.18
    - recent_loss_penalty * 0.20
    - layoff_penalty
  )::float AS raw_current_excl_cp
FROM components_div
WHERE bouts_in_division >= 3;
