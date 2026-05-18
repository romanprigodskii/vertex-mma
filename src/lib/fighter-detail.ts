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
  /** Wave 7A: division of the fighter's most recent completed UFC bout
   *  (NULL for prospects who haven't fought). Wave 14B.2 reads this to
   *  pick which divisional row to surface in the hero. */
  current_division: string | null;
  /** Wave 18: bout-derived aggregates powering the rebuilt radar
   *  attributes. NULL for fighters with no completed UFC bouts (treated
   *  as 0 by the radar's safe() helper). Populated by
   *  scripts/compute_radar_aggregates.ts. */
  control_seconds_avg: number | null;
  knockdowns_per_fight: number | null;
  late_round_reach_rate: number | null;
  fights_last_24mo: number | null;
  /** Wave 18.3: decay-weighted radar inputs (same curve as Wave 15
   *  quality_wins). The radar reads these first and falls back to the
   *  career columns above when a fighter has no decay weight (no
   *  completed bouts). */
  decayed_total_weight: number | null;
  decayed_kd_per_fight: number | null;
  decayed_control_per_fight: number | null;
  decayed_td_landed_per_fight: number | null;
  decayed_td_attempted_per_fight: number | null;
  decayed_sub_attempts_per_fight: number | null;
  decayed_ko_wins_weighted: number | null;
  decayed_sub_wins_weighted: number | null;
  decayed_wins_weighted: number | null;
  decayed_late_reach_rate: number | null;
  decayed_finish_losses_weighted: number | null;
  decayed_slpm: number | null;
  decayed_sapm: number | null;
  /** Wave 19: position-broken landed-vs-absorbed differential per
   *  minute, decay-weighted. stand isolates true distance striking
   *  (Pereira/Holloway/Topuria), ground isolates GnP / ground control
   *  (Khabib/Islam/Aspinall). clinch is broken out for completeness but
   *  not currently consumed by computeAttributes. */
  decayed_stand_diff_per_min: number | null;
  decayed_clinch_diff_per_min: number | null;
  decayed_ground_diff_per_min: number | null;
};

/** Wave 17: weights powering ScoreBreakdown's contribution math. These
 *  mirror the locked Wave 15.1 current formula (migration 0046) and the
 *  all-time formula (migration 0017 / 0045). They are presentation-only
 *  constants — the database is still the source of truth for the
 *  scores themselves (raw_current / multiplied_current / vertex_score
 *  in fighter_vertex_score and fighter_divisional_score). Updating a
 *  weight here without the matching migration will desync the UI from
 *  the actual score. */
export const CURRENT_SCORE_WEIGHTS = {
  quality_wins: 0.16,
  current_cp: 0.10,
  era_dominance: 0.06,
  performance_diff: 0.16,
  finishing_dominance: 0.10,
  activity: 0.12,
  recent_form: 0.18,
  recent_loss_penalty: -0.20,
} as const;

export const ALL_TIME_SCORE_WEIGHTS = {
  quality_wins: 0.28,
  championship_pedigree: 0.22,
  era_dominance: 0.22,
  performance_diff: 0.12,
  finishing_dominance: 0.16,
  total_loss_penalty: -0.10,
} as const;

export type ScoreComponentRow = {
  label: string;
  raw: number | null;
  weight: number;
};

export type ScoreBreakdownData = {
  source: "divisional" | "global";
  divisionLabel: string | null;
  current: {
    rows: ScoreComponentRow[];
    rawTotal: number | null;
    curveMultiplier: number | null;
    finalScore: number | null;
  };
  allTime: {
    rows: ScoreComponentRow[];
    finalScore: number | null;
  };
};

/**
 * Wave 17: project a fighter's divisional row (if it drives the hero)
 * and global components into the row/total shapes the ScoreBreakdown
 * component renders. The Current tab follows the hero: when the fighter
 * has an in_active_ranking divisional row, that row's components feed
 * the table; otherwise the global view fills it. The All-Time tab is
 * always global.
 *
 * The Current `rawTotal` is the stored raw_current (which already
 * includes the current_cp injection from materialize_divisional_score.ts
 * for divisional rows). The curve multiplier is multiplied_current /
 * raw_current. `finalScore` is the post-curve, post-skid_penalty,
 * 0..100-clamped vertex_score — i.e., what the hero displays.
 */
export function buildScoreBreakdown(
  divisional: FighterDivisionalScoreRow | null,
  global: GlobalScoreComponents | null,
): ScoreBreakdownData | null {
  if (divisional === null && global === null) return null;

  const source: "divisional" | "global" =
    divisional !== null ? "divisional" : "global";

  const currentRows: ScoreComponentRow[] = [
    {
      label: "Quality wins (decayed)",
      raw:
        divisional !== null
          ? divisional.quality_wins
          : global?.quality_wins_decayed ?? null,
      weight: CURRENT_SCORE_WEIGHTS.quality_wins,
    },
    {
      label: "Champion pedigree (current)",
      raw:
        divisional !== null
          ? divisional.divisional_current_cp
          : global?.current_cp ?? null,
      weight: CURRENT_SCORE_WEIGHTS.current_cp,
    },
    {
      label: "Era dominance (recent)",
      raw:
        divisional !== null
          ? divisional.era_dominance
          : global?.era_dominance_current ?? null,
      weight: CURRENT_SCORE_WEIGHTS.era_dominance,
    },
    {
      label: "Performance diff (recent)",
      raw:
        divisional !== null
          ? divisional.performance_diff
          : global?.performance_diff_current ?? null,
      weight: CURRENT_SCORE_WEIGHTS.performance_diff,
    },
    {
      label: "Finishing dom (decayed)",
      raw:
        divisional !== null
          ? divisional.finishing_dominance
          : global?.finishing_dominance_decayed ?? null,
      weight: CURRENT_SCORE_WEIGHTS.finishing_dominance,
    },
    {
      label: "Activity",
      raw:
        divisional !== null
          ? divisional.activity_score
          : global?.activity ?? null,
      weight: CURRENT_SCORE_WEIGHTS.activity,
    },
    {
      label: "Recent form (last 5)",
      raw:
        divisional !== null
          ? divisional.recent_form_score
          : global?.recent_form_score ?? null,
      weight: CURRENT_SCORE_WEIGHTS.recent_form,
    },
    {
      label: "Recent loss penalty",
      raw:
        divisional !== null
          ? divisional.recent_loss_penalty
          : global?.recent_loss_penalty ?? null,
      weight: CURRENT_SCORE_WEIGHTS.recent_loss_penalty,
    },
  ];

  const currentRaw =
    divisional !== null ? divisional.raw_current : global?.raw_current ?? null;
  const currentMultiplied =
    divisional !== null
      ? divisional.multiplied_current
      : global?.multiplied_current ?? null;
  const currentFinal =
    divisional !== null ? divisional.vertex_score : global?.vertex_score ?? null;

  const curveMultiplier =
    currentRaw != null && currentMultiplied != null && currentRaw > 0
      ? currentMultiplied / currentRaw
      : null;

  const allTimeRows: ScoreComponentRow[] = [
    {
      label: "Quality wins (career)",
      raw: global?.quality_wins ?? null,
      weight: ALL_TIME_SCORE_WEIGHTS.quality_wins,
    },
    {
      label: "Champion pedigree",
      raw: global?.championship_pedigree ?? null,
      weight: ALL_TIME_SCORE_WEIGHTS.championship_pedigree,
    },
    {
      label: "Era dominance (all-time)",
      raw: global?.era_dominance_all_time ?? null,
      weight: ALL_TIME_SCORE_WEIGHTS.era_dominance,
    },
    {
      label: "Performance diff (career)",
      raw: global?.performance_diff ?? null,
      weight: ALL_TIME_SCORE_WEIGHTS.performance_diff,
    },
    {
      label: "Finishing dom (career)",
      raw: global?.finishing_dominance_score ?? null,
      weight: ALL_TIME_SCORE_WEIGHTS.finishing_dominance,
    },
    {
      label: "Total loss penalty",
      raw: global?.total_loss_penalty ?? null,
      weight: ALL_TIME_SCORE_WEIGHTS.total_loss_penalty,
    },
  ];

  return {
    source,
    divisionLabel: divisional?.division ?? null,
    current: {
      rows: currentRows,
      rawTotal: currentRaw,
      curveMultiplier,
      finalScore: currentFinal,
    },
    allTime: {
      rows: allTimeRows,
      finalScore: global?.vertex_score_all_time ?? null,
    },
  };
}

/** Wave 14B.2: per-(fighter, division) score row for the profile sidebar
 *  and hero. Mirrors the fighter_divisional_score columns the UI cares
 *  about. Wave 17 added the sub-metric columns powering ScoreBreakdown's
 *  Current tab when the row drives the hero. */
export type FighterDivisionalScoreRow = {
  division: string;
  vertex_score: number | null;
  divisional_status: "current" | "provisional" | "former";
  in_active_ranking: boolean;
  bouts_in_division: number;
  last_bout_date_in_division: string | null;
  divisional_cp: number;
  divisional_current_cp: number | null;
  quality_wins: number | null;
  performance_diff: number | null;
  finishing_dominance: number | null;
  recent_form_score: number | null;
  activity_score: number | null;
  recent_loss_penalty: number | null;
  era_dominance: number | null;
  raw_current: number | null;
  multiplied_current: number | null;
};

/** Wave 17: the slice of `fighter_vertex_score` columns ScoreBreakdown
 *  reads. Sourced directly from the view (which materialises both the
 *  current-branch and all-time-branch component inputs); the view is
 *  read-only here. */
export type GlobalScoreComponents = {
  quality_wins_decayed: number | null;
  current_cp: number | null;
  era_dominance_current: number | null;
  performance_diff_current: number | null;
  finishing_dominance_decayed: number | null;
  activity: number | null;
  recent_form_score: number | null;
  recent_loss_penalty: number | null;
  raw_current: number | null;
  multiplied_current: number | null;
  quality_wins: number | null;
  championship_pedigree: number | null;
  era_dominance_all_time: number | null;
  performance_diff: number | null;
  finishing_dominance_score: number | null;
  total_loss_penalty: number | null;
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
  /** Wave 6E: bout-level fields exposed per row so the UI can pro-rate the
   *  finishing round to a 5-minute equivalent. Both NULL when the scraper
   *  didn't record the finish meta. */
  round_finished: number | null;
  time_finished_seconds: number | null;
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
      f.vertex_score_all_time,
      f.current_division,
      f.control_seconds_avg,
      f.knockdowns_per_fight,
      f.late_round_reach_rate,
      f.fights_last_24mo,
      f.decayed_total_weight,
      f.decayed_kd_per_fight,
      f.decayed_control_per_fight,
      f.decayed_td_landed_per_fight,
      f.decayed_td_attempted_per_fight,
      f.decayed_sub_attempts_per_fight,
      f.decayed_ko_wins_weighted,
      f.decayed_sub_wins_weighted,
      f.decayed_wins_weighted,
      f.decayed_late_reach_rate,
      f.decayed_finish_losses_weighted,
      f.decayed_slpm,
      f.decayed_sapm,
      f.decayed_stand_diff_per_min,
      f.decayed_clinch_diff_per_min,
      f.decayed_ground_diff_per_min
    FROM fighter_with_stats f
    WHERE f.slug = ${slug}
    LIMIT 1
  `);
  const rows = result as unknown as FighterDetail[];
  return rows[0] ?? null;
}

/**
 * Wave 14B.2: per-(fighter, division) current_score rows from
 * fighter_divisional_score (Wave 14A table + Wave 14B.1 eligibility
 * flag). Returns one row per division where the fighter has ≥3
 * completed UFC bouts. Ordered with in_active_ranking=TRUE rows first
 * so the profile sidebar can render the active division up top.
 */
export async function getDivisionalScores(
  fighterId: string,
): Promise<FighterDivisionalScoreRow[]> {
  const result = await db.execute<FighterDivisionalScoreRow>(sql`
    SELECT
      division::text AS division,
      vertex_score,
      divisional_status,
      in_active_ranking,
      bouts_in_division,
      last_bout_date_in_division::text AS last_bout_date_in_division,
      divisional_cp,
      divisional_current_cp,
      quality_wins_decayed AS quality_wins,
      performance_diff_current AS performance_diff,
      finishing_dominance_decayed AS finishing_dominance,
      recent_form_score,
      activity AS activity_score,
      recent_loss_penalty,
      era_dominance_current AS era_dominance,
      raw_current,
      multiplied_current
    FROM fighter_divisional_score
    WHERE fighter_id = ${fighterId}::uuid
    ORDER BY
      in_active_ranking DESC,
      vertex_score DESC NULLS LAST,
      bouts_in_division DESC
  `);
  return [...(result as unknown as FighterDivisionalScoreRow[])];
}

/**
 * Wave 17: per-fighter component inputs to ScoreBreakdown's Current
 * (when no divisional row drives the hero) and All-Time tabs. Reads
 * directly from `fighter_vertex_score`; columns mirror the view's
 * SELECT list verbatim. Returns null when the fighter has no row in the
 * view (≤2 UFC bouts → the view's bouts gate kicks in and excludes them).
 */
export async function getGlobalScoreComponents(
  fighterId: string,
): Promise<GlobalScoreComponents | null> {
  const result = await db.execute<GlobalScoreComponents>(sql`
    SELECT
      quality_wins_decayed,
      current_cp,
      era_dominance_current,
      performance_diff_current,
      finishing_dominance_decayed,
      activity,
      recent_form_score,
      recent_loss_penalty,
      raw_current,
      multiplied_current,
      quality_wins,
      championship_pedigree,
      era_dominance_all_time,
      performance_diff,
      finishing_dominance_score,
      total_loss_penalty,
      vertex_score,
      vertex_score_all_time
    FROM fighter_vertex_score
    WHERE id = ${fighterId}::uuid
    LIMIT 1
  `);
  const rows = result as unknown as GlobalScoreComponents[];
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
      brs.control_time_seconds AS control_seconds,
      b.round_finished,
      b.time_finished_seconds
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
