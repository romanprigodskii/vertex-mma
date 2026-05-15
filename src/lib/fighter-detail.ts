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
  vertex_score: number | null;
  vertex_score_all_time: number | null;
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
  /** Raw `bout.method` value as the scraper recorded it (often NULL). */
  method: string | null;
  /**
   * Method that survived the scraper's NULL gap by falling back to
   * round-stat signals (knockdowns / sub_attempts in the finishing round)
   * and the round_finished/time signal (full distance ⇒ decision).
   * Never NULL when the bout was completed.
   */
  method_resolved: string | null;
  round_finished: number | null;
  time_finished_seconds: number | null;
  is_title_fight: boolean;
};

/**
 * Fight history entry enriched with per-bout aggregates (summed across the
 * bout's recorded rounds). Powers the timeline's rich hover tooltip without
 * a second SQL trip — we already fetch the per-round entries for the RBR
 * chart and heatmap.
 */
export type TimelineBout = FightHistoryEntry & {
  sig_str_landed: number;
  sig_str_absorbed: number;
  td_landed: number;
  td_attempted: number;
  control_seconds: number;
  /** True when bout_round_stats actually exists for this bout. */
  has_stats: boolean;
};

/** Sum per-round stats into per-bout aggregates and zip with fight history. */
export function buildTimelineBouts(
  history: FightHistoryEntry[],
  boutRounds: FighterBoutRound[],
): TimelineBout[] {
  const agg = new Map<
    string,
    {
      sig_str_landed: number;
      sig_str_absorbed: number;
      td_landed: number;
      td_attempted: number;
      control_seconds: number;
    }
  >();
  for (const r of boutRounds) {
    const cur = agg.get(r.bout_id) ?? {
      sig_str_landed: 0,
      sig_str_absorbed: 0,
      td_landed: 0,
      td_attempted: 0,
      control_seconds: 0,
    };
    cur.sig_str_landed += r.sig_str_landed;
    cur.sig_str_absorbed += r.sig_str_absorbed;
    cur.td_landed += r.td_landed;
    cur.td_attempted += r.td_attempted;
    cur.control_seconds += r.control_seconds;
    agg.set(r.bout_id, cur);
  }
  return history.map((h) => {
    const a = agg.get(h.bout_id);
    return {
      ...h,
      sig_str_landed: a?.sig_str_landed ?? 0,
      sig_str_absorbed: a?.sig_str_absorbed ?? 0,
      td_landed: a?.td_landed ?? 0,
      td_attempted: a?.td_attempted ?? 0,
      control_seconds: a?.control_seconds ?? 0,
      has_stats: a != null,
    };
  });
}

/** One row per (bout, round) for a given fighter, with the opponent's
 *  same-round numbers under "_absorbed" aliases and enough bout meta to
 *  filter client-side (wins/losses/title/last-5). Single source of truth for
 *  both the RBR chart and the striking heatmap. */
export type FighterBoutRound = {
  bout_id: string;
  round: number;
  event_date: string;
  result: "W" | "L" | "D" | "NC";
  is_title_fight: boolean;
  sig_str_landed: number;
  sig_str_absorbed: number;
  sig_str_head_landed: number;
  sig_str_head_absorbed: number;
  sig_str_body_landed: number;
  sig_str_body_absorbed: number;
  sig_str_legs_landed: number;
  sig_str_legs_absorbed: number;
  total_str_landed: number;
  total_str_absorbed: number;
  td_landed: number;
  td_absorbed: number;
  td_attempted: number;
  sub_attempts: number;
  kd_landed: number;
  kd_absorbed: number;
  control_seconds: number;
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
      f.bout_count::int AS bout_count,
      f.vertex_score,
      f.vertex_score_all_time
    FROM fighter_with_stats f
    WHERE f.slug = ${slug}
    LIMIT 1
  `);
  const rows = result as unknown as FighterDetail[];
  return rows[0] ?? null;
}

/**
 * Raw per-round entries for the fighter. The RBR chart and StrikingHeatmap
 * both consume this single dataset and filter/aggregate client-side; ~150
 * rows per fighter, so memory cost is negligible vs. re-querying on every
 * filter toggle.
 */
export async function getFighterBoutRounds(
  fighterId: string,
): Promise<FighterBoutRound[]> {
  const result = await db.execute<FighterBoutRound>(sql`
    SELECT
      brs.bout_id::text AS bout_id,
      brs.round,
      e.date::text AS event_date,
      b.is_title_fight,
      CASE
        WHEN b.method::text = 'no_contest' THEN 'NC'
        WHEN b.winner_id = ${fighterId}::uuid THEN 'W'
        WHEN b.winner_id IS NOT NULL THEN 'L'
        ELSE 'D'
      END AS result,
      brs.sig_str_landed,
      COALESCE(opp.sig_str_landed, 0) AS sig_str_absorbed,
      brs.sig_str_head_landed,
      COALESCE(opp.sig_str_head_landed, 0) AS sig_str_head_absorbed,
      brs.sig_str_body_landed,
      COALESCE(opp.sig_str_body_landed, 0) AS sig_str_body_absorbed,
      brs.sig_str_legs_landed,
      COALESCE(opp.sig_str_legs_landed, 0) AS sig_str_legs_absorbed,
      brs.total_str_landed,
      COALESCE(opp.total_str_landed, 0) AS total_str_absorbed,
      brs.takedowns_landed AS td_landed,
      COALESCE(opp.takedowns_landed, 0) AS td_absorbed,
      brs.takedowns_attempted AS td_attempted,
      brs.sub_attempts,
      brs.knockdowns AS kd_landed,
      COALESCE(opp.knockdowns, 0) AS kd_absorbed,
      brs.control_time_seconds AS control_seconds
    FROM bout_round_stats brs
    JOIN bout b ON b.id = brs.bout_id
    JOIN event e ON e.id = b.event_id
    LEFT JOIN bout_round_stats opp
      ON opp.bout_id = brs.bout_id
     AND opp.round = brs.round
     AND opp.fighter_id <> brs.fighter_id
    WHERE brs.fighter_id = ${fighterId}::uuid
      AND b.status = 'completed'
    ORDER BY e.date DESC, brs.round ASC
  `);
  return [...(result as unknown as FighterBoutRound[])];
}

/**
 * Reverse-chronological list of completed bouts with opponent + event info.
 *
 * `method_resolved` falls back to round-stat signals when `bout.method` is
 * NULL (scraper coverage gap): knockdowns >0 in finishing round → KO,
 * sub_attempts >0 → Sub, otherwise full-distance bouts → Dec. The raw
 * `method` column is also returned for callers that need to distinguish
 * recorded from inferred.
 */
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
      CASE
        WHEN b.method IS NOT NULL THEN b.method::text
        WHEN b.round_finished IS NOT NULL
          AND b.scheduled_rounds IS NOT NULL
          AND b.round_finished >= b.scheduled_rounds
          AND COALESCE(b.time_finished_seconds, 0) >= 280
        THEN 'decision_unanimous'
        WHEN COALESCE(brs_win.knockdowns, 0) > 0 THEN 'ko'
        WHEN COALESCE(brs_win.sub_attempts, 0) > 0 THEN 'submission'
        ELSE NULL
      END AS method_resolved,
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
    LEFT JOIN bout_round_stats brs_win
      ON brs_win.bout_id = b.id
     AND brs_win.fighter_id = b.winner_id
     AND brs_win.round = b.round_finished
    WHERE (b.fighter_a_id = ${fighterId}::uuid OR b.fighter_b_id = ${fighterId}::uuid)
      AND b.status = 'completed'
    ORDER BY e.date DESC, b.bout_order DESC NULLS LAST
  `);
  return [...(result as unknown as FightHistoryEntry[])];
}
