-- Wave 3.5 step 4A.3 hotfix: re-create fighter_with_stats so it exposes the
-- vertex_score family of columns added to the fighter table by migrations
-- 0004 / 0005 / 0008 / 0009. PostgreSQL expands `SELECT f.*` at view-create
-- time, so columns added to the underlying table after the view was first
-- created don't appear in it — until we DROP and re-CREATE.
--
-- The body of the view is otherwise identical to migration 0003. We re-run
-- the same DDL so the snapshot picks up the current fighter column set,
-- which now includes:
--   championship_pedigree (int)
--   is_dominant_champion  (bool)
--   peak_score            (int, nullable)
--   vertex_score          (int, nullable)
--   vertex_score_all_time (int, nullable)
--
-- (For reference — original header from migration 0003.)
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
  --
  -- `is_finish` infers whether a bout was a stoppage when the method column
  -- is unrecorded — the Wave 2B scraper left `bout.method` NULL for ~4339 of
  -- completed bouts (including all of Khabib's submission wins). We treat
  -- "bout did not reach the end of the final scheduled round" as a finish so
  -- the radar's Power axis isn't zeroed out for famous finishers. The
  -- `>= 280` (4:40) threshold tolerates per-round time encoding quirks.
  SELECT
    b.fighter_a_id AS fighter_id,
    e.date AS fight_date,
    b.id AS bout_id,
    b.method::text AS method,
    CASE
      WHEN b.method::text LIKE 'decision%' THEN FALSE
      WHEN b.method::text IN ('ko','tko','submission','dq') THEN TRUE
      WHEN b.round_finished IS NOT NULL
        AND b.scheduled_rounds IS NOT NULL
        AND NOT (
          b.round_finished >= b.scheduled_rounds
          AND COALESCE(b.time_finished_seconds, 0) >= 280
        )
      THEN TRUE
      ELSE FALSE
    END AS is_finish,
    -- Knockdowns and sub_attempts in the bout's finishing round (perspective
    -- fighter's row in bout_round_stats). Used to disambiguate KO vs Sub for
    -- the ~4339 completed bouts where `method` is NULL but a round-stats row
    -- exists with the actual signal. NULL when round stats are missing.
    brs_self.knockdowns AS last_round_kd,
    brs_self.sub_attempts AS last_round_sub_attempts,
    CASE
      WHEN b.method::text = 'no_contest' THEN 'NC'
      WHEN b.winner_id = b.fighter_a_id THEN 'W'
      WHEN b.winner_id = b.fighter_b_id THEN 'L'
      WHEN b.winner_id IS NULL THEN 'D'
      ELSE 'L'
    END AS result
  FROM bout b
  JOIN event e ON e.id = b.event_id
  LEFT JOIN bout_round_stats brs_self
    ON brs_self.bout_id = b.id
   AND brs_self.fighter_id = b.fighter_a_id
   AND brs_self.round = b.round_finished
  WHERE b.status = 'completed'
  UNION ALL
  SELECT
    b.fighter_b_id,
    e.date,
    b.id,
    b.method::text,
    CASE
      WHEN b.method::text LIKE 'decision%' THEN FALSE
      WHEN b.method::text IN ('ko','tko','submission','dq') THEN TRUE
      WHEN b.round_finished IS NOT NULL
        AND b.scheduled_rounds IS NOT NULL
        AND NOT (
          b.round_finished >= b.scheduled_rounds
          AND COALESCE(b.time_finished_seconds, 0) >= 280
        )
      THEN TRUE
      ELSE FALSE
    END,
    brs_self.knockdowns,
    brs_self.sub_attempts,
    CASE
      WHEN b.method::text = 'no_contest' THEN 'NC'
      WHEN b.winner_id = b.fighter_b_id THEN 'W'
      WHEN b.winner_id = b.fighter_a_id THEN 'L'
      WHEN b.winner_id IS NULL THEN 'D'
      ELSE 'L'
    END
  FROM bout b
  JOIN event e ON e.id = b.event_id
  LEFT JOIN bout_round_stats brs_self
    ON brs_self.bout_id = b.id
   AND brs_self.fighter_id = b.fighter_b_id
   AND brs_self.round = b.round_finished
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
  -- The method breakdown is needed by the fighter-detail radar (power,
  -- cardio) since fighter_stats_aggregate.wins_ko/sub/dec are all 0 in our
  -- data — never populated by the scraper.
  SELECT
    fighter_id,
    COUNT(*) FILTER (WHERE result = 'W') AS ufc_wins,
    COUNT(*) FILTER (WHERE result = 'L') AS ufc_losses,
    COUNT(*) FILTER (WHERE result = 'D') AS ufc_draws,
    COUNT(*) FILTER (WHERE result = 'NC') AS ufc_no_contests,
    COUNT(*) AS ufc_total,
    -- KO/Sub use the method column when available, else fall back to the
    -- finishing-round signals from bout_round_stats:
    --   knockdowns > 0 in finishing round  → KO/TKO
    --   sub_attempts > 0 AND no knockdowns → Submission
    -- Knockdowns take priority because a fight can have a sub attempt earlier
    -- in the round but end on a KO. ~99% of NULL-method finishes get classified
    -- correctly this way; the rare neither-signal case stays in "Other".
    COUNT(*) FILTER (
      WHERE result = 'W' AND is_finish AND (
        method IN ('ko','tko')
        OR (method IS NULL AND COALESCE(last_round_kd, 0) > 0)
      )
    ) AS ufc_wins_ko,
    COUNT(*) FILTER (
      WHERE result = 'W' AND is_finish AND (
        method = 'submission'
        OR (
          method IS NULL
          AND COALESCE(last_round_kd, 0) = 0
          AND COALESCE(last_round_sub_attempts, 0) > 0
        )
      )
    ) AS ufc_wins_sub,
    -- Decisions: explicit decision_* method OR (NULL method AND went the
    -- full distance per is_finish). Captures the ~4k unrecorded-method bouts
    -- correctly because most went to decision.
    COUNT(*) FILTER (WHERE result = 'W' AND NOT is_finish) AS ufc_wins_dec,
    -- Any non-decision win — KO/Sub plus the rare NULL-method-NULL-round-stats
    -- bucket. Used for the radar's Power axis.
    COUNT(*) FILTER (WHERE result = 'W' AND is_finish) AS ufc_wins_finish,
    -- Symmetric inference on losses (the opponent's round-stat would tell us
    -- KO vs Sub, but we don't have it here; method-only for losses).
    COUNT(*) FILTER (WHERE result = 'L' AND method IN ('ko', 'tko')) AS ufc_losses_ko,
    COUNT(*) FILTER (WHERE result = 'L' AND method = 'submission') AS ufc_losses_sub,
    COUNT(*) FILTER (WHERE result = 'L' AND NOT is_finish) AS ufc_losses_dec
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
  COALESCE(us.ufc_wins_ko, 0)::int AS ufc_wins_ko,
  COALESCE(us.ufc_wins_sub, 0)::int AS ufc_wins_sub,
  COALESCE(us.ufc_wins_dec, 0)::int AS ufc_wins_dec,
  COALESCE(us.ufc_wins_finish, 0)::int AS ufc_wins_finish,
  COALESCE(us.ufc_losses_ko, 0)::int AS ufc_losses_ko,
  COALESCE(us.ufc_losses_sub, 0)::int AS ufc_losses_sub,
  COALESCE(us.ufc_losses_dec, 0)::int AS ufc_losses_dec,
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
