/**
 * Wave 18 + 18.3: populate radar-attribute aggregates on fighter table.
 *
 * Two flavours computed in the same pass:
 *
 *   Wave 18 (career, unchanged):
 *     control_seconds_avg     — mean control_time per UFC bout
 *     knockdowns_per_fight    — mean knockdowns per UFC bout
 *     late_round_reach_rate   — share of bouts that reached round ≥2
 *     fights_last_24mo        — completed bouts in trailing 24mo
 *
 *   Wave 18.3 (time-decay-weighted, same curve as Wave 15
 *   quality_wins — 1.0 within 1y → linear 0.3 at 3y → linear 0.1 at 5y
 *   → 0.1 floor):
 *     decayed_total_weight              — Σ(df)
 *     decayed_kd_per_fight              — Σ(df × kd) / Σ(df)
 *     decayed_control_per_fight         — same shape, seconds
 *     decayed_td_landed_per_fight
 *     decayed_td_attempted_per_fight
 *     decayed_sub_attempts_per_fight
 *     decayed_ko_wins_weighted          — Σ(df × is_ko_win) (raw sum)
 *     decayed_sub_wins_weighted
 *     decayed_wins_weighted
 *     decayed_late_reach_rate           — Σ(df × is_late) / Σ(df)
 *     decayed_finish_losses_weighted
 *     decayed_slpm                      — Σ(df × sig_str) / Σ(df × min)
 *     decayed_sapm
 *
 * KO/TKO wins use `method IN ('ko','tko')` to match the fighter_with_stats
 * view's ufc_wins_ko convention; finish losses include 'ko','tko',
 * 'submission'. sig_str_absorbed is pulled from the opponent's
 * bout_round_stats rows via subquery (the round-stats table only carries
 * a fighter's own landed numbers).
 *
 * Run AFTER scrape / Wave 16.x backfills. Idempotent.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { prepare: false });

async function main() {
  const t0 = Date.now();

  const result = await sql<{ id: string }[]>`
    WITH bout_decay AS (
      SELECT
        f.id AS fighter_id,
        b.id AS bout_id,
        e.date,
        GREATEST(0.1, LEAST(1.0,
          CASE
            WHEN (EXTRACT(EPOCH FROM (NOW() - e.date)) / (365.25 * 86400)) <= 1.0 THEN 1.0
            WHEN (EXTRACT(EPOCH FROM (NOW() - e.date)) / (365.25 * 86400)) <= 3.0 THEN
              1.0 - 0.7 * ((EXTRACT(EPOCH FROM (NOW() - e.date)) / (365.25 * 86400)) - 1.0) / 2.0
            WHEN (EXTRACT(EPOCH FROM (NOW() - e.date)) / (365.25 * 86400)) <= 5.0 THEN
              0.3 - 0.2 * ((EXTRACT(EPOCH FROM (NOW() - e.date)) / (365.25 * 86400)) - 3.0) / 2.0
            ELSE 0.1
          END
        ))::float AS df,
        (b.winner_id = f.id) AS is_win,
        b.method::text AS method,
        b.round_finished,
        b.time_finished_seconds,
        b.scheduled_rounds
      FROM fighter f
      JOIN bout b ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
                 AND b.status = 'completed'
      JOIN event e ON e.id = b.event_id
      WHERE e.date IS NOT NULL
    ),
    per_bout_self AS (
      SELECT
        brs.bout_id,
        brs.fighter_id,
        SUM(brs.knockdowns)::int                AS kd_landed,
        SUM(brs.control_time_seconds)::int      AS control_sec,
        SUM(brs.takedowns_landed)::int          AS td_landed,
        SUM(brs.takedowns_attempted)::int       AS td_attempted,
        SUM(brs.sub_attempts)::int              AS sub_attempts,
        SUM(brs.sig_str_landed)::int            AS sig_str_landed,
        SUM(brs.sig_str_distance_landed)::int   AS stand_landed,
        SUM(brs.sig_str_clinch_landed)::int     AS clinch_landed,
        SUM(brs.sig_str_ground_landed)::int     AS ground_landed
      FROM bout_round_stats brs
      GROUP BY brs.bout_id, brs.fighter_id
    ),
    per_bout_opp AS (
      SELECT
        brs.bout_id,
        brs.fighter_id AS opp_id,
        SUM(brs.sig_str_landed)::int            AS opp_sig_str_landed,
        SUM(brs.sig_str_distance_landed)::int   AS opp_stand_landed,
        SUM(brs.sig_str_clinch_landed)::int     AS opp_clinch_landed,
        SUM(brs.sig_str_ground_landed)::int     AS opp_ground_landed
      FROM bout_round_stats brs
      GROUP BY brs.bout_id, brs.fighter_id
    ),
    per_bout AS (
      SELECT
        bd.fighter_id,
        bd.bout_id,
        bd.date,
        bd.df,
        bd.is_win,
        bd.method,
        bd.round_finished,
        -- Wave 20: opp tier from bout_opponent_tier. COALESCE to 1 so
        -- prospect-tier bouts (default 0) still contribute weight in
        -- opp-weighted averages (otherwise denominator collapses for
        -- fighters who've only faced prospects).
        GREATEST(COALESCE(bot.opp_tier_value, 0), 1)::float AS opp_tier,
        COALESCE(ps.kd_landed, 0)      AS kd_landed,
        COALESCE(ps.control_sec, 0)    AS control_sec,
        COALESCE(ps.td_landed, 0)      AS td_landed,
        COALESCE(ps.td_attempted, 0)   AS td_attempted,
        COALESCE(ps.sub_attempts, 0)   AS sub_attempts,
        COALESCE(ps.sig_str_landed, 0) AS sig_str_landed,
        COALESCE(opp.sig_str_absorbed, 0) AS sig_str_absorbed,
        -- Wave 19: position-broken landed - absorbed per bout
        COALESCE(ps.stand_landed, 0)  - COALESCE(opp.stand_absorbed, 0)  AS stand_diff_bout,
        COALESCE(ps.clinch_landed, 0) - COALESCE(opp.clinch_absorbed, 0) AS clinch_diff_bout,
        COALESCE(ps.ground_landed, 0) - COALESCE(opp.ground_absorbed, 0) AS ground_diff_bout,
        -- Wave 19.1: raw stand-up landed (no opponent subtraction)
        COALESCE(ps.stand_landed, 0) AS stand_landed_bout,
        CASE
          WHEN bd.round_finished IS NOT NULL AND bd.time_finished_seconds IS NOT NULL
            THEN (bd.round_finished - 1) * 5.0 + bd.time_finished_seconds / 60.0
          ELSE COALESCE(bd.scheduled_rounds, 3) * 5.0
        END::float AS minutes_fought
      FROM bout_decay bd
      LEFT JOIN per_bout_self ps
        ON ps.bout_id = bd.bout_id AND ps.fighter_id = bd.fighter_id
      LEFT JOIN bout_opponent_tier bot
        ON bot.bout_id = bd.bout_id AND bot.fighter_id = bd.fighter_id
      LEFT JOIN LATERAL (
        SELECT
          SUM(po.opp_sig_str_landed)::int AS sig_str_absorbed,
          SUM(po.opp_stand_landed)::int   AS stand_absorbed,
          SUM(po.opp_clinch_landed)::int  AS clinch_absorbed,
          SUM(po.opp_ground_landed)::int  AS ground_absorbed
        FROM per_bout_opp po
        WHERE po.bout_id = bd.bout_id
          AND po.opp_id  <> bd.fighter_id
      ) opp ON TRUE
    ),
    aggs AS (
      SELECT
        fighter_id,
        -- Wave 18 career (uniform mean across bouts)
        AVG(kd_landed)::float                                     AS kd_per_fight_career,
        AVG(control_sec)::float                                   AS control_per_fight_career,
        AVG(CASE WHEN round_finished IS NULL OR round_finished >= 2
                 THEN 1.0 ELSE 0.0 END)::float                    AS late_rate_career,
        COUNT(*) FILTER (WHERE date >= NOW() - INTERVAL '24 months')::int
                                                                  AS fights_24mo,
        -- Wave 18.3 decay-weighted
        SUM(df)::float                                            AS total_df,
        (SUM(df * kd_landed)     / NULLIF(SUM(df), 0))::float     AS decayed_kd_per_fight,
        (SUM(df * control_sec)   / NULLIF(SUM(df), 0))::float     AS decayed_control_per_fight,
        (SUM(df * td_landed)     / NULLIF(SUM(df), 0))::float     AS decayed_td_landed_per_fight,
        (SUM(df * td_attempted)  / NULLIF(SUM(df), 0))::float     AS decayed_td_attempted_per_fight,
        (SUM(df * sub_attempts)  / NULLIF(SUM(df), 0))::float     AS decayed_sub_attempts_per_fight,
        SUM(df * CASE WHEN is_win AND method IN ('ko','tko')   THEN 1 ELSE 0 END)::float
                                                                  AS decayed_ko_wins_weighted,
        SUM(df * CASE WHEN is_win AND method = 'submission'    THEN 1 ELSE 0 END)::float
                                                                  AS decayed_sub_wins_weighted,
        SUM(df * CASE WHEN is_win                               THEN 1 ELSE 0 END)::float
                                                                  AS decayed_wins_weighted,
        (SUM(df * CASE WHEN round_finished IS NULL OR round_finished >= 2
                       THEN 1.0 ELSE 0.0 END)
          / NULLIF(SUM(df), 0))::float                            AS decayed_late_reach_rate,
        SUM(df * CASE WHEN NOT is_win AND method IN ('ko','tko','submission')
                      THEN 1 ELSE 0 END)::float                   AS decayed_finish_losses_weighted,
        (SUM(df * sig_str_landed)
          / NULLIF(SUM(df * minutes_fought), 0))::float           AS decayed_slpm,
        (SUM(df * sig_str_absorbed)
          / NULLIF(SUM(df * minutes_fought), 0))::float           AS decayed_sapm,
        -- Wave 19: per-minute, decay-weighted position-broken diffs
        (SUM(df * stand_diff_bout)
          / NULLIF(SUM(df * minutes_fought), 0))::float           AS decayed_stand_diff_per_min,
        (SUM(df * clinch_diff_bout)
          / NULLIF(SUM(df * minutes_fought), 0))::float           AS decayed_clinch_diff_per_min,
        (SUM(df * ground_diff_bout)
          / NULLIF(SUM(df * minutes_fought), 0))::float           AS decayed_ground_diff_per_min,
        -- Wave 19.1: stand-up landed per minute (no opponent subtraction).
        -- Powers the volume-style striking branch — Holloway maxes here
        -- even when his stand_diff (1.8) caps below the highest threshold.
        (SUM(df * COALESCE(stand_landed_bout, 0))
          / NULLIF(SUM(df * minutes_fought), 0))::float           AS decayed_stand_landed_per_min,
        -- Wave 20: opp-tier-weighted variants. Numerator is Σ(df × tier ×
        -- metric); denominator is Σ(df × tier) (or Σ(df × tier × minutes)
        -- for per-min rates). A fighter who lands a lot vs ranked opponents
        -- scores higher than one who lands the same volume vs prospects.
        (SUM(df * opp_tier * CASE WHEN is_win AND method IN ('ko','tko')
                                  THEN 1 ELSE 0 END)
          / NULLIF(SUM(df * opp_tier * CASE WHEN is_win THEN 1 ELSE 0 END), 0))::float
                                                                  AS decayed_ko_quality,
        -- Total finish time in seconds for KO/TKO wins, decay-averaged.
        -- Speed style inverts this: 0s = 100, 600s (R2 midway, total) = 0.
        (SUM(df * CASE WHEN is_win AND method IN ('ko','tko')
                       THEN minutes_fought * 60.0 ELSE 0 END)
          / NULLIF(SUM(df * CASE WHEN is_win AND method IN ('ko','tko')
                                  THEN 1 ELSE 0 END), 0))::float  AS decayed_avg_ko_finish_seconds,
        (SUM(df * opp_tier * kd_landed)
          / NULLIF(SUM(df * opp_tier), 0))::float                 AS decayed_kd_quality,
        (SUM(df * opp_tier * stand_landed_bout)
          / NULLIF(SUM(df * opp_tier * minutes_fought), 0))::float
                                                                  AS decayed_stand_landed_quality_per_min,
        (SUM(df * opp_tier * td_landed)
          / NULLIF(SUM(df * opp_tier), 0))::float                 AS decayed_td_landed_quality,
        (SUM(df * opp_tier * control_sec)
          / NULLIF(SUM(df * opp_tier), 0))::float                 AS decayed_control_quality,
        (SUM(df * opp_tier * CASE WHEN round_finished IS NULL OR round_finished >= 2
                                  THEN 1.0 ELSE 0.0 END)
          / NULLIF(SUM(df * opp_tier), 0))::float                 AS decayed_late_reach_quality,
        (SUM(df * opp_tier * sig_str_absorbed)
          / NULLIF(SUM(df * opp_tier * minutes_fought), 0))::float
                                                                  AS decayed_damage_quality
      FROM per_bout
      GROUP BY fighter_id
    ),
    -- Wave 20: layered activity windows. Period-based (not decay-weighted)
    -- — recency is already in the lookback bound. avg opp_tier uses 1
    -- floor too so prospect bouts still register but don't max the layer.
    activity_layers AS (
      SELECT
        f.id AS fighter_id,
        COUNT(*) FILTER (WHERE e.date >= NOW() - INTERVAL '12 months')::int
          AS fights_12mo,
        AVG(GREATEST(COALESCE(bot.opp_tier_value, 0), 1)::float)
          FILTER (WHERE e.date >= NOW() - INTERVAL '12 months')
          AS avg_tier_12mo,
        AVG(GREATEST(COALESCE(bot.opp_tier_value, 0), 1)::float)
          FILTER (WHERE e.date >= NOW() - INTERVAL '24 months')
          AS avg_tier_24mo,
        COUNT(*) FILTER (WHERE e.date >= NOW() - INTERVAL '36 months')::int
          AS fights_36mo,
        AVG(GREATEST(COALESCE(bot.opp_tier_value, 0), 1)::float)
          FILTER (WHERE e.date >= NOW() - INTERVAL '36 months')
          AS avg_tier_36mo
      FROM fighter f
      JOIN bout b ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
                 AND b.status = 'completed'
      JOIN event e ON e.id = b.event_id
      LEFT JOIN bout_opponent_tier bot
        ON bot.bout_id = b.id AND bot.fighter_id = f.id
      GROUP BY f.id
    )
    UPDATE fighter f
    SET
      control_seconds_avg            = a.control_per_fight_career,
      knockdowns_per_fight           = a.kd_per_fight_career,
      late_round_reach_rate          = a.late_rate_career,
      fights_last_24mo               = a.fights_24mo,
      decayed_total_weight           = a.total_df,
      decayed_kd_per_fight           = a.decayed_kd_per_fight,
      decayed_control_per_fight      = a.decayed_control_per_fight,
      decayed_td_landed_per_fight    = a.decayed_td_landed_per_fight,
      decayed_td_attempted_per_fight = a.decayed_td_attempted_per_fight,
      decayed_sub_attempts_per_fight = a.decayed_sub_attempts_per_fight,
      decayed_ko_wins_weighted       = a.decayed_ko_wins_weighted,
      decayed_sub_wins_weighted      = a.decayed_sub_wins_weighted,
      decayed_wins_weighted          = a.decayed_wins_weighted,
      decayed_late_reach_rate        = a.decayed_late_reach_rate,
      decayed_finish_losses_weighted = a.decayed_finish_losses_weighted,
      decayed_slpm                   = a.decayed_slpm,
      decayed_sapm                   = a.decayed_sapm,
      decayed_stand_diff_per_min     = a.decayed_stand_diff_per_min,
      decayed_clinch_diff_per_min    = a.decayed_clinch_diff_per_min,
      decayed_ground_diff_per_min    = a.decayed_ground_diff_per_min,
      decayed_stand_landed_per_min   = a.decayed_stand_landed_per_min,
      decayed_ko_quality                   = a.decayed_ko_quality,
      decayed_avg_ko_finish_seconds        = a.decayed_avg_ko_finish_seconds,
      decayed_kd_quality                   = a.decayed_kd_quality,
      decayed_stand_landed_quality_per_min = a.decayed_stand_landed_quality_per_min,
      decayed_td_landed_quality            = a.decayed_td_landed_quality,
      decayed_control_quality              = a.decayed_control_quality,
      decayed_late_reach_quality           = a.decayed_late_reach_quality,
      decayed_damage_quality               = a.decayed_damage_quality,
      fights_last_12mo                     = al.fights_12mo,
      avg_opp_tier_last_12mo               = al.avg_tier_12mo,
      avg_opp_tier_last_24mo               = al.avg_tier_24mo,
      fights_last_36mo                     = al.fights_36mo,
      avg_opp_tier_last_36mo               = al.avg_tier_36mo
    FROM aggs a
    LEFT JOIN activity_layers al ON al.fighter_id = a.fighter_id
    WHERE f.id = a.fighter_id
    RETURNING f.id
  `;

  console.log(
    `Wave 18/18.3 radar aggregates: updated ${result.length} fighters in ${
      Date.now() - t0
    }ms.`,
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
