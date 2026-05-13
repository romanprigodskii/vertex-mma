import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

/**
 * Full row from `fighter_with_stats` (the same view that backs the catalog),
 * widened with the biometric/career columns the detail page renders.
 */
export type FighterDetail = {
  id: string;
  slug: string;
  name_en: string;
  name_ru: string | null;
  nickname: string | null;
  dob: string | null;
  height_cm: number | null;
  reach_cm: number | null;
  leg_reach_cm: number | null;
  stance: string | null;
  country_code: string | null;
  fighting_out_of: string | null;
  weight_class_primary: string | null;
  status: string | null;
  career_start: string | null;
  career_end: string | null;
  hall_of_fame_year: number | null;
  photo_url: string | null;
  photo_thumbnail_url: string | null;
  photo_attribution: string | null;
  // Career aggregate (all promotions — see field comments in the view)
  wins_total: number;
  losses_total: number;
  draws_total: number;
  no_contests: number;
  // UFC-only (computed inside the view's fighter_results CTE)
  ufc_wins: number;
  ufc_losses: number;
  ufc_draws: number;
  ufc_no_contests: number;
  ufc_total: number;
  ufc_wins_ko: number;
  ufc_wins_sub: number;
  ufc_wins_dec: number;
  ufc_wins_finish: number;
  ufc_losses_ko: number;
  ufc_losses_sub: number;
  ufc_losses_dec: number;
  // Per-round / advanced stats (often null for low-tenure fighters)
  slpm: number | null;
  str_acc: number | null;
  sapm: number | null;
  str_def: number | null;
  td_avg: number | null;
  td_acc: number | null;
  td_def: number | null;
  sub_avg: number | null;
  // From the view's UNION-based CTE
  last_fight_date: string | null;
  last_fight_result: "W" | "L" | "D" | "NC" | null;
  last_fight_method: string | null;
  current_streak_type: "W" | "L" | null;
  current_streak_count: number;
  bout_count: number;
};

export type RoundAverage = {
  round: number;
  avg_sig_str_landed: number;
  avg_sig_str_attempted: number;
  avg_sig_str_absorbed: number;
  avg_total_str_landed: number;
  avg_total_str_absorbed: number;
  avg_td_landed: number;
  avg_td_attempted: number;
  avg_td_absorbed: number;
  avg_sub_attempts: number;
  avg_kd_landed: number;
  avg_kd_absorbed: number;
  avg_control_seconds: number;
  sample_size: number;
};

export type FightHistoryEntry = {
  bout_id: string;
  event_name: string;
  event_slug: string;
  event_date: string; // ISO timestamp from event.date
  opponent_id: string;
  opponent_slug: string;
  opponent_name: string;
  opponent_nickname: string | null;
  result: "W" | "L" | "D" | "NC";
  method: string | null;
  round_finished: number | null;
  time_finished_seconds: number | null;
  is_title_fight: boolean;
};

/** Fetch a fighter row by slug or return null. Uses the catalog view so the
 *  page gets streak/UFC totals/last-fight info for free. */
export async function getFighterBySlug(
  slug: string,
): Promise<FighterDetail | null> {
  const result = await db.execute<FighterDetail>(sql`
    SELECT
      f.id::text AS id,
      f.slug,
      f.name_en,
      f.name_ru,
      f.nickname,
      f.dob::text AS dob,
      f.height_cm,
      f.reach_cm,
      f.leg_reach_cm,
      f.stance::text AS stance,
      f.country_code,
      f.fighting_out_of,
      f.weight_class_primary::text AS weight_class_primary,
      f.status::text AS status,
      f.career_start::text AS career_start,
      f.career_end::text AS career_end,
      f.hall_of_fame_year,
      f.photo_url,
      f.photo_thumbnail_url,
      f.photo_attribution,
      COALESCE(f.wins_total, 0)::int AS wins_total,
      COALESCE(f.losses_total, 0)::int AS losses_total,
      COALESCE(f.draws_total, 0)::int AS draws_total,
      COALESCE(f.no_contests, 0)::int AS no_contests,
      f.ufc_wins,
      f.ufc_losses,
      f.ufc_draws,
      f.ufc_no_contests,
      f.ufc_total,
      f.ufc_wins_ko,
      f.ufc_wins_sub,
      f.ufc_wins_dec,
      f.ufc_wins_finish,
      f.ufc_losses_ko,
      f.ufc_losses_sub,
      f.ufc_losses_dec,
      f.slpm,
      f.str_acc,
      f.sapm,
      f.str_def,
      f.td_avg,
      f.td_acc,
      f.td_def,
      f.sub_avg,
      f.last_fight_date::text AS last_fight_date,
      f.last_fight_result,
      f.last_fight_method,
      f.current_streak_type,
      f.current_streak_count,
      f.bout_count::int AS bout_count
    FROM fighter_with_stats f
    WHERE f.slug = ${slug}
    LIMIT 1
  `);
  const rows = result as unknown as FighterDetail[];
  return rows[0] ?? null;
}

/**
 * Per-round averages across this fighter's completed bouts.
 * Self-join on `bout_round_stats` to get the opponent's strikes per round
 * for the "absorbed" column. Empty rounds (e.g. a fighter who never reached
 * round 4) are simply absent — caller decides whether to fill in "—".
 */
export async function computeRoundAverages(
  fighterId: string,
): Promise<RoundAverage[]> {
  const result = await db.execute<RoundAverage>(sql`
    SELECT
      brs.round,
      AVG(brs.sig_str_landed)::float AS avg_sig_str_landed,
      AVG(brs.sig_str_attempted)::float AS avg_sig_str_attempted,
      AVG(opp.sig_str_landed)::float AS avg_sig_str_absorbed,
      AVG(brs.total_str_landed)::float AS avg_total_str_landed,
      AVG(opp.total_str_landed)::float AS avg_total_str_absorbed,
      AVG(brs.takedowns_landed)::float AS avg_td_landed,
      AVG(brs.takedowns_attempted)::float AS avg_td_attempted,
      AVG(opp.takedowns_landed)::float AS avg_td_absorbed,
      AVG(brs.sub_attempts)::float AS avg_sub_attempts,
      AVG(brs.knockdowns)::float AS avg_kd_landed,
      AVG(opp.knockdowns)::float AS avg_kd_absorbed,
      AVG(brs.control_time_seconds)::float AS avg_control_seconds,
      COUNT(DISTINCT brs.bout_id)::int AS sample_size
    FROM bout_round_stats brs
    JOIN bout_round_stats opp
      ON opp.bout_id = brs.bout_id
      AND opp.round = brs.round
      AND opp.fighter_id <> brs.fighter_id
    WHERE brs.fighter_id = ${fighterId}
    GROUP BY brs.round
    ORDER BY brs.round
  `);
  return [...(result as unknown as RoundAverage[])];
}

/** Reverse-chronological list of completed bouts with opponent + event info. */
export async function getFightHistory(
  fighterId: string,
): Promise<FightHistoryEntry[]> {
  const result = await db.execute<FightHistoryEntry>(sql`
    SELECT
      b.id::text AS bout_id,
      COALESCE(e.short_name, e.name) AS event_name,
      e.slug AS event_slug,
      e.date::text AS event_date,
      opp.id::text AS opponent_id,
      opp.slug AS opponent_slug,
      opp.name_en AS opponent_name,
      opp.nickname AS opponent_nickname,
      CASE
        WHEN b.method::text = 'no_contest' THEN 'NC'
        WHEN b.winner_id = ${fighterId}::uuid THEN 'W'
        WHEN b.winner_id IS NOT NULL THEN 'L'
        ELSE 'D'
      END AS result,
      b.method::text AS method,
      b.round_finished,
      b.time_finished_seconds,
      b.is_title_fight
    FROM bout b
    JOIN event e ON e.id = b.event_id
    JOIN fighter opp
      ON opp.id = CASE
        WHEN b.fighter_a_id = ${fighterId}::uuid THEN b.fighter_b_id
        ELSE b.fighter_a_id
      END
    WHERE (b.fighter_a_id = ${fighterId}::uuid OR b.fighter_b_id = ${fighterId}::uuid)
      AND b.status = 'completed'
    ORDER BY e.date DESC, b.bout_order DESC NULLS LAST
  `);
  return [...(result as unknown as FightHistoryEntry[])];
}
