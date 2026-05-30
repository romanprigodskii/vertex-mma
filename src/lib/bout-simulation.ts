import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export interface BoutSimulationRow {
  modelVersion: string;
  probA: number;
  probB: number;
  predictedWinnerId: string | null;
  confidenceLabel: "low" | "medium" | "high";
  marketProbA: number | null;
  edgeA: number | null;
  generatedAt: string;
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
  return {
    modelVersion: r.model_version,
    probA: r.prob_a,
    probB: r.prob_b,
    predictedWinnerId: r.predicted_winner_id,
    confidenceLabel: label,
    marketProbA: r.market_prob_a,
    edgeA: r.edge_a,
    generatedAt: r.generated_at,
  };
}
