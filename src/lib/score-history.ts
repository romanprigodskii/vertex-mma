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

interface PeakBout {
  id: string;
  eventDate: string;
  eventName: string | null;
  eventSlug: string | null;
  opponentName: string;
  opponentSlug: string;
  result: "W" | "L" | "D" | "NC";
  method: string | null;
}

export interface PeakVertexInfo {
  peak: number;
  peakDate: string;
  /** Bout that first produced the peak (earliest peak-score row). */
  anchorBout: PeakBout;
  /**
   * Last bout where the fighter was still at the peak score. Same as
   * anchorBout when the peak was held for only one bout — the UI uses
   * the `peakBoutCount > 1` flag to know whether to render the span.
   */
  lastPeakBout: PeakBout;
  /** Number of consecutive (in event order) bouts at the peak score. */
  peakBoutCount: number;
  /**
   * First bout AFTER the peak where score dropped below peak. Null when
   * the peak is the most recent anchor (fighter is at or above their
   * historical peak right now).
   */
  endingBout: (PeakBout & { scoreAfter: number }) | null;
  /** Current vertex_score for the same fighter — null when no current
   *  rating exists (retired fighter, sub-5-bout career, etc.). */
  currentScore: number | null;
  /** All-time vertex_score. Both null only for the deepest <3-bout
   *  case where the fighter has no rating at all. */
  allTimeScore: number | null;
}

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
  // Single round-trip: peak score + first/last peak-bout rows + ending
  // row + fighter's current score via CTEs. Saves 2-3 connections per
  // page render — important on Supabase session pooler (15-slot limit).
  type CombinedRow = {
    peak_score: number;
    peak_count: number;
    first_peak_bout_id: string;
    first_peak_date: string;
    last_peak_bout_id: string;
    last_peak_date: string;
    end_bout_id: string | null;
    end_date: string | null;
    end_score: number | null;
    current_score: number | null;
    all_time_score: number | null;
  };
  const combinedResult = await db.execute<CombinedRow>(sql`
    WITH peak_score AS (
      SELECT MAX(vertex_score) AS peak
      FROM fighter_score_history
      WHERE fighter_id = ${fighterId}::uuid
    ),
    first_peak AS (
      SELECT h.as_of_bout_id, h.as_of_date
      FROM fighter_score_history h
      JOIN peak_score p ON h.vertex_score = p.peak
      WHERE h.fighter_id = ${fighterId}::uuid
      ORDER BY h.as_of_date ASC, h.as_of_bout_id ASC
      LIMIT 1
    ),
    -- First bout AFTER the first peak where the score dropped below it.
    -- Anchors the "consecutive peak streak" — anything before this dip
    -- (and on/after first_peak) is the held-peak run.
    first_dip AS (
      SELECT h.as_of_bout_id, h.as_of_date, h.vertex_score
      FROM fighter_score_history h
      CROSS JOIN first_peak fp
      CROSS JOIN peak_score ps
      WHERE h.fighter_id = ${fighterId}::uuid
        AND h.as_of_date > fp.as_of_date
        AND h.vertex_score < ps.peak
      ORDER BY h.as_of_date ASC, h.as_of_bout_id ASC
      LIMIT 1
    ),
    -- Last bout in the consecutive peak streak: latest peak-score row
    -- strictly before first_dip (or the latest overall if no dip yet).
    last_peak AS (
      SELECT h.as_of_bout_id, h.as_of_date
      FROM fighter_score_history h
      JOIN peak_score p ON h.vertex_score = p.peak
      LEFT JOIN first_dip fd ON true
      WHERE h.fighter_id = ${fighterId}::uuid
        AND (fd.as_of_date IS NULL OR h.as_of_date < fd.as_of_date)
      ORDER BY h.as_of_date DESC, h.as_of_bout_id DESC
      LIMIT 1
    ),
    peak_count AS (
      SELECT COUNT(*)::int AS n
      FROM fighter_score_history h
      JOIN peak_score p ON h.vertex_score = p.peak
      JOIN first_peak fp ON true
      LEFT JOIN first_dip fd ON true
      WHERE h.fighter_id = ${fighterId}::uuid
        AND h.as_of_date >= fp.as_of_date
        AND (fd.as_of_date IS NULL OR h.as_of_date < fd.as_of_date)
    ),
    fighter_now AS (
      SELECT vertex_score, vertex_score_all_time
      FROM fighter
      WHERE id = ${fighterId}::uuid
    )
    SELECT
      ps.peak AS peak_score,
      pc.n AS peak_count,
      fp.as_of_bout_id::text AS first_peak_bout_id,
      fp.as_of_date::text AS first_peak_date,
      lp.as_of_bout_id::text AS last_peak_bout_id,
      lp.as_of_date::text AS last_peak_date,
      fd.as_of_bout_id::text AS end_bout_id,
      fd.as_of_date::text AS end_date,
      fd.vertex_score AS end_score,
      f.vertex_score AS current_score,
      f.vertex_score_all_time AS all_time_score
    FROM peak_score ps
    JOIN peak_count pc ON true
    JOIN first_peak fp ON true
    JOIN last_peak lp ON true
    LEFT JOIN first_dip fd ON true
    LEFT JOIN fighter_now f ON true
  `);
  const combined = (combinedResult as unknown as CombinedRow[])[0];
  if (!combined) return null;

  // Hydrate bout details for first-peak, last-peak (if different), and
  // ending bout in one query via OR — small set, FK lookup, fast.
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
    WHERE b.id = ${combined.first_peak_bout_id}::uuid
       OR b.id = ${combined.last_peak_bout_id}::uuid
       OR b.id = ${combined.end_bout_id ?? combined.first_peak_bout_id}::uuid
  `);
  const boutDetailRows = boutDetailRowsResult as unknown as BoutDetailRow[];
  const boutMap = new Map<string, BoutDetailRow>();
  for (const b of boutDetailRows) boutMap.set(b.id, b);

  function hydrate(boutId: string): PeakBout | null {
    const b = boutMap.get(boutId);
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

  const anchorBout = hydrate(combined.first_peak_bout_id);
  if (!anchorBout) return null;
  const lastPeakBout =
    combined.last_peak_bout_id === combined.first_peak_bout_id
      ? anchorBout
      : hydrate(combined.last_peak_bout_id) ?? anchorBout;
  const endingHydrated = combined.end_bout_id
    ? hydrate(combined.end_bout_id)
    : null;

  return {
    peak: combined.peak_score,
    peakDate: combined.first_peak_date.slice(0, 10),
    anchorBout,
    lastPeakBout,
    peakBoutCount: combined.peak_count,
    endingBout:
      endingHydrated && combined.end_score != null
        ? { ...endingHydrated, scoreAfter: combined.end_score }
        : null,
    // Real current score — null for retired/<5-bout fighters who only
    // carry an all-time score. The PeakVertex panel uses this to decide
    // whether the "vs current" delta makes sense to render.
    currentScore: combined.current_score,
    allTimeScore: combined.all_time_score,
  };
}

export interface ScoreHistoryPoint {
  /** Stable key for React. For bout points it's the bout id; for monthly
   *  snapshots it's `monthly:<date>`. */
  key: string;
  kind: "bout" | "monthly";
  boutId: string | null;
  eventDate: string;
  /** Bout-row metadata. Null for monthly snapshots. */
  eventName: string | null;
  eventSlug: string | null;
  opponentName: string | null;
  opponentSlug: string | null;
  /** Bout result. Null for monthly snapshots — synthetic dates aren't
   *  attached to an outcome. */
  result: "W" | "L" | "D" | "NC" | null;
  method: string | null;
  /** Current-formula score as of this date (already in the history table). */
  currentScore: number;
  /** Wave 53/54/55 all-time formula replayed as-of-date. Null on the
   *  rare anchor row missing the column (legacy data). */
  allTimeScore: number | null;
}

/**
 * Full per-bout score progression for the score-history page. Returns
 * one point per anchor bout in chronological order. Both `currentScore`
 * (Wave 31 replay) and `allTimeScore` (Wave 53/54/55 replay) come from
 * the fighter_score_history table — populated by
 * scripts/compute_score_history.ts.
 *
 * The **latest anchor's** score is overridden with the live displayed
 * value from `fighter` (the same number drawn in the octagon/circle on
 * the profile). Earlier anchors compute time-windowed signals
 * (activity, recent_form, layoff, recent_loss_penalty) as-of-bout-date,
 * but the view that backs the profile column computes them as-of-today
 * — so the replayed latest anchor naturally reads higher when the
 * fighter has been idle since (e.g., Islam's activity score for the 12
 * months ending Nov 2025 captures two championship bouts; the 12
 * months ending today catches just one). Overriding only the last
 * point keeps the chart's right edge consistent with the number the
 * user just clicked on.
 */
export async function getScoreHistory(
  fighterId: string,
): Promise<ScoreHistoryPoint[]> {
  type Row = {
    bout_id: string | null;
    event_date: string;
    kind: "bout" | "monthly";
    event_name: string | null;
    event_slug: string | null;
    method: string | null;
    winner_id: string | null;
    fighter_a_id: string | null;
    vertex_score: number;
    vertex_score_all_time: number | null;
    opponent_name: string | null;
    opponent_slug: string | null;
  };
  const rows = (await db.execute<Row>(sql`
    SELECT
      h.as_of_bout_id::text AS bout_id,
      h.as_of_date::text AS event_date,
      h.kind AS kind,
      ev.name AS event_name,
      ev.slug AS event_slug,
      b.method::text AS method,
      b.winner_id::text AS winner_id,
      b.fighter_a_id::text AS fighter_a_id,
      h.vertex_score AS vertex_score,
      h.vertex_score_all_time AS vertex_score_all_time,
      CASE
        WHEN b.id IS NULL THEN NULL
        WHEN b.fighter_a_id::text = ${fighterId}
          THEN fb.name_en
        ELSE fa.name_en
      END AS opponent_name,
      CASE
        WHEN b.id IS NULL THEN NULL
        WHEN b.fighter_a_id::text = ${fighterId}
          THEN fb.slug
        ELSE fa.slug
      END AS opponent_slug
    FROM fighter_score_history h
    LEFT JOIN bout b ON b.id = h.as_of_bout_id
    LEFT JOIN event ev ON ev.id = b.event_id
    LEFT JOIN fighter fa ON fa.id = b.fighter_a_id
    LEFT JOIN fighter fb ON fb.id = b.fighter_b_id
    WHERE h.fighter_id = ${fighterId}::uuid
    ORDER BY h.as_of_date ASC, h.kind ASC, h.as_of_bout_id ASC
  `)) as unknown as Row[];

  const points: ScoreHistoryPoint[] = rows.map((r) => {
    let result: "W" | "L" | "D" | "NC" | null;
    if (r.kind === "monthly") {
      result = null;
    } else if (r.winner_id == null) {
      const m = (r.method ?? "").toLowerCase();
      result = m.includes("no_contest") ? "NC" : "D";
    } else if (r.winner_id === fighterId) {
      result = "W";
    } else {
      result = "L";
    }
    return {
      key:
        r.kind === "monthly"
          ? `monthly:${r.event_date.slice(0, 10)}`
          : `bout:${r.bout_id}`,
      kind: r.kind,
      boutId: r.bout_id,
      eventDate: r.event_date.slice(0, 10),
      eventName: r.event_name,
      eventSlug: r.event_slug,
      opponentName: r.opponent_name,
      opponentSlug: r.opponent_slug,
      result,
      method: r.method,
      currentScore: r.vertex_score,
      allTimeScore: r.vertex_score_all_time,
    };
  });

  if (points.length > 0) {
    const liveRows = (await db.execute<{
      cur: number | null;
      at: number | null;
    }>(sql`
      SELECT
        vertex_score             AS cur,
        vertex_score_all_time    AS at
      FROM fighter
      WHERE id = ${fighterId}::uuid
    `)) as unknown as Array<{ cur: number | null; at: number | null }>;
    const live = liveRows[0];
    if (live) {
      const last = points[points.length - 1];
      if (live.cur != null) last.currentScore = live.cur;
      if (live.at != null) last.allTimeScore = live.at;
    }
  }

  return points;
}
