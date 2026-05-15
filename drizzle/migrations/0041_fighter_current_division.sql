-- Wave 7A: fighter.current_division column + index + view recreate.
--
-- Catalog filtering currently uses fighter.weight_class_primary, which is
-- a manual/legacy attribute. After Wave 6E.4 several top fighters changed
-- divisions (Topuria FW→LW, Islam LW→WW) but their weight_class_primary
-- still points to their original belt class, so they don't appear in the
-- /fighters catalog filter for their new division.
--
-- This migration adds fighter.current_division, derived from the last
-- completed UFC bout's weight_class. The catalog filter uses
-- COALESCE(current_division, weight_class_primary). weight_class_primary
-- is preserved for legacy reference and as the fallback for fighters
-- with no completed UFC bouts (cut prospects, signed-but-unfought).
--
-- The fighter_with_stats view is recreated with the same `f.*` body it
-- already had (migration 0013) so the new column flows through to the
-- catalog query without changes to fighter-search.ts beyond the WHERE
-- clause. Re-running this migration is safe (IF NOT EXISTS on column +
-- index; DROP/CREATE on view).

ALTER TABLE fighter ADD COLUMN IF NOT EXISTS current_division TEXT;

CREATE INDEX IF NOT EXISTS fighter_current_division_idx
  ON fighter(current_division) WHERE current_division IS NOT NULL;

-- Recreate fighter_with_stats so SELECT f.* picks up current_division.
-- Body is character-identical to migration 0013 (which itself was a
-- DROP/CREATE refresh of migration 0003 to pick up the vertex_score
-- column family). No semantic changes here.

DROP VIEW IF EXISTS fighter_with_stats CASCADE;

CREATE VIEW fighter_with_stats AS
WITH fighter_results AS (
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
  SELECT DISTINCT ON (fighter_id)
    fighter_id,
    fight_date,
    method,
    result
  FROM fighter_results
  ORDER BY fighter_id, fight_date DESC, bout_id DESC
),
decisive AS (
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
  SELECT
    fighter_id,
    COUNT(*) FILTER (WHERE result = 'W') AS ufc_wins,
    COUNT(*) FILTER (WHERE result = 'L') AS ufc_losses,
    COUNT(*) FILTER (WHERE result = 'D') AS ufc_draws,
    COUNT(*) FILTER (WHERE result = 'NC') AS ufc_no_contests,
    COUNT(*) AS ufc_total,
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
    COUNT(*) FILTER (WHERE result = 'W' AND NOT is_finish) AS ufc_wins_dec,
    COUNT(*) FILTER (WHERE result = 'W' AND is_finish) AS ufc_wins_finish,
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
