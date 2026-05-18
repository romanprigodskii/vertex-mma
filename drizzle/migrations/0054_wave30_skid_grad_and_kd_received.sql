-- Wave 30: two independent changes layered onto Wave 26's defensive
-- vulnerability + Wave 15.1's skid penalty.
--
-- A) GRADUATED SKID PENALTY (final-SELECT CASE):
--    Old (Wave 15.1):
--      losses_last_3 >= 3                 → -25
--      else                                → 0
--    New (top-down, larger penalty first):
--      losses_last_3 >= 3                 → -25   (3-of-3 full skid)
--      losses_last_5 >= 3                 → -15   (3-of-5 mixed)
--      losses_last_3 >= 2                 → -10   (2-of-3 recent dip)
--      else                                → 0
--    Roster snapshot of active fighters with ≥5 bouts: ~95 in -25 bucket,
--    ~131 newly fall into -15, ~66 newly fall into -10, ~211 unchanged.
--    Pre-Wave-30 39% of fighters were on some skid but received zero
--    penalty — only the 3-of-3 corner case bit.
--
-- B) KD-RECEIVED IN defensive_vulnerability:
--    New CTE `kd_received_calc` computes per-fight knockdowns-received
--    by summing OPPONENT brs.knockdowns across completed bouts. New
--    column `kd_received_weakness` in defensive_vulnerability_calc:
--      kd_received_weakness = clamp((kd_recv/fight - 0.15) / 0.25, 0, 1)
--    0.15 ≈ roster median, 0.40 ≈ p90. Most fighters get 0.
--    Rebalanced wrestler bucket (Wave 26 was 0.6/0.4):
--      wrestler_vuln = wrestler_intent × (
--          str_def_weakness  × 0.45
--        + sapm_weakness     × 0.25
--        + kd_received_weak  × 0.30
--      )
--    Striker bucket unchanged (counter-skill is td_def). Why only on
--    the wrestler side: a striker absorbing KDs is reading a within-
--    skill weakness (already captured by performance_diff_current's
--    striking dimension); a wrestler eating KDs is a counter-skill hole.
--
-- Calibration data for kd_received_per_fight (roster snapshot):
--   median 0.143, p75 0.250, p90 0.375, p95 0.444
--   Top elites Aspinall/Khabib/Khamzat = 0; Pereira 0.083; Islam/Topuria 0.111.
--   Vulnerable: Jiri 0.444, Walker 0.438, Chandler 0.429.
--
-- Wave 26 (defensive_vulnerability formula skeleton), Wave 24 (RFS),
-- Wave 23 (curve), Wave 22 (pdc), all-time formula, raw_current weights,
-- other CTEs — byte-identical to 0053.

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
recent_losses_weighted AS (
  SELECT
    f.id AS fighter_id,
    e.date AS bout_date,
    (b.winner_id IS NOT NULL AND b.winner_id <> f.id) AS is_loss,
    LEAST(1.0, GREATEST(0.3,
      1.0 - COALESCE(bot.opp_tier_value, 0)::float / 30.0
    )) AS severity,
    ROW_NUMBER() OVER (
      PARTITION BY f.id
      ORDER BY e.date DESC, b.id DESC
    ) AS rn_desc
  FROM fighter f
  JOIN bout b ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
  JOIN event e ON e.id = b.event_id
  LEFT JOIN bout_opponent_tier bot
    ON bot.bout_id = b.id AND bot.fighter_id = f.id
  WHERE b.status = 'completed'
),
recent_loss_penalty_calc AS (
  SELECT
    fighter_id,
    LEAST(100, ROUND(
        COALESCE(SUM(severity) FILTER (WHERE is_loss AND rn_desc <= 3), 0) * 25
      + COALESCE(SUM(severity) FILTER (WHERE is_loss AND rn_desc <= 5), 0) * 12
      + COALESCE(SUM(severity) FILTER (
          WHERE is_loss AND bout_date >= NOW() - INTERVAL '24 months'
        ), 0) * 6
    ))::int AS recent_loss_penalty
  FROM recent_losses_weighted
  GROUP BY fighter_id
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
        0.45 * (50 + (COALESCE(fsa.slpm, 0)::float - COALESCE(fsa.sapm, 0)::float) * 20.0)
      + 0.35 * (
          CASE
            WHEN ctp.total_fight_seconds IS NULL OR ctp.total_fight_seconds = 0 THEN 50
            ELSE LEAST(100, GREATEST(0,
              50 + ((ctp.total_control_seconds / ctp.total_fight_seconds * 60.0) - 15.0) * 2.6
            ))
          END
        )
      + 0.20 * (50 + (
          COALESCE(fsa.td_avg, 0)::float
          - (1.0 - COALESCE(fsa.td_def, 0.5)::float) * 3.0
        ) * 20.0)
    ))) AS performance_diff_score
  FROM fighter_stats_aggregate fsa
  LEFT JOIN control_time_per_fighter ctp ON ctp.fighter_id = fsa.fighter_id
),
finishing_dom AS (
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
bout_fighter_stats AS (
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
recent_bouts_window AS (
  SELECT
    bf.bout_id,
    bf.fighter_id,
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
      PARTITION BY bf.fighter_id
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
  LEFT JOIN bout_fighter_stats bfs
    ON bfs.bout_id = bf.bout_id AND bfs.fighter_id = bf.fighter_id
  LEFT JOIN bout_fighter_stats bfs_opp
    ON bfs_opp.bout_id = bf.bout_id AND bfs_opp.fighter_id = bf.opp_id
),
recent_performance AS (
  SELECT
    fighter_id,
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
  FROM recent_bouts_window
  WHERE recency_rank <= 5
  GROUP BY fighter_id
),
-- Wave 22: per-fighter striking / control / takedown diff dimensions
-- normalised 0..100. Mirrors the per-axis terms inside the old weighted
-- sum but exposed individually so the components CTE can take
-- max + balance instead of a weighted sum.
recent_performance_dims AS (
  SELECT
    fighter_id,
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
  FROM recent_performance
),
recent_form AS (
  WITH bout_contributions AS (
    SELECT
      rbw.fighter_id,
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
    FROM recent_bouts_window rbw
    WHERE rbw.recency_rank <= 5
  )
  SELECT
    fighter_id,
    LEAST(100, GREATEST(0, ROUND(50.0 + SUM(contribution) * 0.30)))::int AS recent_form_score,
    COUNT(*) AS recent_bout_count
  FROM bout_contributions
  GROUP BY fighter_id
),
months_since_last AS (
  SELECT
    ur.fighter_id,
    CASE
      WHEN ur.last_fight_date IS NULL THEN NULL
      ELSE EXTRACT(EPOCH FROM (NOW() - ur.last_fight_date)) / (60.0 * 60 * 24 * 30.4375)
    END AS m
  FROM ufc_record ur
),
recent_title_fight_counts AS (
  SELECT
    f.id AS fighter_id,
    COUNT(*) FILTER (
      WHERE e.date >= NOW() - INTERVAL '24 months'
    )::int AS tf_24mo,
    COUNT(*) FILTER (
      WHERE e.date >= NOW() - INTERVAL '36 months'
    )::int AS tf_36mo
  FROM fighter f
  LEFT JOIN bout b
    ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
    AND b.is_title_fight = TRUE
    AND b.status = 'completed'
  LEFT JOIN event e ON e.id = b.event_id
  GROUP BY f.id
),
bout_decay AS (
  SELECT
    f.id AS fighter_id,
    b.id AS bout_id,
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
  LEFT JOIN bout_fighter_stats bfs ON bfs.bout_id = b.id AND bfs.fighter_id = f.id
  WHERE b.status = 'completed'
),
quality_wins_decayed_calc AS (
  SELECT
    fighter_id,
    LEAST(100.0, COALESCE(
      SUM(opp_tier_value::float * decay_factor) FILTER (WHERE is_win),
      0
    ))::float AS quality_wins_decayed
  FROM bout_decay
  GROUP BY fighter_id
),
-- Wave 21: opp-tier weighted finishing rate. Numerator and denominator
-- both multiplied by GREATEST(opp_tier_value, 1). KOs/subs vs apex
-- opponents weight 25× more than vs prospects; the floor of 1 keeps
-- the denominator non-zero for fighters who only have prospect-tier
-- wins (otherwise the ratio NULLs out and they'd vanish from the
-- score).
finishing_dom_decayed_calc AS (
  SELECT
    fighter_id,
    CASE
      WHEN COALESCE(
        SUM(decay_factor * GREATEST(opp_tier_value, 1)) FILTER (WHERE is_win),
        0
      ) = 0 THEN 0.0
      ELSE 100.0
        * COALESCE(
            SUM(decay_factor * GREATEST(opp_tier_value, 1))
              FILTER (WHERE is_win AND is_finish_method),
            0
          )
        / SUM(decay_factor * GREATEST(opp_tier_value, 1))
            FILTER (WHERE is_win)
    END::float AS finishing_dominance_decayed
  FROM bout_decay
  GROUP BY fighter_id
),
-- Wave 30: knockdowns-received per fight. Joined on bout_round_stats
-- with the OPPONENT side of each completed bout (CASE picks the
-- fighter_id that is NOT f.id), then summed and normalised by bout
-- count. Acts as a raw "you ate KDs" signal that complements sapm
-- (which is a striking-volume proxy and can be high for active
-- strikers throwing/eating in normal exchanges).
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
-- Wave 26 style intents + defensive weaknesses. Wave 30 adds
-- kd_received_weakness from the kd_received_calc CTE above.
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
    -- Wave 30: KD received per fight. Threshold 0.15 (roster median),
    -- max at 0.40 (~p90). Most fighters around p50=0.14 get 0.
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
        -- Striker bucket (Wave 26, unchanged): counter-skill is TD defense.
        striker_intent * td_def_weakness
        -- Wrestler bucket (Wave 30 rebalance): str_def stays primary at
        -- 0.45, sapm drops to 0.25, kd_received takes 0.30.
        + wrestler_intent * (
            str_def_weakness * 0.45
          + sapm_weakness * 0.25
          + kd_received_weakness * 0.30
        )
      ) * 100.0
    ))::float AS defensive_vulnerability
  FROM defensive_vulnerability_calc
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
    COALESCE(qwd.quality_wins_decayed, 0)::float AS quality_wins_decayed,

    COALESCE(f.championship_pedigree, 0)::float AS championship_pedigree,
    COALESCE(f.current_cp, 0)::float AS current_cp,

    LEAST(10,
      (CASE WHEN COALESCE(rtfc.tf_24mo, 0) >= 1 THEN 5 ELSE 0 END)
    + (CASE WHEN COALESCE(rtfc.tf_36mo, 0) >= 2 THEN 5 ELSE 0 END)
    )::float AS era_dominance_current,
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
    (COALESCE(rtfc.tf_24mo, 0) >= 1) AS had_title_fight_recently,

    COALESCE(rfm.recent_form_score, 50)::int AS recent_form_score,

    -- Wave 21: layered activity. Mirrors radar Wave 20 max(layer_12,
    -- layer_24, layer_36) where each layer = clamp(fights × avg_tier /
    -- period_target × 100). Period targets 60/120/180 = 3 fights ×
    -- tier 20 per year cadence. Falls back to 0 when all bands are
    -- empty (retired fighters with no recent activity read 0). Drops
    -- the previous time-since-last-fight fade entirely.
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

    LEAST(100, COALESCE(ur.ufc_losses, 0) * 4)::float AS total_loss_penalty,

    COALESCE(pd.performance_diff_score, 50)::float AS performance_diff,

    -- Wave 22: max × (1 + 0.25 × balance_ratio). Specialists keep
    -- full credit via their strongest axis (Pereira striker, Khabib
    -- wrestler). Universalists earn up to +25% multiplied INTO their
    -- max, so mediocre balanced fighters can't push their score up
    -- by being equally average everywhere. Fighters with no recent
    -- bouts still read 50.
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
    ))::float AS finishing_dominance_score,

    COALESCE(fdd.finishing_dominance_decayed, 0)::float AS finishing_dominance_decayed,

    -- Wave 26: style-weighted defensive vulnerability (0..100). See
    -- defensive_vulnerability_score CTE above for the formula.
    COALESCE(dvs.defensive_vulnerability, 0)::float AS defensive_vulnerability
  FROM fighter f
  LEFT JOIN ufc_record ur ON ur.fighter_id = f.id
  LEFT JOIN recent_losses rl ON rl.fighter_id = f.id
  LEFT JOIN recent_loss_penalty_calc rlp ON rlp.fighter_id = f.id
  LEFT JOIN performance_diff pd ON pd.fighter_id = f.id
  LEFT JOIN finishing_dom fd ON fd.fighter_id = f.id
  LEFT JOIN recent_performance rp ON rp.fighter_id = f.id
  LEFT JOIN recent_performance_dims rpd ON rpd.fighter_id = f.id
  LEFT JOIN recent_form rfm ON rfm.fighter_id = f.id
  LEFT JOIN months_since_last msl ON msl.fighter_id = f.id
  LEFT JOIN recent_title_fight_counts rtfc ON rtfc.fighter_id = f.id
  LEFT JOIN quality_wins_decayed_calc qwd ON qwd.fighter_id = f.id
  LEFT JOIN finishing_dom_decayed_calc fdd ON fdd.fighter_id = f.id
  LEFT JOIN defensive_vulnerability_score dvs ON dvs.fighter_id = f.id
),
raw_scores AS (
  SELECT
    *,
    CASE
      WHEN is_active AND ufc_bouts >= 5 THEN
        GREATEST(0,
            quality_wins_decayed * 0.16
          + current_cp * 0.10
          + era_dominance_current * 0.06
          + performance_diff_current * 0.16
          + finishing_dominance_decayed * 0.10
          + activity * 0.12
          + recent_form_score::float * 0.18
          - recent_loss_penalty * 0.20
          - defensive_vulnerability * 0.10
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
      WHEN raw_current >= 67 THEN 100
      WHEN raw_current >= 60 THEN
        LEAST(100, ROUND(90 + (raw_current - 60) * (10.0 / 7.0)))::int
      WHEN raw_current >= 45 THEN
        LEAST(100, ROUND(65.25 + (raw_current - 45) * 1.65))::int
      WHEN raw_current >= 25 THEN
        LEAST(100, ROUND(25 + (raw_current - 25) * 2.0125))::int
      ELSE
        GREATEST(0, ROUND(raw_current * 1.0))::int
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
  recent_form_score,
  quality_wins,
  quality_wins_decayed,
  championship_pedigree,
  current_cp,
  era_dominance_current,
  era_dominance_all_time,
  had_title_fight_recently,
  performance_diff,
  performance_diff_current,
  finishing_dominance_score,
  finishing_dominance_decayed,
  activity,
  recent_loss_penalty,
  defensive_vulnerability,
  total_loss_penalty,
  raw_current,
  multiplied_current,

  CASE
    WHEN multiplied_current IS NULL THEN NULL
    -- Wave 30 graduated skid penalty. Top-down: 3-of-3 catches first,
    -- so the 3-of-5 / 2-of-3 branches only fire for fighters who don't
    -- already have full 3-of-3.
    WHEN COALESCE(losses_last_3, 0) >= 3 THEN
      GREATEST(0, multiplied_current - 25)
    WHEN COALESCE(losses_last_5, 0) >= 3 THEN
      GREATEST(0, multiplied_current - 15)
    WHEN COALESCE(losses_last_3, 0) >= 2 THEN
      GREATEST(0, multiplied_current - 10)
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
