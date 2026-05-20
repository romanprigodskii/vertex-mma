import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

/**
 * Wave 31.7 — peak vertex history for a fighter.
 *
 * Returns the highest historical vertex_score the fighter achieved, the
 * bout that triggered it, and the bout (if any) where the score first
 * dropped below that peak. Used by the Peak Vertex profile section.
 *
 * If the fighter has < 3 anchor rows (sub-3-bout careers), returns null.
 */

export interface PeakVertexInfo {
  peak: number;
  peakDate: string;
  /** Bout that produced the peak (anchor of the peak row). */
  anchorBout: {
    id: string;
    eventDate: string;
    eventName: string | null;
    eventSlug: string | null;
    opponentName: string;
    opponentSlug: string;
    result: "W" | "L" | "D" | "NC";
    method: string | null;
  };
  /**
   * First bout AFTER the peak where score dropped below peak. Null when
   * the peak is the most recent anchor (fighter is at or above their
   * historical peak right now).
   */
  endingBout: {
    id: string;
    eventDate: string;
    eventName: string | null;
    eventSlug: string | null;
    opponentName: string;
    opponentSlug: string;
    result: "W" | "L" | "D" | "NC";
    method: string | null;
    scoreAfter: number;
  } | null;
  /** Current vertex_score (or all_time fallback) for the same fighter. */
  currentScore: number | null;
}

type HistoryRow = {
  as_of_bout_id: string;
  as_of_date: string;
  vertex_score: number;
};

type BoutDetailRow = {
  id: string;
  event_date: string;
  event_name: string | null;
  event_slug: string | null;
  method: string | null;
  winner_id: string | null;
  fighter_a_id: string;
  fighter_b_id: string;
  fighter_a_name: string;
  fighter_a_slug: string;
  fighter_b_name: string;
  fighter_b_slug: string;
};

export async function getPeakVertex(
  fighterId: string,
): Promise<PeakVertexInfo | null> {
  // 1. Find peak row (earliest date if ties — represents first achievement).
  const peakRowsResult = await db.execute<HistoryRow>(sql`
    SELECT
      as_of_bout_id::text,
      as_of_date::text,
      vertex_score
    FROM fighter_score_history
    WHERE fighter_id = ${fighterId}::uuid
    ORDER BY vertex_score DESC, as_of_date ASC
    LIMIT 1
  `);
  const peakRows = peakRowsResult as unknown as HistoryRow[];
  const peakRow = peakRows[0];
  if (!peakRow) return null;

  // 2. Find ending bout (first row after peak with vertex_score < peak).
  const endingRowsResult = await db.execute<HistoryRow>(sql`
    SELECT
      as_of_bout_id::text,
      as_of_date::text,
      vertex_score
    FROM fighter_score_history
    WHERE fighter_id = ${fighterId}::uuid
      AND as_of_date > ${peakRow.as_of_date}::date
      AND vertex_score < ${peakRow.vertex_score}
    ORDER BY as_of_date ASC
    LIMIT 1
  `);
  const endingRows = endingRowsResult as unknown as HistoryRow[];
  const endingRow = endingRows[0] ?? null;

  // 3. Hydrate bout details for both. Run separate queries — Drizzle's
  //    sql tag unpacks JS arrays into positional params, which breaks
  //    `= ANY(...)` (needs an array literal on the right). Two queries
  //    are simpler than fighting the template.
  async function fetchBout(boutId: string): Promise<BoutDetailRow | null> {
    const r = await db.execute<BoutDetailRow>(sql`
      SELECT
        b.id::text,
        e.date::text AS event_date,
        e.name AS event_name,
        e.slug AS event_slug,
        b.method::text AS method,
        b.winner_id::text AS winner_id,
        b.fighter_a_id::text AS fighter_a_id,
        b.fighter_b_id::text AS fighter_b_id,
        fa.name_en AS fighter_a_name,
        fa.slug AS fighter_a_slug,
        fb.name_en AS fighter_b_name,
        fb.slug AS fighter_b_slug
      FROM bout b
      JOIN event e ON e.id = b.event_id
      JOIN fighter fa ON fa.id = b.fighter_a_id
      JOIN fighter fb ON fb.id = b.fighter_b_id
      WHERE b.id = ${boutId}::uuid
      LIMIT 1
    `);
    return ((r as unknown as BoutDetailRow[])[0] as BoutDetailRow) ?? null;
  }
  const [peakBout, endingBoutRaw] = await Promise.all([
    fetchBout(peakRow.as_of_bout_id),
    endingRow ? fetchBout(endingRow.as_of_bout_id) : Promise.resolve(null),
  ]);
  const boutMap = new Map<string, BoutDetailRow>();
  if (peakBout) boutMap.set(peakBout.id, peakBout);
  if (endingBoutRaw) boutMap.set(endingBoutRaw.id, endingBoutRaw);

  function hydrate(row: {
    as_of_bout_id: string;
    vertex_score: number;
  }) {
    const b = boutMap.get(row.as_of_bout_id);
    if (!b) return null;
    const isA = b.fighter_a_id === fighterId;
    const opponent_name = isA ? b.fighter_b_name : b.fighter_a_name;
    const opponent_slug = isA ? b.fighter_b_slug : b.fighter_a_slug;
    let result: "W" | "L" | "D" | "NC";
    if (b.winner_id == null) {
      const m = (b.method ?? "").toLowerCase();
      result = m.includes("no_contest") ? "NC" : "D";
    } else if (b.winner_id === fighterId) {
      result = "W";
    } else {
      result = "L";
    }
    return {
      id: b.id,
      eventDate: b.event_date.slice(0, 10),
      eventName: b.event_name,
      eventSlug: b.event_slug,
      opponentName: opponent_name,
      opponentSlug: opponent_slug,
      result,
      method: b.method,
    };
  }

  const anchorBout = hydrate(peakRow);
  if (!anchorBout) return null;
  const endingBoutBase = endingRow ? hydrate(endingRow) : null;

  // Current score: read fighter.vertex_score (with all_time fallback).
  const currentRowResult = await db.execute<{
    vertex_score: number | null;
    vertex_score_all_time: number | null;
  }>(sql`
    SELECT vertex_score, vertex_score_all_time
    FROM fighter
    WHERE id = ${fighterId}::uuid
  `);
  const currentRow = (currentRowResult as unknown as Array<{
    vertex_score: number | null;
    vertex_score_all_time: number | null;
  }>)[0];
  const currentScore =
    currentRow?.vertex_score ?? currentRow?.vertex_score_all_time ?? null;

  return {
    peak: peakRow.vertex_score,
    peakDate: peakRow.as_of_date.slice(0, 10),
    anchorBout,
    endingBout: endingBoutBase && endingRow
      ? { ...endingBoutBase, scoreAfter: endingRow.vertex_score }
      : null,
    currentScore,
  };
}
