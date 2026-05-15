-- Wave 9: recent_form_score replaces streak_bonus.
--
-- The 6E.4 Part B streak_bonus mechanism (quality-scaled wins-only)
-- buried dominant ex-champions who lost a single title fight to elite
-- opposition. Merab (4 title defenses + 1 apex loss to Yan) was sitting
-- at 71 vs Yan at 92 because streak_bonus contributed +17 for Yan and
-- 0 for Merab (negative current_streak). Same pattern for Volk (2 apex
-- losses recently), Pantoja (4 defenses + Van loss), Holloway (mixed).
--
-- recent_form_score replaces this with a continuous per-bout signal:
--   For each of the last 5 bouts:
--     WIN  → contribution = +opp_tier_value (apex 25, top5 22, etc.)
--     LOSS → contribution = -opp_tier_value × loss_severity
--     NC   → contribution = 0
--
--   loss_severity (tier-graduated):
--     opp_tier ≥ 25 (apex)     → × 0.30 (elite floor)
--     opp_tier ≥ 22 (top5)     → × 0.45
--     opp_tier ≥ 14 (top10)    → × 0.60
--     opp_tier ≥  8 (top15)    → × 0.75
--     opp_tier ≥  3 (ranked)   → × 0.90
--     prospect/unranked        → × 1.00
--
--   recent_form_score = clamp(0, 100, 50 + sum(contributions) / 5)
--
-- Used in raw_current at × 0.10 weight (same max-impact ceiling as the
-- old quality-scaled streak_bonus). A pure 5-win streak through apex
-- opp yields rf=100 (50 + 25); a 5-loss skid through prospects yields
-- rf=0 (50 - 50). A mixed 4-win-1-elite-loss vs top-5 contender:
-- 50 + (4×22 - 22×0.45)/5 = 50 + (88 - 9.9)/5 = 50 + 15.6 = 66.
--
-- The streak_opp_quality CTE (used only by the old streak_bonus) is
-- dropped from this view. The current_streak_bonus output field is
-- also dropped. streak_opp_avg_tier likewise dropped from the output.
-- The view's output column list shrinks by 2 columns; no downstream
-- consumer references either (only import_roster_watch.ts had a stale
-- comment mentioning current_streak_bonus, no code dependency).
--
-- Locked-in (unchanged): all-time formula, other component weights,
-- multiplier curve, skid penalty, ufc_bouts gates,
-- championship_pedigree (with 6E.2 sticky rule), quality_wins
-- multipliers, era_dominance current/all-time, performance_diff_current,
-- finishing_dominance hybrid (6E.4.3), recent_loss_penalty
-- (tier-discount + bout-recency from 6E.4.4), activity smooth fade
-- (12→24 from 6E.4.4). Reuses bout_opponent_tier from 6E.4 Part A.

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
-- Wave 6E.4.4: per-(fighter, bout) row with tier-discount severity and
-- a bout-recency rank. We rank over ALL completed bouts (not just
-- losses) so that "last 3 bouts" means actual last 3 bouts — preserving
-- the original recent_loss_penalty semantics. is_loss is a per-row flag
-- and the SUM(severity) aggregation downstream applies a FILTER on it,
-- so fighters with recent wins between older losses correctly score
-- those wins as "no loss in last 3 bouts" instead of treating their 3
-- most-recent-losses-ever as if they were back-to-back.
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
-- Wave 6E.4.4: aggregate per-loss severities into the final
-- recent_loss_penalty value. Multipliers (×25/×12/×6) and the
-- last_3/last_5/24mo layered structure preserved verbatim from the
-- pre-6E.4.4 formula; the only change is that each loss contributes
-- its severity (0.3-1.0, scaled by opp_tier) instead of 1.0 flat.
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
  -- All-time control-time aggregate. Used by performance_diff (all-time
  -- path) below. The current path computes per-bout control inline in
  -- recent_performance instead.
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
  -- All-time performance differential. Used ONLY by the all-time formula
  -- below. Current formula uses recent_performance.
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
  -- All-time finishing dominance (Wave 6E.1 formula). Used by all-time
  -- path. Current path uses recent_finishing.
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
-- Wave 6E.4.3: career finishing signal for the hybrid finishing_dom
-- formula. Pulls total_kd/total_sa/ko_rate/sub_rate from finishing_dom
-- (already aggregated from bout_round_stats + bout.method, with the
-- existing NULL-method → kd>0 fallback) and ufc_record.ufc_bouts as
-- the per-fight denominator. Career signal = sum of four components,
-- clamped 0..100 downstream when blended with the recent signal:
--   KD per fight × 35  → ~35 for a 1-KD-per-fight power striker
--   SA per fight × 35  → ~35 for a 1-attempt-per-fight grappler
--   KO+TKO win rate × 90 → 90 for a pure-finisher (100% KO wins)
--   Sub win rate × 90    → 90 for a pure-submission specialist
--
-- Multipliers bumped ×2.5 from the initial spec (×14, ×35) so that
-- recovered fighters with low-ish per-fight knockdown/submission rates
-- but legitimate career finishing track records (Yan, Volk, Shevchenko,
-- Usman) reach the 30-70 finc range the dev spec'd. The clamp at 100
-- keeps elite pure-finishers from running away.
--
-- Fighters with no UFC bouts or 0 wins resolve to 0 via the NULLIF
-- guards; the 50/50 hybrid downstream handles the COALESCE.
career_finishing AS (
  SELECT
    fd.fighter_id,
    COALESCE(fd.total_kd, 0) * 35.0
      / NULLIF(ur.ufc_bouts, 0)::float AS career_kd_signal,
    COALESCE(fd.total_sa, 0) * 35.0
      / NULLIF(ur.ufc_bouts, 0)::float AS career_sa_signal,
    COALESCE(fd.ko_rate, 0) * 90.0     AS career_ko_rate_signal,
    COALESCE(fd.sub_rate, 0) * 90.0    AS career_sub_rate_signal
  FROM finishing_dom fd
  JOIN ufc_record ur ON ur.fighter_id = fd.fighter_id
),
-- Wave 6E.4: per-(bout, fighter) aggregates. Used by recent_bouts_window
-- below to compute per-bout dominance signals. Two rows per completed
-- bout (one per fighter perspective). knockdowns/sub_attempts let
-- recent_finishing infer KO/submission when bout.method is NULL (the
-- scraper inconsistently populates method on some imported bouts; the
-- existing all-time finishing_dom CTE uses the same fallback pattern).
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
-- Wave 6E.4: last-5-bouts window per fighter. Joins bout_opponent_tier
-- for opp_tier_value (apex 25 / top5 22 / strong 15 / top10 14 / solid|
-- top15 8 / legacy 4 / ranked 3 / prospect 0) and bout_fighter_stats
-- (both sides) for per-bout dominance computation.
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
-- Wave 6E.4: opp-adjusted recent performance metrics, aggregated across
-- the last 5 UFC bouts per fighter (or fewer if fighter has fewer; the
-- ufc_bouts ≥ 5 gate downstream guarantees ≥5 in practice).
--
-- Per-bout dominance signals (all clamped 0..100):
--   striking : 50 + (sig_landed - sig_absorbed) * 60/bout_seconds * 20
--              ↑ matches existing all-time SLpM-SApM differential formula
--   control  : 50 + (control_per_min - 15) * 2.6
--              ↑ matches existing all-time control-part calibration
--   takedown : 50 + (td_landed - opp_td_landed) * 900/bout_seconds * 5
--              ↑ similar per-15min normalization to finishing_dom rates
--
-- recent_adjusted_delta is the AVG of (per-bout striking dominance −
-- expected dominance for that opp tier). Expected curve:
--   opp_tier 25 (apex)    → expected 50  (1-1 fight expected)
--   opp_tier 22 (top5)    → expected 56
--   opp_tier 15 (strong)  → expected 70
--   opp_tier 14 (top10)   → expected 72
--   opp_tier  8 (solid)   → expected 84
--   opp_tier  4 (legacy)  → expected 92 → cap 90
--   opp_tier  0 (prospect)→ expected 100 → cap 90
-- Positive delta = overperformed for tier; negative = underperformed.
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
-- Wave 6E.4: opp-weighted realized finishes across the last 5 bouts.
-- Each KO/TKO/sub win contributes (1 + opp_tier_value / 25.0) — a finish
-- over an apex (tier 25) opp = 2.0× weight; over a prospect = 1.0×.
-- kd_total / sa_total fallback infers KO/sub when method is NULL (same
-- pattern as the existing all-time finishing_dom CTE).
recent_finishing AS (
  SELECT
    fighter_id,
    COUNT(*) AS recent_bout_count,
    SUM(CASE
      WHEN is_win AND (
        LOWER(COALESCE(method, '')) LIKE 'ko%'
        OR LOWER(COALESCE(method, '')) LIKE 'tko%'
        OR LOWER(COALESCE(method, '')) LIKE 'sub%'
        OR (method IS NULL AND kd_total > 0)
        OR (method IS NULL AND sa_total > 0)
      )
      THEN 1.0 + opp_tier_value::float / 25.0
      ELSE 0
    END) AS recent_finish_score,
    SUM(bout_fight_seconds)::float AS recent_total_seconds
  FROM recent_bouts_window
  WHERE recency_rank <= 5
  GROUP BY fighter_id
),
-- Wave 9: recent_form_score — replaces streak_bonus. Per-bout
-- contributions across the last 5 bouts (any result), weighted by
-- opp_tier with tier-graduated loss severity. Wins credit the full
-- opp_tier_value; losses are subtracted at a discounted rate (apex
-- losses count 30% as much as the corresponding apex win, etc.).
-- Final score clamped to 0..100 around a neutral baseline of 50.
recent_form AS (
  WITH bout_contributions AS (
    SELECT
      rbw.fighter_id,
      CASE
        -- NC / draw / missing result: is_win is NULL when winner_id IS
        -- NULL (no winner recorded). Method='no_contest' is the explicit
        -- enum value. Either path → zero contribution.
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
-- Wave 6E.4: months elapsed since the fighter's last completed bout.
-- NULL for fighters with no bouts. Drives activity_smooth below.
months_since_last AS (
  SELECT
    ur.fighter_id,
    CASE
      WHEN ur.last_fight_date IS NULL THEN NULL
      ELSE EXTRACT(EPOCH FROM (NOW() - ur.last_fight_date)) / (60.0 * 60 * 24 * 30.4375)
    END AS m
  FROM ufc_record ur
),
-- Wave 6E.4: has the fighter had a UFC title bout in the last 24 months?
-- Used as the +5 era_dominance_current bonus replacing the dropped
-- title_fight_count * 10 term.
recent_title_fight AS (
  SELECT
    f.id AS fighter_id,
    EXISTS (
      SELECT 1 FROM bout b
      JOIN event e ON e.id = b.event_id
      WHERE (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
        AND b.is_title_fight = TRUE
        AND b.status = 'completed'
        AND e.date >= NOW() - INTERVAL '24 months'
    ) AS had_title_fight_recently
  FROM fighter f
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

    -- Wave 6E.4: era_dominance_current rebuilt in-view. Drops the
    -- title_fight_count * 10 term, replaces with binary +5 recent
    -- title-fight flag. The active+double bonus is recovered by
    -- subtracting title_fight_count*10 from f.era_dominance; capped
    -- (TF≥10) fighters' back-out goes negative, so GREATEST(0, ...)
    -- wraps the back-out separately from the +5 bonus so capped
    -- ex-champs who fought for a belt recently still receive the
    -- +5 credit.
    LEAST(20,
      GREATEST(0, COALESCE(f.era_dominance, 0) - COALESCE(f.title_fight_count, 0) * 10)
      + (CASE WHEN rtf.had_title_fight_recently THEN 5 ELSE 0 END)
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
    rtf.had_title_fight_recently,

    -- Wave 9: continuous recent-form signal across the last 5 bouts.
    -- Replaces streak_bonus. Defaults to 50 (neutral) for fighters with
    -- no completed bouts so they don't get penalized for absence of data.
    COALESCE(rfm.recent_form_score, 50)::int AS recent_form_score,

    -- Wave 6E.4 + 6E.4.4: smooth linear activity fade with extended
    -- thresholds. Active rostered: 100 at ≤12mo → linear to 50 at
    -- ≥24mo (championship rotation runs ~9-12 months, so half-year
    -- layoffs no longer cost activity points). Non-active: 80 at
    -- <9mo → linear to 0 at ≥24mo (unchanged). has_upcoming_bout
    -- overrides both paths to 100.
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

    -- Wave 6E.4.4: tier-discounted recent_loss_penalty (per-loss
    -- severity scaled by opp_tier_value, ×25/×12/×6 multipliers
    -- preserved). Falls back to 0 for fighters with no loss history.
    COALESCE(rlp.recent_loss_penalty, 0)::float AS recent_loss_penalty,

    LEAST(100, COALESCE(ur.ufc_losses, 0) * 4)::float AS total_loss_penalty,

    -- All-time performance_diff (career SLpM/SApM/control/td).
    COALESCE(pd.performance_diff_score, 50)::float AS performance_diff,

    -- Wave 6E.4: opp-adjusted recent-window performance_diff.
    --   striking part (0.45): recent_striking_dominance + delta * 0.5
    --   control  part (0.35): recent_control_dominance  + delta * 0.3
    --   takedown part (0.20): recent_td_dominance       (no delta)
    -- Final clamped 0..100. Used by current formula only.
    CASE
      WHEN rp.recent_bout_count IS NULL OR rp.recent_bout_count = 0 THEN 50.0
      ELSE LEAST(100, GREATEST(0, ROUND(
          0.45 * (COALESCE(rp.recent_striking_dominance, 50) + COALESCE(rp.recent_adjusted_delta, 0) * 0.5)
        + 0.35 * (COALESCE(rp.recent_control_dominance, 50)  + COALESCE(rp.recent_adjusted_delta, 0) * 0.3)
        + 0.20 * COALESCE(rp.recent_td_dominance, 50)
      )))
    END::float AS performance_diff_current,

    -- All-time finishing_dominance_score (Wave 6E.1 formula).
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

    -- Wave 6E.4.3: hybrid finishing_dominance_current.
    --   50% recent — opp-weighted realized-finish rate per 15min × 30
    --                (unchanged from 6E.4 Part B)
    --   50% career — KD/SA per UFC bout × 14 + KO/sub rate × 35,
    --                summed and clamped 0..100
    -- Recovers fighters with all-decision recent windows but strong
    -- career finishing track records (Yan, Shevchenko, Volk, Usman,
    -- Sterling, etc.). Journeyman-finishers (Salkilld, Walker) compress
    -- toward the career level instead of running away with a single
    -- recent KO streak.
    ROUND(LEAST(100, GREATEST(0,
      0.5 * (
        CASE
          WHEN COALESCE(rf.recent_total_seconds, 0) = 0 THEN 0.0
          ELSE LEAST(100, GREATEST(0,
            COALESCE(rf.recent_finish_score, 0) * 900.0
            / NULLIF(rf.recent_total_seconds, 0) * 30.0
          ))
        END
      )
      + 0.5 * LEAST(100, GREATEST(0,
          COALESCE(cf.career_kd_signal, 0)
        + COALESCE(cf.career_sa_signal, 0)
        + COALESCE(cf.career_ko_rate_signal, 0)
        + COALESCE(cf.career_sub_rate_signal, 0)
      ))
    )))::float AS finishing_dominance_current
  FROM fighter f
  LEFT JOIN ufc_record ur ON ur.fighter_id = f.id
  LEFT JOIN recent_losses rl ON rl.fighter_id = f.id
  LEFT JOIN recent_loss_penalty_calc rlp ON rlp.fighter_id = f.id
  LEFT JOIN performance_diff pd ON pd.fighter_id = f.id
  LEFT JOIN finishing_dom fd ON fd.fighter_id = f.id
  LEFT JOIN career_finishing cf ON cf.fighter_id = f.id
  LEFT JOIN recent_performance rp ON rp.fighter_id = f.id
  LEFT JOIN recent_finishing rf ON rf.fighter_id = f.id
  LEFT JOIN recent_form rfm ON rfm.fighter_id = f.id
  LEFT JOIN months_since_last msl ON msl.fighter_id = f.id
  LEFT JOIN recent_title_fight rtf ON rtf.fighter_id = f.id
),
raw_scores AS (
  SELECT
    *,
    CASE
      WHEN is_active AND ufc_bouts >= 5 THEN
        GREATEST(0,
            quality_wins * 0.22
          + championship_pedigree * 0.12
          + era_dominance_current * 0.08
          + performance_diff_current * 0.18
          + finishing_dominance_current * 0.10
          -- Wave 9: recent_form_score replaces streak_bonus. Same 0.10
          -- weight ceiling, but a continuous tier-graduated signal that
          -- credits dominant ex-champions with one elite loss instead of
          -- gating at "uninterrupted win streak ≥ 3".
          + recent_form_score::float * 0.10
          + activity * 0.12
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
  championship_pedigree,
  era_dominance_current,
  era_dominance_all_time,
  had_title_fight_recently,
  performance_diff,
  performance_diff_current,
  finishing_dominance_score,
  finishing_dominance_current,
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

  -- All-time formula UNCHANGED.
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
