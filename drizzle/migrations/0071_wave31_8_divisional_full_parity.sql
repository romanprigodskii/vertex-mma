-- Wave 31.8: full divisional ↔ global formula parity.
--
-- fighter_divisional_vertex_score trailed the global view by three waves.
-- This brings them into alignment so global and divisional scores for the
-- same fighter only differ by the legitimate scoping (divisional counts
-- bouts in one division), not by formula vintage.
--
-- Three changes mirrored from the global view (migration 0068):
--
--   1. WAVE 22 — performance_diff_current as max + balance bonus.
--      Old divisional formula: weighted sum 0.45 striking + 0.35 control
--      + 0.20 td. That dilutes a specialist (Pereira's striking averaged
--      down by mediocre takedowns). New: take the strongest of the three
--      axes, then add up to +25% scaled by how balanced the other two
--      are. Specialists keep full credit; universalists earn the bonus.
--      New CTE recent_performance_dims_div exposes the three 0..100 axis
--      scores (mirrors global recent_performance_dims).
--
--   2. WAVE 26/30 — defensive_vulnerability penalty.
--      The divisional raw score had no defensive term at all. Adds the
--      style-weighted vulnerability (striker eating takedowns / wrestler
--      eating strikes + knockdowns) as `- defensive_vulnerability × 0.10`,
--      same weight as global. Wave 30's KD-received signal is included.
--      CTEs kd_received_calc / defensive_vulnerability_calc /
--      defensive_vulnerability_score are CAREER-WIDE (one row per
--      fighter) — copied verbatim from global. Defensive vulnerability
--      is a career style trait; the global view itself derives it from
--      career fighter_stats_aggregate, so career scope here is consistent.
--
--   3. WAVE 30 — graduated skid penalty (-10/-15/-25) replaces the flat
--      -25-at-3 skid. Applied in materialize_divisional_score.ts (same
--      commit) — the view already exposes losses_last_3 / losses_last_5.
--
--   4. WAVE 21 — layered activity. The divisional view still used the
--      old step-function fade (≈100 for any active fighter); global
--      moved to max(fights × avg_opp_tier / target) over 12/24/36mo
--      windows long ago. The step function made divisional overshoot
--      global by 8-10 points for active fighters once 22/26/30 landed.
--      Now identical to global (career fights_last_Nmo columns).
--
-- raw_current_excl_cp weights after this migration (CP added in TS):
--   qw_decayed 0.16 + era 0.06 + perf_diff 0.16 + finishing 0.10
--   + activity 0.12 + recent_form 0.18 - recent_loss_penalty 0.20
--   - defensive_vulnerability 0.10 - layoff_penalty
-- — identical to global's positive/penalty structure (global also has
-- current_cp 0.10, injected by the TS materialize step here).
--
-- materialize_divisional_score.ts is updated in the same commit for the
-- graduated skid. Re-materialize after applying:
--   pnpm tsx scripts/materialize_divisional_score.ts
--
-- All other CTEs — byte-identical to 0069 (Wave 31.5).

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
-- Wave 31.8: per-axis 0..100 diff dimensions, div-scoped. Mirrors the
-- global view's recent_performance_dims — feeds the Wave 22 max+balance
-- performance_diff_current.
recent_performance_dims_div AS (
  SELECT
    fighter_id,
    division,
    recent_bout_count,
    LEAST(100.0, GREATEST(0.0,
      COALESCE(recent_striking_dominance, 50) + COALESCE(recent_adjusted_delta, 0) * 0.5
    ))::float AS striking_diff_score,
    LEAST(100.0, GREATEST(0.0,
      COALESCE(recent_control_dominance, 50) + COALESCE(recent_adjusted_delta, 0) * 0.3
    ))::float AS control_diff_score,
    LEAST(100.0, GREATEST(0.0,
      COALESCE(recent_td_dominance, 50)
    ))::float AS td_diff_score
  FROM recent_performance_div
),
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
-- Wave 31.8: career-wide KD-received (Wave 30). Not div-scoped — a
-- counter to opponent knockdowns is a career style trait. Copied
-- verbatim from the global view (migration 0068).
kd_received_calc AS (
  SELECT
    f.id AS fighter_id,
    COALESCE(SUM(brs.knockdowns), 0)::float AS total_kd_received,
    COUNT(DISTINCT b.id)::int AS bouts_counted,
    CASE
      WHEN COUNT(DISTINCT b.id) > 0 THEN
        COALESCE(SUM(brs.knockdowns), 0)::float / COUNT(DISTINCT b.id)::float
      ELSE 0.0
    END AS kd_received_per_fight
  FROM fighter f
  LEFT JOIN bout b
    ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
    AND b.status = 'completed'
  LEFT JOIN bout_round_stats brs
    ON brs.bout_id = b.id
    AND brs.fighter_id = CASE
      WHEN b.fighter_a_id = f.id THEN b.fighter_b_id
      ELSE b.fighter_a_id
    END
  GROUP BY f.id
),
-- Wave 31.8: career-wide style intents + defensive weaknesses (Wave
-- 26/30). Copied verbatim from the global view.
defensive_vulnerability_calc AS (
  SELECT
    f.id AS fighter_id,
    LEAST(1.0, COALESCE(fsa.slpm, 0)::float / 5.0)::float AS striker_intent,
    LEAST(1.0, COALESCE(fsa.td_avg, 0)::float / 2.0)::float AS wrestler_intent,
    (GREATEST(0.0, 0.55 - COALESCE(fsa.td_def, 0.55)::float) / 0.55)::float
      AS td_def_weakness,
    (GREATEST(0.0, 0.55 - COALESCE(fsa.str_def, 0.55)::float) / 0.55)::float
      AS str_def_weakness,
    (LEAST(1.0, GREATEST(0.0, COALESCE(fsa.sapm, 0)::float - 4.0) / 4.0))::float
      AS sapm_weakness,
    (LEAST(1.0, GREATEST(0.0,
      COALESCE(kdr.kd_received_per_fight, 0.0) - 0.15
    ) / 0.25))::float AS kd_received_weakness
  FROM fighter f
  LEFT JOIN fighter_stats_aggregate fsa ON fsa.fighter_id = f.id
  LEFT JOIN kd_received_calc kdr ON kdr.fighter_id = f.id
),
defensive_vulnerability_score AS (
  SELECT
    fighter_id,
    LEAST(100.0, GREATEST(0.0,
      (
        striker_intent * td_def_weakness
        + wrestler_intent * (
            str_def_weakness * 0.45
          + sapm_weakness * 0.25
          + kd_received_weakness * 0.30
        )
      ) * 100.0
    ))::float AS defensive_vulnerability
  FROM defensive_vulnerability_calc
),
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

    COALESCE(mrb.most_recent_is_loss, FALSE) AS most_recent_is_loss,

    COALESCE(qwd.quality_wins_decayed, 0)::float AS quality_wins_decayed,
    LEAST(10,
      (CASE WHEN COALESCE(rtfc.tf_24mo, 0) >= 1 THEN 5 ELSE 0 END)
    + (CASE WHEN COALESCE(rtfc.tf_36mo, 0) >= 2 THEN 5 ELSE 0 END)
    )::float AS era_dominance_current,
    (COALESCE(rtfc.tf_24mo, 0) >= 1) AS had_title_fight_recently,
    COALESCE(rfm.recent_form_score, 50)::int AS recent_form_score,

    -- Wave 31.8: Wave 21 layered activity — max over 12/24/36mo windows
    -- of (fights × avg opp tier / period target × 100). Replaces the old
    -- step-function fade (≈100 for any active fighter), which made the
    -- divisional score overshoot global. Uses the career fights_last_Nmo
    -- columns; the divisional rows kept are all the fighter's current
    -- division, so career activity == divisional activity. Identical to
    -- the global view.
    GREATEST(
      LEAST(100.0,
        COALESCE(f.fights_last_12mo, 0)::float
        * COALESCE(f.avg_opp_tier_last_12mo, 0)::float / 60.0 * 100.0
      ),
      LEAST(100.0,
        COALESCE(f.fights_last_24mo, 0)::float
        * COALESCE(f.avg_opp_tier_last_24mo, 0)::float / 120.0 * 100.0
      ),
      LEAST(100.0,
        COALESCE(f.fights_last_36mo, 0)::float
        * COALESCE(f.avg_opp_tier_last_36mo, 0)::float / 180.0 * 100.0
      )
    )::float AS activity,

    COALESCE(rlp.recent_loss_penalty, 0)::float AS recent_loss_penalty,

    -- Wave 31.8: Wave 22 max + balance. Strongest of the three axes,
    -- lifted up to +25% by how balanced the weaker two are. Specialists
    -- keep full credit; universalists earn the bonus.
    CASE
      WHEN rpd.recent_bout_count IS NULL OR rpd.recent_bout_count = 0 THEN 50.0
      ELSE LEAST(100.0,
        GREATEST(rpd.striking_diff_score, rpd.control_diff_score, rpd.td_diff_score)
        * (
          1.0
          + 0.25
            * LEAST(rpd.striking_diff_score, rpd.control_diff_score, rpd.td_diff_score)
              / GREATEST(GREATEST(rpd.striking_diff_score, rpd.control_diff_score, rpd.td_diff_score), 1.0)
        )
      )
    END::float AS performance_diff_current,

    COALESCE(fdd.finishing_dominance_decayed, 0)::float AS finishing_dominance_decayed,

    -- Wave 31.8: career-wide style-weighted defensive vulnerability.
    COALESCE(dvs.defensive_vulnerability, 0)::float AS defensive_vulnerability,

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
  LEFT JOIN recent_performance_dims_div rpd
    ON rpd.fighter_id = ur.fighter_id AND rpd.division = ur.division
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
  LEFT JOIN defensive_vulnerability_score dvs
    ON dvs.fighter_id = ur.fighter_id
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
  defensive_vulnerability,

  age_years,
  age_factor,
  months_since_last,
  layoff_penalty,

  -- Wave 31.8: defensive_vulnerability subtracted in-view alongside
  -- layoff_penalty. The age multiplier + current_cp injection happen in
  -- materialize_divisional_score.ts, matching the global view's
  -- (positives + cp - penalties) × (1 + age_factor) structure.
  (
      quality_wins_decayed * 0.16
    + era_dominance_current * 0.06
    + performance_diff_current * 0.16
    + finishing_dominance_decayed * 0.10
    + activity * 0.12
    + recent_form_score::float * 0.18
    - recent_loss_penalty * 0.20
    - defensive_vulnerability * 0.10
    - layoff_penalty
  )::float AS raw_current_excl_cp
FROM components_div
WHERE bouts_in_division >= 3;
