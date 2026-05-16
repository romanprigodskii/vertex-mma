-- Wave 15: current_score formula refactor.
--
-- Aggressive recency. recent_form_score becomes the main driver (weight
-- 0.10 → 0.18). Quality-wins and finishing-dominance gain per-bout time
-- decay so older accolades fade instead of carbon-copying into the
-- current rating. era_dominance_current drops the active_champion and
-- double_champion flags (current_cp already covers active-champion
-- credit; double-champion is orthogonal to current form).
--
-- ALL-TIME formula is unchanged. Wave 15 only touches the current branch
-- of fighter_vertex_score.
--
-- Changes vs 0043 / 0044:
--   1. NEW CTE recent_title_fight_counts — replaces recent_title_fight.
--      Counts title bouts in last 24mo and 36mo per fighter; powers the
--      new era_dominance_current formula AND the (kept) had_title_fight_recently
--      surface flag.
--   2. NEW CTE bout_decay — per-(fighter, bout) row with:
--        - decay_factor: piecewise-linear time decay over years since bout
--          (1.0 ≤1y → linear 1.0 → 0.3 in [1, 3]y → linear 0.3 → 0.1 in
--          [3, 5]y → 0.1 floor beyond 5y)
--        - opp_tier_value: from bout_opponent_tier (apex 25 / top5 22 /
--          strong 15 / top10 14 / solid|top15 8 / legacy 4 / ranked 3)
--        - is_win, is_finish_method flags
--      Used by the two new decayed CTEs below.
--   3. NEW CTE quality_wins_decayed_calc — SUM(opp_tier_value × decay)
--      over wins, capped at 100. Replaces f.quality_wins_score in the
--      current_score raw computation (all-time still uses the column).
--   4. NEW CTE finishing_dom_decayed_calc — decay-weighted finish rate
--      among wins, scaled 0..100. Replaces the 6E.4.3 hybrid "50% recent
--      window + 50% career" finishing_dominance_current.
--   5. era_dominance_current formula simplified in components CTE:
--        (5 if title_fight in last 24mo) + (5 if 2+ title_fights in last
--         36mo), capped at 10. Drops the active_champion +10 and
--        double_champion +5 flags entirely.
--   6. Weights rebalanced in raw_current:
--        quality_wins_decayed       × 0.16   (was qw × 0.22)
--        current_cp                 × 0.10   (was 0.12)
--        era_dominance_current      × 0.06   (was 0.08)
--        performance_diff_current   × 0.16   (was 0.18)
--        finishing_dominance_decayed× 0.10   (unchanged weight)
--        activity                   × 0.12   (unchanged)
--        recent_form_score          × 0.18   (was 0.10 — primary boost)
--      - recent_loss_penalty        × 0.20   (unchanged)
--      Positives sum 0.88. soft-multiplier curve and skid penalty
--      unchanged.
--
-- NOT changed: all-time formula (still uses quality_wins,
-- championship_pedigree, era_dominance_all_time, performance_diff,
-- finishing_dominance_score, total_loss_penalty); current_cp logic
-- (Wave 12 + 13.1); recent_form (Wave 9); recent_loss_penalty
-- (Wave 6E.4.4); activity fade (Wave 6E.4.4); performance_diff_current
-- (Wave 6E.4); soft-multiplier curve; skid penalty (-25 at losses_last_3
-- ≥ 3); ufc_bouts ≥ 5 gate.

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
    LEAST(100, GREATEST(0, ROUND(50.0 + SUM(contribution) / 5.0)))::int AS recent_form_score,
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
-- Wave 15: title-fight recency counts. Replaces the recent_title_fight
-- CTE (binary EXISTS in 24mo). The 24mo count drives the kept
-- had_title_fight_recently surface flag (≥1 → TRUE) AND the new
-- era_dominance_current formula. The 36mo count is unique to Wave 15
-- (the "2+ title fights in 36mo" bonus marks sustained title-frame
-- relevance, e.g. an active champion who's defended multiple times).
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
-- Wave 15: per-(fighter, bout) decay-factor + opp_tier + finish flags.
-- decay_factor is the piecewise-linear curve over years-since-bout:
--   0..1y → 1.0 (full credit)
--   1..3y → linear 1.0 → 0.3
--   3..5y → linear 0.3 → 0.1
--   5y+   → 0.1 floor
-- Joined LEFT to bout_opponent_tier so prospect-tier wins (opp_tier=0)
-- contribute 0 to the decayed quality sum but still count toward the
-- finish-rate denominator. is_finish_method uses the same LOWER(LIKE)
-- pattern as the existing finishing_dom CTE (ko%/tko%/sub%) PLUS the
-- NULL-method-with-knockdowns/sub-attempts fallback — the scraped data
-- has NULL method on a substantial share of bouts (including recent
-- ones), so without the fallback fdd would underreport finishers
-- across the board.
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
-- Wave 15: time-decayed quality wins. Sums (opp_tier_value × decay) over
-- wins only, capped at 100. Wins over prospects (opp_tier_value = 0)
-- contribute zero. Drops the +30 undefeated bonus that lived on
-- f.quality_wins_score — current-branch only; the all-time formula
-- still uses f.quality_wins_score with the bonus intact.
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
-- Wave 15: decay-weighted finish rate among wins, scaled 0..100.
-- Replaces the 6E.4.3 hybrid (50% recent window + 50% career). A fighter
-- whose only recent wins are decisions decays toward 0; a fighter whose
-- recent wins are all KO/sub decays toward 100. Older finishes still
-- count, but at progressively reduced weight (the 5y+ floor keeps a
-- veteran finisher from collapsing to 0 even with no recent wins, since
-- both numerator and denominator floor at 0.1 evenly).
finishing_dom_decayed_calc AS (
  SELECT
    fighter_id,
    CASE
      WHEN COALESCE(SUM(decay_factor) FILTER (WHERE is_win), 0) = 0 THEN 0.0
      ELSE 100.0
        * COALESCE(SUM(decay_factor) FILTER (WHERE is_win AND is_finish_method), 0)
        / SUM(decay_factor) FILTER (WHERE is_win)
    END::float AS finishing_dominance_decayed
  FROM bout_decay
  GROUP BY fighter_id
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

    -- All-time quality_wins (unchanged). Kept for the all-time formula
    -- and surfaced for diagnostics.
    COALESCE(f.quality_wins_score, 0)::float AS quality_wins,
    -- Wave 15: time-decayed quality_wins for current_score.
    COALESCE(qwd.quality_wins_decayed, 0)::float AS quality_wins_decayed,

    COALESCE(f.championship_pedigree, 0)::float AS championship_pedigree,
    COALESCE(f.current_cp, 0)::float AS current_cp,

    -- Wave 15: era_dominance_current rebuilt. Drops the active_champion
    -- +10 and double_champion +5 flags entirely (current_cp covers the
    -- active-champion signal; double-champion status is orthogonal to
    -- current form). New signal is pure title-fight recency:
    --   +5 if ≥1 title fight in last 24mo
    --   +5 if ≥2 title fights in last 36mo
    -- Capped at 10. Active champion with a single recent defense gets
    -- 5; active champion who's defended twice in three years gets 10.
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
    -- Wave 15: derive had_title_fight_recently from the new
    -- recent_title_fight_counts CTE (≥1 in 24mo). Same semantic as the
    -- replaced recent_title_fight EXISTS query.
    (COALESCE(rtfc.tf_24mo, 0) >= 1) AS had_title_fight_recently,

    COALESCE(rfm.recent_form_score, 50)::int AS recent_form_score,

    CASE
      WHEN f.has_upcoming_bout THEN 100.0
      WHEN f.roster_status = 'active' AND msl.m IS NULL THEN 100.0
      WHEN f.roster_status = 'active' AND msl.m <= 12 THEN 100.0
      WHEN f.roster_status = 'active' AND msl.m >= 24 THEN 50.0
      WHEN f.roster_status = 'active' THEN
        GREATEST(50.0, 100.0 - (msl.m - 12.0) * (50.0 / 12.0))
      WHEN msl.m IS NULL THEN 0.0
      WHEN msl.m < 9 THEN 80.0
      WHEN msl.m < 24 THEN
        GREATEST(0.0, 80.0 - (msl.m - 9.0) * (80.0 / 15.0))
      ELSE 0.0
    END::float AS activity,

    COALESCE(rlp.recent_loss_penalty, 0)::float AS recent_loss_penalty,

    LEAST(100, COALESCE(ur.ufc_losses, 0) * 4)::float AS total_loss_penalty,

    COALESCE(pd.performance_diff_score, 50)::float AS performance_diff,

    CASE
      WHEN rp.recent_bout_count IS NULL OR rp.recent_bout_count = 0 THEN 50.0
      ELSE LEAST(100, GREATEST(0, ROUND(
          0.45 * (COALESCE(rp.recent_striking_dominance, 50) + COALESCE(rp.recent_adjusted_delta, 0) * 0.5)
        + 0.35 * (COALESCE(rp.recent_control_dominance, 50)  + COALESCE(rp.recent_adjusted_delta, 0) * 0.3)
        + 0.20 * COALESCE(rp.recent_td_dominance, 50)
      )))
    END::float AS performance_diff_current,

    -- All-time finishing_dominance_score (unchanged). Used by all-time
    -- formula AND materialize_vertex_score (writes to fighter.finishing_dominance).
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

    -- Wave 15: decay-weighted finish rate (replaces 6E.4.3 hybrid).
    COALESCE(fdd.finishing_dominance_decayed, 0)::float AS finishing_dominance_decayed
  FROM fighter f
  LEFT JOIN ufc_record ur ON ur.fighter_id = f.id
  LEFT JOIN recent_losses rl ON rl.fighter_id = f.id
  LEFT JOIN recent_loss_penalty_calc rlp ON rlp.fighter_id = f.id
  LEFT JOIN performance_diff pd ON pd.fighter_id = f.id
  LEFT JOIN finishing_dom fd ON fd.fighter_id = f.id
  LEFT JOIN recent_performance rp ON rp.fighter_id = f.id
  LEFT JOIN recent_form rfm ON rfm.fighter_id = f.id
  LEFT JOIN months_since_last msl ON msl.fighter_id = f.id
  LEFT JOIN recent_title_fight_counts rtfc ON rtfc.fighter_id = f.id
  LEFT JOIN quality_wins_decayed_calc qwd ON qwd.fighter_id = f.id
  LEFT JOIN finishing_dom_decayed_calc fdd ON fdd.fighter_id = f.id
),
raw_scores AS (
  SELECT
    *,
    -- Wave 15: rebalanced current_score weights. recent_form (×0.18) is
    -- the primary driver; quality_wins_decayed (×0.16) and
    -- performance_diff_current (×0.16) tie as secondary; activity
    -- (×0.12), current_cp (×0.10), finishing_decayed (×0.10),
    -- era_dominance_current (×0.06). recent_loss_penalty stays at ×0.20
    -- subtracted. Positives sum 0.88.
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
  total_loss_penalty,
  raw_current,
  multiplied_current,

  CASE
    WHEN multiplied_current IS NULL THEN NULL
    WHEN COALESCE(losses_last_3, 0) >= 3 THEN
      GREATEST(0, multiplied_current - 25)
    ELSE multiplied_current
  END AS vertex_score,

  -- All-time formula UNCHANGED (uses f.quality_wins_score via the
  -- components.quality_wins surface; championship_pedigree;
  -- era_dominance_all_time; performance_diff; finishing_dominance_score;
  -- total_loss_penalty).
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
