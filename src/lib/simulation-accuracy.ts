import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { isRuLocale, localizedEventNameSql, localizedNameSql } from "@/lib/i18n-name";

/**
 * Retrospective grading layer for bout_simulation. Every completed
 * UFC bout we made a prediction for becomes a graded data point —
 * compare predicted_winner_id with actual winner_id. This closes the
 * loop on the model and powers the accuracy stat strip on
 * /simulation so users can see whether the model has been right
 * recently (and how confidently).
 */

export interface GradedSimulationPick {
  boutId: string;
  eventId: string;
  eventSlug: string;
  eventName: string;
  eventDate: string;
  modelVersion: string;
  confidenceLabel: "low" | "medium" | "high";
  predictedWinnerName: string;
  predictedWinnerSlug: string;
  predictedWinnerProb: number;
  actualWinnerName: string;
  actualWinnerSlug: string;
  correct: boolean;
  method: string | null;
}

/** Below this many graded picks the hit rate is too noisy to present as a
 *  headline stat (a 2-pick "100%" is meaningless). Consumers should gate the
 *  big number on `summary.reliable` and otherwise show "not enough data yet". */
export const MIN_RELIABLE_GRADED = 20;

export interface AccuracySummary {
  /** Number of graded picks in the window. */
  total: number;
  /** Hits over total. NaN when total = 0. */
  hitRate: number;
  /** False when `total < MIN_RELIABLE_GRADED` — the rate is too small a sample
   *  to trust as a headline figure (and the graded set is itself biased toward
   *  predictable fighters — see getGradedSimulations). */
  reliable: boolean;
  /** Per-confidence-band hit counts: [hits, total]. */
  perConfidence: Record<
    "low" | "medium" | "high",
    { hits: number; total: number }
  >;
  /** Latest model version that has graded data (NULL if no graded data). */
  modelVersion: string | null;
}

/**
 * Pull every completed UFC bout that has a corresponding
 * bout_simulation row, joined with the actual winner so we can
 * compare. Excludes draws/no-contests since those have NULL winner_id.
 *
 * Returns up to `limit` rows ordered by event_date DESC (newest
 * first), so callers asking for "recent graded picks" get the most
 * relevant set.
 *
 * SAMPLING BIAS (read the headline accuracy with this in mind): a bout only
 * gets a prediction when BOTH fighters already had ≥1 prior UFC bout (the
 * predict.py feature-engineering filter), and only predictions with a
 * resolvable winner are graded here. So the graded set skews toward
 * experienced, more-predictable matchups and EXCLUDES debuts / short-notice
 * fights — the hit rate is optimistic vs the full slate, and is a "recent
 * graded picks" figure, not population accuracy. Gate the headline on
 * `summarizeAccuracy(...).reliable` (min-N) so a handful of picks can't render
 * a meaningless 100%.
 */
export async function getGradedSimulations(
  limit = 60,
): Promise<GradedSimulationPick[]> {
  const isRu = await isRuLocale();
  type Row = {
    bout_id: string;
    event_id: string;
    event_slug: string;
    event_name: string;
    event_date: string;
    model_version: string;
    confidence_label: string;
    prob_a: number;
    prob_b: number;
    predicted_winner_id: string | null;
    predicted_winner_name: string | null;
    predicted_winner_slug: string | null;
    actual_winner_id: string;
    actual_winner_name: string;
    actual_winner_slug: string;
    method: string | null;
  };

  // The same DISTINCT ON (bout_id) trick as the upcoming index — keep
  // the newest model_version's prediction per bout, drop stale older
  // versions from accuracy stats so a v0.5.0 backtest doesn't get
  // polluted by v0.1.0 picks.
  const result = await db.execute<Row>(sql`
    SELECT DISTINCT ON (b.id)
      b.id::text AS bout_id,
      e.id::text AS event_id,
      e.slug AS event_slug,
      ${localizedEventNameSql("e", isRu)} AS event_name,
      e.date::text AS event_date,
      bs.model_version,
      bs.confidence_label,
      bs.prob_a,
      bs.prob_b,
      bs.predicted_winner_id::text AS predicted_winner_id,
      ${localizedNameSql("pf", isRu)} AS predicted_winner_name,
      pf.slug AS predicted_winner_slug,
      b.winner_id::text AS actual_winner_id,
      ${localizedNameSql("wf", isRu)} AS actual_winner_name,
      wf.slug AS actual_winner_slug,
      b.method::text AS method
    FROM bout b
    JOIN event e ON e.id = b.event_id
    JOIN bout_simulation bs ON bs.bout_id = b.id
    JOIN fighter wf ON wf.id = b.winner_id
    -- INNER join: only grade picks where the model actually named a winner we
    -- can resolve. A NULL/orphaned predicted_winner_id (e.g. a fighter
    -- re-import) isn't an honest "miss" — it's ungradeable, so drop it.
    JOIN fighter pf ON pf.id = bs.predicted_winner_id
    WHERE e.promotion = 'ufc'
      AND b.status = 'completed'
      AND b.winner_id IS NOT NULL
      AND (b.method IS NULL OR b.method::text != 'no_contest')
    ORDER BY b.id, bs.generated_at DESC
  `);

  // Pull up to a healthy buffer so we can sort and slice; the
  // ORDER BY above is by bout_id (needed for DISTINCT ON), so we
  // re-sort by event_date in JS.
  const rows = result as unknown as Row[];
  rows.sort((a, b) => b.event_date.localeCompare(a.event_date));
  const sliced = rows.slice(0, limit);

  return sliced.map((r) => {
    const predictedIsA = r.prob_a >= 0.5;
    const predProb = predictedIsA ? r.prob_a : r.prob_b;
    const correct = r.predicted_winner_id === r.actual_winner_id;
    return {
      boutId: r.bout_id,
      eventId: r.event_id,
      eventSlug: r.event_slug,
      eventName: r.event_name,
      eventDate: r.event_date,
      modelVersion: r.model_version,
      confidenceLabel: r.confidence_label as GradedSimulationPick["confidenceLabel"],
      predictedWinnerName: r.predicted_winner_name ?? r.actual_winner_name,
      predictedWinnerSlug: r.predicted_winner_slug ?? r.actual_winner_slug,
      predictedWinnerProb: predProb,
      actualWinnerName: r.actual_winner_name,
      actualWinnerSlug: r.actual_winner_slug,
      correct,
      method: r.method,
    };
  });
}

/**
 * Aggregate hit rate + per-confidence breakdown over a list of graded
 * picks. Caller decides the window (e.g. pass last 30 to get
 * "last 30 days" or pass all to get model lifetime). NaN-safe.
 */
export function summarizeAccuracy(picks: GradedSimulationPick[]): AccuracySummary {
  const perConfidence: AccuracySummary["perConfidence"] = {
    low: { hits: 0, total: 0 },
    medium: { hits: 0, total: 0 },
    high: { hits: 0, total: 0 },
  };
  let hits = 0;
  let modelVersion: string | null = null;
  for (const p of picks) {
    if (p.correct) hits += 1;
    const bucket = perConfidence[p.confidenceLabel] ?? perConfidence.low;
    bucket.total += 1;
    if (p.correct) bucket.hits += 1;
    modelVersion ??= p.modelVersion;
  }
  const total = picks.length;
  return {
    total,
    hitRate: total > 0 ? hits / total : Number.NaN,
    reliable: total >= MIN_RELIABLE_GRADED,
    perConfidence,
    modelVersion,
  };
}
