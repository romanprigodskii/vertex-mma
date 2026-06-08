import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { isRuLocale, localizedEventNameSql, localizedNameSql } from "@/lib/i18n-name";

export interface SimulationIndexBout {
  boutId: string;
  eventId: string;
  eventSlug: string;
  eventName: string;
  eventDate: string;
  fighterAId: string;
  fighterAName: string;
  fighterASlug: string;
  fighterAPhotoUrl: string | null;
  fighterBId: string;
  fighterBName: string;
  fighterBSlug: string;
  fighterBPhotoUrl: string | null;
  weightClass: string;
  isTitleFight: boolean;
  isMainEvent: boolean;
  scheduledRounds: number;
  /** Calibrated P(A wins) from the ensemble (see scripts/simulation). */
  probA: number;
  probB: number;
  predictedWinnerId: string | null;
  confidenceLabel: "low" | "medium" | "high";
  marketProbA: number | null;
  edgeA: number | null;
  modelVersion: string;
  /** MC summary — null if Phase 3 hasn't been run for this bout. */
  mcProbKoA: number | null;
  mcProbKoB: number | null;
  mcProbSubA: number | null;
  mcProbSubB: number | null;
  mcProbDecisionA: number | null;
  mcProbDecisionB: number | null;
  mcAvgFinishSeconds: number | null;
}

export interface SimulationIndexEvent {
  eventId: string;
  eventSlug: string;
  eventName: string;
  eventDate: string;
  bouts: SimulationIndexBout[];
}

/**
 * Returns every upcoming UFC bout we've scored, grouped by event.
 *
 * "Upcoming" = a still-live bout (status 'scheduled'/'in_progress') on an
 * event dated today or later — so cancelled / no-contest bouts and past
 * cards whose results haven't been ingested yet never leak in as active
 * picks. We pull from bout_simulation
 * (the calibrated ensemble headline number), join the matching
 * bout_simulation_rounds row when present (Phase 3 MC summary), and
 * surface enough fighter context (name, photo) to render the card
 * inline without round-tripping to /bouts/[id].
 *
 * Sorted by event_date ASC so the next card is at the top.
 */
export async function getUpcomingSimulationIndex(): Promise<SimulationIndexEvent[]> {
  type Row = {
    bout_id: string;
    event_id: string;
    event_slug: string;
    event_name: string;
    event_date: string;
    fighter_a_id: string;
    fighter_a_name: string;
    fighter_a_slug: string;
    fighter_a_photo_url: string | null;
    fighter_b_id: string;
    fighter_b_name: string;
    fighter_b_slug: string;
    fighter_b_photo_url: string | null;
    weight_class: string;
    is_title_fight: boolean;
    is_main_event: boolean;
    scheduled_rounds: number;
    prob_a: number;
    prob_b: number;
    predicted_winner_id: string | null;
    confidence_label: string;
    market_prob_a: number | null;
    edge_a: number | null;
    model_version: string;
    mc_prob_ko_a: number | null;
    mc_prob_ko_b: number | null;
    mc_prob_sub_a: number | null;
    mc_prob_sub_b: number | null;
    mc_prob_decision_a: number | null;
    mc_prob_decision_b: number | null;
    mc_avg_finish_seconds: number | null;
  };

  const isRu = await isRuLocale();
  // DISTINCT ON (bout_id) so we collapse history if multiple model
  // versions ever land on the same bout — the most-recent generated_at
  // wins (Phase 5+ should only ever have one row per bout anyway).
  const result = await db.execute<Row>(sql`
    SELECT DISTINCT ON (b.id)
      b.id::text AS bout_id,
      e.id::text AS event_id,
      e.slug AS event_slug,
      ${localizedEventNameSql("e", isRu)} AS event_name,
      e.date::text AS event_date,
      fa.id::text AS fighter_a_id,
      ${localizedNameSql("fa", isRu)} AS fighter_a_name,
      fa.slug AS fighter_a_slug,
      fa.photo_thumbnail_url AS fighter_a_photo_url,
      fb.id::text AS fighter_b_id,
      ${localizedNameSql("fb", isRu)} AS fighter_b_name,
      fb.slug AS fighter_b_slug,
      fb.photo_thumbnail_url AS fighter_b_photo_url,
      b.weight_class::text AS weight_class,
      b.is_title_fight,
      b.is_main_event,
      b.scheduled_rounds,
      bs.prob_a,
      bs.prob_b,
      bs.predicted_winner_id::text AS predicted_winner_id,
      bs.confidence_label,
      bs.market_prob_a,
      bs.edge_a,
      bs.model_version,
      bsr.prob_ko_a AS mc_prob_ko_a,
      bsr.prob_ko_b AS mc_prob_ko_b,
      bsr.prob_sub_a AS mc_prob_sub_a,
      bsr.prob_sub_b AS mc_prob_sub_b,
      bsr.prob_decision_a AS mc_prob_decision_a,
      bsr.prob_decision_b AS mc_prob_decision_b,
      bsr.avg_finish_seconds AS mc_avg_finish_seconds
    FROM bout b
    JOIN event e ON e.id = b.event_id
    JOIN fighter fa ON fa.id = b.fighter_a_id
    JOIN fighter fb ON fb.id = b.fighter_b_id
    JOIN bout_simulation bs ON bs.bout_id = b.id
    LEFT JOIN bout_simulation_rounds bsr
      ON bsr.bout_id = b.id AND bsr.model_version = bs.model_version
    WHERE e.promotion = 'ufc'
      AND b.status IN ('scheduled', 'in_progress')
      AND e.date >= CURRENT_DATE
    ORDER BY b.id, bs.generated_at DESC
  `);
  const rows = result as unknown as Row[];

  const byEvent = new Map<string, SimulationIndexEvent>();
  for (const r of rows) {
    const bout: SimulationIndexBout = {
      boutId: r.bout_id,
      eventId: r.event_id,
      eventSlug: r.event_slug,
      eventName: r.event_name,
      eventDate: r.event_date,
      fighterAId: r.fighter_a_id,
      fighterAName: r.fighter_a_name,
      fighterASlug: r.fighter_a_slug,
      fighterAPhotoUrl: r.fighter_a_photo_url,
      fighterBId: r.fighter_b_id,
      fighterBName: r.fighter_b_name,
      fighterBSlug: r.fighter_b_slug,
      fighterBPhotoUrl: r.fighter_b_photo_url,
      weightClass: r.weight_class,
      isTitleFight: r.is_title_fight,
      isMainEvent: r.is_main_event,
      scheduledRounds: r.scheduled_rounds,
      probA: r.prob_a,
      probB: r.prob_b,
      predictedWinnerId: r.predicted_winner_id,
      confidenceLabel: r.confidence_label as SimulationIndexBout["confidenceLabel"],
      marketProbA: r.market_prob_a,
      edgeA: r.edge_a,
      modelVersion: r.model_version,
      mcProbKoA: r.mc_prob_ko_a,
      mcProbKoB: r.mc_prob_ko_b,
      mcProbSubA: r.mc_prob_sub_a,
      mcProbSubB: r.mc_prob_sub_b,
      mcProbDecisionA: r.mc_prob_decision_a,
      mcProbDecisionB: r.mc_prob_decision_b,
      mcAvgFinishSeconds: r.mc_avg_finish_seconds,
    };
    const ev = byEvent.get(r.event_id);
    if (ev) {
      ev.bouts.push(bout);
    } else {
      byEvent.set(r.event_id, {
        eventId: r.event_id,
        eventSlug: r.event_slug,
        eventName: r.event_name,
        eventDate: r.event_date,
        bouts: [bout],
      });
    }
  }

  // Sort events by date ascending; within event, main events / title
  // bouts first then the rest in scheduled order (we don't have
  // bout_order in this query — use confidence as a soft proxy so the
  // most actionable card lands first).
  const events = Array.from(byEvent.values());
  events.sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  for (const ev of events) {
    ev.bouts.sort((a, b) => {
      if (a.isMainEvent !== b.isMainEvent) return a.isMainEvent ? -1 : 1;
      if (a.isTitleFight !== b.isTitleFight) return a.isTitleFight ? -1 : 1;
      return 0;
    });
  }
  return events;
}

export interface SimulationIndexSummary {
  totalBouts: number;
  totalEvents: number;
  highConfidence: number;
  withMarketEdge: number;
  modelVersion: string | null;
}

export function summarizeSimulationIndex(
  events: SimulationIndexEvent[],
): SimulationIndexSummary {
  let totalBouts = 0;
  let highConfidence = 0;
  let withMarketEdge = 0;
  let modelVersion: string | null = null;
  for (const ev of events) {
    totalBouts += ev.bouts.length;
    for (const b of ev.bouts) {
      if (b.confidenceLabel === "high") highConfidence += 1;
      if (b.edgeA != null && Math.abs(b.edgeA) >= 0.05) withMarketEdge += 1;
      modelVersion ??= b.modelVersion;
    }
  }
  return {
    totalBouts,
    totalEvents: events.length,
    highConfidence,
    withMarketEdge,
    modelVersion,
  };
}
