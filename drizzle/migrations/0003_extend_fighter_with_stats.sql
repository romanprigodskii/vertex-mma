-- Run manually in Supabase SQL Editor. Drizzle push does not manage views.
-- Wave 3A.3: extend fighter_with_stats with current_streak + last fight info.
--
-- Result classification per bout (perspective of one fighter):
--   W  — winner_id = this fighter
--   L  — winner_id = the other fighter
--   NC — method = 'no_contest' (winner_id IS NULL by definition)
--   D  — winner_id IS NULL AND method != 'no_contest' (draws + unrecorded
--        non-decisive outcomes — small population, grouped together)
--
-- Streaks count consecutive W or L only. D and NC do not extend a streak,
-- and we conservatively also treat them as streak-breakers — most fans
-- read "current streak" as "decisive results in a row," which matches.

DROP VIEW IF EXISTS fighter_with_stats CASCADE;

CREATE VIEW fighter_with_stats AS
WITH fighter_results AS (
  -- One row per (fighter, completed bout) — perspective-of-fighter result.
  SELECT
    b.fighter_a_id AS fighter_id,
    e.date AS fight_date,
    b.id AS bout_id,
    b.method::text AS method,
    CASE
      WHEN b.method::text = 'no_contest' THEN 'NC'
      WHEN b.winner_id = b.fighter_a_id THEN 'W'
      WHEN b.winner_id = b.fighter_b_id THEN 'L'
      WHEN b.winner_id IS NULL THEN 'D'
      ELSE 'L'
    END AS result
  FROM bout b
  JOIN event e ON e.id = b.event_id
  WHERE b.status = 'completed'
  UNION ALL
  SELECT
    b.fighter_b_id,
    e.date,
    b.id,
    b.method::text,
    CASE
      WHEN b.method::text = 'no_contest' THEN 'NC'
      WHEN b.winner_id = b.fighter_b_id THEN 'W'
      WHEN b.winner_id = b.fighter_a_id THEN 'L'
      WHEN b.winner_id IS NULL THEN 'D'
      ELSE 'L'
    END
  FROM bout b
  JOIN event e ON e.id = b.event_id
  WHERE b.status = 'completed'
),
last_fights AS (
  -- Most recent completed bout per fighter (any result, including D/NC).
  SELECT DISTINCT ON (fighter_id)
    fighter_id,
    fight_date,
    method,
    result
  FROM fighter_results
  ORDER BY fighter_id, fight_date DESC, bout_id DESC
),
decisive AS (
  -- Only W/L matter for streak counting; ordered most-recent-first.
  SELECT
    fighter_id,
    result,
    ROW_NUMBER() OVER (
      PARTITION BY fighter_id
      ORDER BY fight_date DESC, bout_id DESC
    ) AS rn
  FROM fighter_results
  WHERE result IN ('W', 'L')
),
grouped AS (
  -- Gaps-and-islands: consecutive same-result rows share `grp`.
  SELECT
    fighter_id,
    result,
    rn,
    rn - ROW_NUMBER() OVER (
      PARTITION BY fighter_id, result ORDER BY rn
    ) AS grp
  FROM decisive
),
current_streak AS (
  -- The streak that contains rn = 1 (the most recent decisive fight).
  SELECT
    fighter_id,
    result AS streak_type,
    COUNT(*) AS streak_count
  FROM grouped
  WHERE (fighter_id, result, grp) IN (
    SELECT fighter_id, result, grp
    FROM grouped
    WHERE rn = 1
  )
  GROUP BY fighter_id, result
),
ufc_stats AS (
  -- UFC-only aggregates derived from the bout table (vs fighter_stats_aggregate.
  -- wins_total which is the fighter's career total across all promotions —
  -- that's why Dan Severn appears with 101 wins despite only 13 UFC bouts).
  -- "ufc_total" counts completed UFC bouts including draws and NCs.
  SELECT
    fighter_id,
    COUNT(*) FILTER (WHERE result = 'W') AS ufc_wins,
    COUNT(*) FILTER (WHERE result = 'L') AS ufc_losses,
    COUNT(*) FILTER (WHERE result = 'D') AS ufc_draws,
    COUNT(*) FILTER (WHERE result = 'NC') AS ufc_no_contests,
    COUNT(*) AS ufc_total
  FROM fighter_results
  GROUP BY fighter_id
)
SELECT
  f.*,
  fsa.wins_total,
  fsa.losses_total,
  fsa.draws_total,
  fsa.no_contests,
  fsa.wins_ko,
  fsa.wins_sub,
  fsa.wins_dec,
  fsa.losses_ko,
  fsa.losses_sub,
  fsa.losses_dec,
  fsa.slpm,
  fsa.str_acc,
  fsa.sapm,
  fsa.str_def,
  fsa.td_avg,
  fsa.td_acc,
  fsa.td_def,
  fsa.sub_avg,
  fsa.overall_rating,
  fsa.striking_rating,
  fsa.grappling_rating,
  fsa.cardio_rating,
  fsa.chin_rating,
  fsa.power_rating,
  fsa.iq_rating,
  lf.fight_date AS last_fight_date,
  lf.result AS last_fight_result,
  lf.method AS last_fight_method,
  cs.streak_type AS current_streak_type,
  COALESCE(cs.streak_count, 0)::int AS current_streak_count,
  COALESCE(us.ufc_wins, 0)::int AS ufc_wins,
  COALESCE(us.ufc_losses, 0)::int AS ufc_losses,
  COALESCE(us.ufc_draws, 0)::int AS ufc_draws,
  COALESCE(us.ufc_no_contests, 0)::int AS ufc_no_contests,
  COALESCE(us.ufc_total, 0)::int AS ufc_total,
  (
    SELECT COUNT(*)
    FROM bout
    WHERE fighter_a_id = f.id OR fighter_b_id = f.id
  ) AS bout_count
FROM fighter f
LEFT JOIN fighter_stats_aggregate fsa ON fsa.fighter_id = f.id
LEFT JOIN last_fights lf ON lf.fighter_id = f.id
LEFT JOIN current_streak cs ON cs.fighter_id = f.id
LEFT JOIN ufc_stats us ON us.fighter_id = f.id;
