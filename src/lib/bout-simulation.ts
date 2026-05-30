import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export interface BoutSimulationFeature {
  featureName: string;
  shapValue: number;
  /** Raw input the model saw — may be NULL when the feature was missing. */
  featureValue: number | null;
  absRank: number;
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
  };
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
