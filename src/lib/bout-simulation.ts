import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

/** Canonical 8-4-4-4-12 UUID shape. The looser `[0-9a-f-]{36}` predicate let
 *  through 36-char junk (e.g. all hyphens), which then blew up the `::uuid`
 *  cast (Postgres 22P02) and 500'd the caller. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BoutSimulationFeature {
  featureName: string;
  shapValue: number;
  /** Raw input the model saw — may be NULL when the feature was missing. */
  featureValue: number | null;
  absRank: number;
}

export interface BoutSimulationRounds {
  nSimulations: number;
  mcWinnerProbA: number;
  mcWinnerProbB: number;
  probKoA: number;
  probKoB: number;
  probSubA: number;
  probSubB: number;
  probDecisionA: number;
  probDecisionB: number;
  avgFinishSeconds: number | null;
  /** Index 0 is round 1, etc. Length = scheduled_rounds. Each entry is
   *  the probability the bout was finished IN that round (any method,
   *  either fighter). NULL when scheduled_rounds < that index. */
  finishByRound: Array<number | null>;
}

/**
 * Rescale the raw MC method probabilities so each side's six cells
 * (ko/sub/dec × A/B) sum to the ENSEMBLE's winner_prob for that side,
 * rather than the MC's standalone winner_prob.
 *
 * Motivation: MC and ensemble use different signals and can disagree
 * on who wins. The MC is the better model of HOW a fighter typically
 * wins (KO-heavy vs grappling-heavy vs decision-leaning); the ensemble
 * is the better model of WHICH fighter wins. Conditioning method
 * proportions on the ensemble's winner lets the UI tell one
 * consistent story — "Mingyang wins 79% · most likely by KO" — instead
 * of contradicting itself ("79% Mingyang… most likely KO for
 * Menifield").
 *
 * Implementation: per side we keep MC's relative method mix
 * (e.g. "if Mingyang wins, 95% chance it's by KO") and scale by the
 * ensemble winner prob. Degenerate sides (MC says 0% winner prob)
 * fall back to a 50/50 KO-Dec mix to avoid divide-by-zero.
 */
export function reconcileMcMethodProbs(
  rounds: BoutSimulationRounds,
  ensembleProbA: number,
): {
  probKoA: number;
  probKoB: number;
  probSubA: number;
  probSubB: number;
  probDecisionA: number;
  probDecisionB: number;
} {
  const ensembleProbB = 1 - ensembleProbA;
  const FALLBACK = { ko: 0.5, sub: 0.0, dec: 0.5 };

  function condProbs(
    side: "a" | "b",
  ): { ko: number; sub: number; dec: number } {
    const total =
      side === "a"
        ? rounds.probKoA + rounds.probSubA + rounds.probDecisionA
        : rounds.probKoB + rounds.probSubB + rounds.probDecisionB;
    if (total <= 1e-6) return FALLBACK;
    if (side === "a") {
      return {
        ko: rounds.probKoA / total,
        sub: rounds.probSubA / total,
        dec: rounds.probDecisionA / total,
      };
    }
    return {
      ko: rounds.probKoB / total,
      sub: rounds.probSubB / total,
      dec: rounds.probDecisionB / total,
    };
  }
  const condA = condProbs("a");
  const condB = condProbs("b");
  return {
    probKoA: ensembleProbA * condA.ko,
    probSubA: ensembleProbA * condA.sub,
    probDecisionA: ensembleProbA * condA.dec,
    probKoB: ensembleProbB * condB.ko,
    probSubB: ensembleProbB * condB.sub,
    probDecisionB: ensembleProbB * condB.dec,
  };
}

export interface BoutSimulationRow {
  modelVersion: string;
  probA: number;
  probB: number;
  predictedWinnerId: string | null;
  confidenceLabel: "low" | "medium" | "high";
  marketProbA: number | null;
  edgeA: number | null;
  generatedAt: string;
  /** Top-N (Phase 2: N=8) TreeSHAP attributions, already sorted by
   *  abs_rank ASC. Empty array when feature attribution hasn't been
   *  populated yet (e.g. predict ran on Phase 1 schema). */
  features: BoutSimulationFeature[];
  /** Phase 3 Monte Carlo round distribution. NULL when MC hasn't been
   *  run yet for this (bout, model_version). */
  rounds: BoutSimulationRounds | null;
}

/**
 * Latest row in bout_simulation for this bout. Phase 1 emits one row per
 * (bout_id, model_version); we order by generated_at DESC so a fresh
 * model version overrides older predictions. NULL when no prediction
 * has been written (either both fighters lack prior UFC bouts so we
 * can't engineer features, OR the predict runner hasn't been invoked
 * since the bout was scheduled).
 */
export async function getBoutSimulation(
  boutId: string,
): Promise<BoutSimulationRow | null> {
  type Row = {
    model_version: string;
    prob_a: number;
    prob_b: number;
    predicted_winner_id: string | null;
    confidence_label: string;
    market_prob_a: number | null;
    edge_a: number | null;
    generated_at: string;
  };
  const result = await db.execute<Row>(sql`
    SELECT
      model_version,
      prob_a,
      prob_b,
      predicted_winner_id::text AS predicted_winner_id,
      confidence_label,
      market_prob_a,
      edge_a,
      generated_at::text AS generated_at
    FROM bout_simulation
    WHERE bout_id = ${boutId}::uuid
    ORDER BY generated_at DESC
    LIMIT 1
  `);
  const rows = result as unknown as Row[];
  if (rows.length === 0) return null;
  const r = rows[0];
  const label = (r.confidence_label as BoutSimulationRow["confidenceLabel"]);

  type FRow = {
    feature_name: string;
    shap_value: number;
    feature_value: number | null;
    abs_rank: number;
  };
  const featureResult = await db.execute<FRow>(sql`
    SELECT feature_name, shap_value, feature_value, abs_rank
    FROM bout_simulation_features
    WHERE bout_id = ${boutId}::uuid
      AND model_version = ${r.model_version}
    ORDER BY abs_rank ASC
  `);
  const featureRows = featureResult as unknown as FRow[];
  const features: BoutSimulationFeature[] = featureRows.map((f) => ({
    featureName: f.feature_name,
    shapValue: f.shap_value,
    featureValue: f.feature_value,
    absRank: f.abs_rank,
  }));

  type RRow = {
    n_simulations: number;
    mc_winner_prob_a: number;
    mc_winner_prob_b: number;
    prob_ko_a: number;
    prob_ko_b: number;
    prob_sub_a: number;
    prob_sub_b: number;
    prob_decision_a: number;
    prob_decision_b: number;
    avg_finish_seconds: number | null;
    prob_finish_round_1: number | null;
    prob_finish_round_2: number | null;
    prob_finish_round_3: number | null;
    prob_finish_round_4: number | null;
    prob_finish_round_5: number | null;
  };
  const roundsResult = await db.execute<RRow>(sql`
    SELECT n_simulations, mc_winner_prob_a, mc_winner_prob_b,
           prob_ko_a, prob_ko_b, prob_sub_a, prob_sub_b,
           prob_decision_a, prob_decision_b,
           avg_finish_seconds,
           prob_finish_round_1, prob_finish_round_2, prob_finish_round_3,
           prob_finish_round_4, prob_finish_round_5
    FROM bout_simulation_rounds
    WHERE bout_id = ${boutId}::uuid
      AND model_version = ${r.model_version}
    LIMIT 1
  `);
  const roundsRows = roundsResult as unknown as RRow[];
  const rounds: BoutSimulationRounds | null =
    roundsRows.length === 0
      ? null
      : {
          nSimulations: roundsRows[0].n_simulations,
          mcWinnerProbA: roundsRows[0].mc_winner_prob_a,
          mcWinnerProbB: roundsRows[0].mc_winner_prob_b,
          probKoA: roundsRows[0].prob_ko_a,
          probKoB: roundsRows[0].prob_ko_b,
          probSubA: roundsRows[0].prob_sub_a,
          probSubB: roundsRows[0].prob_sub_b,
          probDecisionA: roundsRows[0].prob_decision_a,
          probDecisionB: roundsRows[0].prob_decision_b,
          avgFinishSeconds: roundsRows[0].avg_finish_seconds,
          finishByRound: [
            roundsRows[0].prob_finish_round_1,
            roundsRows[0].prob_finish_round_2,
            roundsRows[0].prob_finish_round_3,
            roundsRows[0].prob_finish_round_4,
            roundsRows[0].prob_finish_round_5,
          ],
        };

  return {
    modelVersion: r.model_version,
    probA: r.prob_a,
    probB: r.prob_b,
    predictedWinnerId: r.predicted_winner_id,
    confidenceLabel: label,
    marketProbA: r.market_prob_a,
    edgeA: r.edge_a,
    generatedAt: r.generated_at,
    features,
    rounds,
  };
}

export interface BoutSimulationPick {
  predictedWinnerId: string | null;
  probA: number;
  probB: number;
}

/**
 * Batch: the latest prediction (predicted winner + win probs) for a set of
 * bouts, keyed by bout_id. Lets the event card list surface the model's pick
 * inline without an N+1. Bouts with no prediction are simply absent from the
 * map. DISTINCT ON keeps the freshest model_version per bout.
 */
export async function getBoutSimulationPicks(
  boutIds: string[],
): Promise<Map<string, BoutSimulationPick>> {
  const ids = [...new Set(boutIds)].filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return new Map();
  const values = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  type PickRow = {
    bout_id: string;
    prob_a: number;
    prob_b: number;
    predicted_winner_id: string | null;
  };
  const rows = (await db.execute<PickRow>(sql`
    SELECT DISTINCT ON (bs.bout_id)
      bs.bout_id::text AS bout_id,
      bs.prob_a,
      bs.prob_b,
      bs.predicted_winner_id::text AS predicted_winner_id
    FROM bout_simulation bs
    WHERE bs.bout_id IN (${values})
    ORDER BY bs.bout_id, bs.generated_at DESC
  `)) as unknown as PickRow[];
  const map = new Map<string, BoutSimulationPick>();
  for (const r of rows) {
    map.set(r.bout_id, {
      predictedWinnerId: r.predicted_winner_id,
      probA: r.prob_a,
      probB: r.prob_b,
    });
  }
  return map;
}

/**
 * Maps raw model feature names → translation keys + a hint about how to
 * format the feature value alongside the label. Anything not in this
 * map is considered too low-signal / categorical (one-hot weight class,
 * stance flags) and is filtered out of the user-facing breakdown.
 *
 * The "unit" hint is used by the UI to render a compact value tag like
 * "+6 cm" or "27 → 31" — null means hide the raw value entirely.
 */
export type FeatureUnit =
  | "cm"
  | "years"
  | "days"
  | "perMin"
  | "per15"
  | "ratio"
  | "count"
  | "score"
  | null;

export interface FeatureMeta {
  labelKey: string;
  unit: FeatureUnit;
  /** When true, treat as "A's X" / "B's X" absolute (vs diff). */
  side?: "a" | "b";
}

export const FEATURE_META: Record<string, FeatureMeta> = {
  // ── per-fighter difference features (diff = A − B) ────────────────
  diff_age: { labelKey: "diff_age", unit: "years" },
  diff_reach: { labelKey: "diff_reach", unit: "cm" },
  diff_height: { labelKey: "diff_height", unit: "cm" },
  diff_vertex_score: { labelKey: "diff_vertex_score", unit: "score" },
  diff_vertex_score_all_time: {
    labelKey: "diff_vertex_score_all_time",
    unit: "score",
  },
  diff_prior_win_rate: { labelKey: "diff_prior_win_rate", unit: "ratio" },
  diff_prior_bouts: { labelKey: "diff_prior_bouts", unit: "count" },
  diff_prior_wins: { labelKey: "diff_prior_wins", unit: "count" },
  diff_prior_finish_rate: { labelKey: "diff_prior_finish_rate", unit: "ratio" },
  diff_slpm: { labelKey: "diff_slpm", unit: "perMin" },
  diff_sapm: { labelKey: "diff_sapm", unit: "perMin" },
  diff_str_acc: { labelKey: "diff_str_acc", unit: "ratio" },
  diff_td_per15: { labelKey: "diff_td_per15", unit: "per15" },
  diff_td_acc: { labelKey: "diff_td_acc", unit: "ratio" },
  diff_td_def: { labelKey: "diff_td_def", unit: "ratio" },
  diff_sub_per15: { labelKey: "diff_sub_per15", unit: "per15" },
  diff_kd_per_fight: { labelKey: "diff_kd_per_fight", unit: "count" },
  diff_control_per_min: { labelKey: "diff_control_per_min", unit: "perMin" },
  diff_title_bouts: { labelKey: "diff_title_bouts", unit: "count" },
  diff_layoff_days: { labelKey: "diff_layoff_days", unit: "days" },
  diff_recent3_wins: { labelKey: "diff_recent3_wins", unit: "count" },
  diff_recent5_wins: { labelKey: "diff_recent5_wins", unit: "count" },
  diff_current_streak: { labelKey: "diff_current_streak", unit: "count" },
  diff_finish_against_per_bout: { labelKey: "diff_finish_against_per_bout", unit: "ratio" },
  diff_avg_bout_seconds: { labelKey: "diff_avg_bout_seconds", unit: "days" },
  abs_current_streak_a: { labelKey: "abs_current_streak", unit: "count", side: "a" },
  abs_current_streak_b: { labelKey: "abs_current_streak", unit: "count", side: "b" },
  abs_kd_per_fight_a: { labelKey: "abs_kd_per_fight", unit: "count", side: "a" },
  abs_kd_per_fight_b: { labelKey: "abs_kd_per_fight", unit: "count", side: "b" },
  abs_kd_absorbed_per_fight_a: { labelKey: "abs_kd_absorbed_per_fight", unit: "count", side: "a" },
  abs_kd_absorbed_per_fight_b: { labelKey: "abs_kd_absorbed_per_fight", unit: "count", side: "b" },
  age_curve_diff: { labelKey: "age_curve_diff", unit: null },
  stance_asymmetry: { labelKey: "stance_asymmetry", unit: null },
  reach_height_ratio_diff: { labelKey: "reach_height_ratio_diff", unit: null },
  // ── per-fighter absolute features (kept for both sides) ───────────
  abs_age_a: { labelKey: "abs_age", unit: "years", side: "a" },
  abs_age_b: { labelKey: "abs_age", unit: "years", side: "b" },
  abs_vertex_score_a: { labelKey: "abs_vertex_score", unit: "score", side: "a" },
  abs_vertex_score_b: { labelKey: "abs_vertex_score", unit: "score", side: "b" },
  abs_vertex_score_all_time_a: {
    labelKey: "abs_vertex_score_all_time",
    unit: "score",
    side: "a",
  },
  abs_vertex_score_all_time_b: {
    labelKey: "abs_vertex_score_all_time",
    unit: "score",
    side: "b",
  },
  abs_layoff_days_a: { labelKey: "abs_layoff_days", unit: "days", side: "a" },
  abs_layoff_days_b: { labelKey: "abs_layoff_days", unit: "days", side: "b" },
  abs_prior_bouts_a: { labelKey: "abs_prior_bouts", unit: "count", side: "a" },
  abs_prior_bouts_b: { labelKey: "abs_prior_bouts", unit: "count", side: "b" },
  // ── context features ──────────────────────────────────────────────
  market_prob_a: { labelKey: "market_prob_a", unit: "ratio" },
  market_log_odds: { labelKey: "market_log_odds", unit: null },
  is_title_fight: { labelKey: "is_title_fight", unit: null },
  is_main_event: { labelKey: "is_main_event", unit: null },
  scheduled_rounds: { labelKey: "scheduled_rounds", unit: "count" },
};

/** Filter + normalize raw SHAP rows into what the UI should actually
 *  render. Drops features without a registered label (one-hots etc.),
 *  caps at `maxItems`, and re-sorts by |shap| in case the DB had
 *  abs_rank from a different N. */
export function selectDisplayFeatures(
  features: BoutSimulationFeature[],
  maxItems = 5,
): Array<BoutSimulationFeature & { meta: FeatureMeta }> {
  const labeled = features.flatMap((f) => {
    const meta = FEATURE_META[f.featureName];
    return meta ? [{ ...f, meta }] : [];
  });
  labeled.sort((a, b) => Math.abs(b.shapValue) - Math.abs(a.shapValue));
  return labeled.slice(0, maxItems);
}
