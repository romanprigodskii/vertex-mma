/**
 * Wave 18: recreate fighter_with_stats so its `SELECT f.*` picks up the
 * 4 new fighter columns (control_seconds_avg, knockdowns_per_fight,
 * late_round_reach_rate, fights_last_24mo). Body is character-identical
 * to migration 0041 — only the underlying f.* expansion changes.
 *
 * Safe to re-run (DROP IF EXISTS). No views depend on fighter_with_stats
 * at the time of writing (verified via wave18_check_deps.ts).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false });

  await sql.unsafe(`
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
  `);

  console.log("Wave 18: fighter_with_stats view recreated.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
