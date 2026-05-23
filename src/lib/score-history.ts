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
  // Single round-trip: peak row + ending row + fighter's current score,
  // all in one query via CTEs. Saves 2-3 connections per page render —
  // important on Supabase session pooler (15-slot limit).
  type CombinedRow = {
    peak_bout_id: string;
    peak_date: string;
    peak_score: number;
    end_bout_id: string | null;
    end_date: string | null;
    end_score: number | null;
    current_score: number | null;
    all_time_score: number | null;
  };
  const combinedResult = await db.execute<CombinedRow>(sql`
    WITH peak AS (
      SELECT
        as_of_bout_id,
        as_of_date,
        vertex_score
      FROM fighter_score_history
      WHERE fighter_id = ${fighterId}::uuid
      ORDER BY vertex_score DESC, as_of_date ASC
      LIMIT 1
    ),
    ending AS (
      SELECT
        h.as_of_bout_id,
        h.as_of_date,
        h.vertex_score
      FROM fighter_score_history h
      CROSS JOIN peak p
      WHERE h.fighter_id = ${fighterId}::uuid
        AND h.as_of_date > p.as_of_date
        AND h.vertex_score < p.vertex_score
      ORDER BY h.as_of_date ASC
      LIMIT 1
    ),
    fighter_now AS (
      SELECT vertex_score, vertex_score_all_time
      FROM fighter
      WHERE id = ${fighterId}::uuid
    )
    SELECT
      p.as_of_bout_id::text AS peak_bout_id,
      p.as_of_date::text AS peak_date,
      p.vertex_score AS peak_score,
      e.as_of_bout_id::text AS end_bout_id,
      e.as_of_date::text AS end_date,
      e.vertex_score AS end_score,
      f.vertex_score AS current_score,
      f.vertex_score_all_time AS all_time_score
    FROM peak p
    LEFT JOIN ending e ON true
    LEFT JOIN fighter_now f ON true
  `);
  const combined = (combinedResult as unknown as CombinedRow[])[0];
  if (!combined) return null;

  // Hydrate bout details: peak + ending (if present) in one query via
  // UNION ALL. Avoids the array-param ANY issue and keeps it single-RTT.
  const boutDetailRowsResult = await db.execute<BoutDetailRow>(sql`
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
    WHERE b.id = ${combined.peak_bout_id}::uuid
       OR b.id = ${combined.end_bout_id ?? combined.peak_bout_id}::uuid
  `);
  const boutDetailRows = boutDetailRowsResult as unknown as BoutDetailRow[];
  const boutMap = new Map<string, BoutDetailRow>();
  for (const b of boutDetailRows) boutMap.set(b.id, b);

  const peakRow = {
    as_of_bout_id: combined.peak_bout_id,
    as_of_date: combined.peak_date,
    vertex_score: combined.peak_score,
  };
  const endingRow = combined.end_bout_id
    ? {
        as_of_bout_id: combined.end_bout_id,
        as_of_date: combined.end_date!,
        vertex_score: combined.end_score!,
      }
    : null;

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

  // Keep `currentScore` strictly `vertex_score`. Falling back to all-time
  // for retired/inactive fighters made the Peak Vertex panel read as if
  // they had only dropped a few points; the UI now treats `null` as 0
  // so the displayed "vs current" delta reflects the full drop from
  // peak — i.e. how much they've fallen on the whole rating.
  const currentScore = combined.current_score ?? null;

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
