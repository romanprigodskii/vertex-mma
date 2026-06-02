import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { isRuLocale, localizedEventNameSql, localizedNameSql } from "@/lib/i18n-name";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PredictionEventListItem = {
  id: string;
  event_id: string;
  event_slug: string;
  event_name: string;
  event_date: string;
  status: string;
  opens_at: string;
  closes_at: string;
  total_participants: number;
  bout_count: number;
};

export async function listOpenPredictionEvents(
  limit = 20,
): Promise<PredictionEventListItem[]> {
  const isRu = await isRuLocale();
  const rows = await db.execute<PredictionEventListItem>(sql`
    SELECT
      pe.id::text AS id,
      pe.event_id::text AS event_id,
      e.slug AS event_slug,
      ${localizedEventNameSql("e", isRu)} AS event_name,
      e.date::text AS event_date,
      pe.status,
      pe.opens_at::text AS opens_at,
      pe.closes_at::text AS closes_at,
      pe.total_participants,
      (SELECT COUNT(*)::int FROM bout WHERE event_id = e.id) AS bout_count
    FROM prediction_event pe
    JOIN event e ON e.id = pe.event_id
    WHERE pe.status = 'upcoming' AND pe.closes_at > NOW()
    ORDER BY pe.closes_at ASC
    LIMIT ${limit}
  `);
  return rows as unknown as PredictionEventListItem[];
}

export type PredictionBoutRow = {
  bout_id: string;
  bout_order: number | null;
  weight_class: string;
  is_main_event: boolean;
  is_co_main_event: boolean;
  is_title_fight: boolean;
  fighter_a_id: string;
  fighter_a_name: string;
  fighter_a_slug: string;
  fighter_a_photo_thumbnail_url: string | null;
  fighter_b_id: string;
  fighter_b_name: string;
  fighter_b_slug: string;
  fighter_b_photo_thumbnail_url: string | null;
  /** Current pick for this user on this bout, if any. */
  picked_fighter_id: string | null;
  /** Once scored: was this pick correct? */
  is_correct: boolean | null;
  /** Bout outcome (so a closed/scored page can render results). */
  bout_status: string;
  bout_winner_id: string | null;
};

export type PredictionEventDetail = PredictionEventListItem & {
  bouts: PredictionBoutRow[];
};

export async function getPredictionEventForUser(
  predictionEventId: string,
  userProfileId: string | null,
): Promise<PredictionEventDetail | null> {
  if (!UUID_RE.test(predictionEventId)) return null;

  const isRu = await isRuLocale();
  const headerRows = await db.execute<PredictionEventListItem>(sql`
    SELECT
      pe.id::text AS id,
      pe.event_id::text AS event_id,
      e.slug AS event_slug,
      ${localizedEventNameSql("e", isRu)} AS event_name,
      e.date::text AS event_date,
      pe.status,
      pe.opens_at::text AS opens_at,
      pe.closes_at::text AS closes_at,
      pe.total_participants,
      (SELECT COUNT(*)::int FROM bout WHERE event_id = e.id) AS bout_count
    FROM prediction_event pe
    JOIN event e ON e.id = pe.event_id
    WHERE pe.id = ${predictionEventId}::uuid
    LIMIT 1
  `);
  const arr = headerRows as unknown as PredictionEventListItem[];
  if (arr.length === 0) return null;
  const ev = arr[0];

  // We pass a sentinel-safe value through to the sub-select. A NULL
  // userProfileId means we shouldn't try to find a pick — we cast the
  // empty string to null::uuid so the join returns nothing.
  const userArg = userProfileId && UUID_RE.test(userProfileId)
    ? userProfileId
    : null;

  const boutRows = await db.execute<PredictionBoutRow>(sql`
    SELECT
      b.id::text AS bout_id,
      b.bout_order,
      b.weight_class::text AS weight_class,
      b.is_main_event,
      b.is_co_main_event,
      b.is_title_fight,
      fa.id::text AS fighter_a_id,
      ${localizedNameSql("fa", isRu)} AS fighter_a_name,
      fa.slug AS fighter_a_slug,
      fa.photo_thumbnail_url AS fighter_a_photo_thumbnail_url,
      fb.id::text AS fighter_b_id,
      ${localizedNameSql("fb", isRu)} AS fighter_b_name,
      fb.slug AS fighter_b_slug,
      fb.photo_thumbnail_url AS fighter_b_photo_thumbnail_url,
      pp.picked_fighter_id::text AS picked_fighter_id,
      pp.is_correct AS is_correct,
      b.status::text AS bout_status,
      b.winner_id::text AS bout_winner_id
    FROM bout b
    JOIN fighter fa ON fa.id = b.fighter_a_id
    JOIN fighter fb ON fb.id = b.fighter_b_id
    LEFT JOIN prediction_pick pp
      ON pp.bout_id = b.id
      AND pp.prediction_event_id = ${predictionEventId}::uuid
      AND pp.user_id = ${userArg}::uuid
    WHERE b.event_id = ${ev.event_id}::uuid
    ORDER BY b.bout_order DESC NULLS LAST, b.id ASC
  `);

  return {
    ...ev,
    bouts: boutRows as unknown as PredictionBoutRow[],
  };
}

export type PredictionStandingRow = {
  rank: number;
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  correct_winners: number;
  total_score: number;
};

/**
 * Per-event standings — the "who won this contest" board. Reads the
 * already-computed prediction_event_result rows and ranks them by score.
 * Empty until the card is scored (results are written at settle time).
 */
export async function getPredictionEventStandings(
  predictionEventId: string,
  limit = 50,
): Promise<PredictionStandingRow[]> {
  if (!UUID_RE.test(predictionEventId)) return [];
  const rows = await db.execute<PredictionStandingRow>(sql`
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY per.total_score DESC, per.correct_winners DESC
      )::int AS rank,
      up.id::text AS user_id,
      up.username,
      up.display_name,
      up.avatar_url,
      per.correct_winners,
      per.total_score
    FROM prediction_event_result per
    JOIN user_profile up ON up.id = per.user_id
    WHERE per.prediction_event_id = ${predictionEventId}::uuid
    ORDER BY per.total_score DESC, per.correct_winners DESC
    LIMIT ${limit}
  `);
  return rows as unknown as PredictionStandingRow[];
}

export type TopPredictorRow = {
  rank: number;
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  total_score: number;
  total_correct: number;
  events_played: number;
};

/**
 * All-time predictions leaderboard — total prediction points across every
 * scored event. Surfaced on the predictions index so the contest has a
 * standing payoff loop, not just per-event boards.
 */
export async function getTopPredictors(limit = 10): Promise<TopPredictorRow[]> {
  const rows = await db.execute<TopPredictorRow>(sql`
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY SUM(per.total_score) DESC, SUM(per.correct_winners) DESC
      )::int AS rank,
      up.id::text AS user_id,
      up.username,
      up.display_name,
      up.avatar_url,
      SUM(per.total_score)::int AS total_score,
      SUM(per.correct_winners)::int AS total_correct,
      COUNT(*)::int AS events_played
    FROM prediction_event_result per
    JOIN user_profile up ON up.id = per.user_id
    GROUP BY up.id, up.username, up.display_name, up.avatar_url
    HAVING SUM(per.total_score) > 0
    ORDER BY SUM(per.total_score) DESC, SUM(per.correct_winners) DESC
    LIMIT ${limit}
  `);
  return rows as unknown as TopPredictorRow[];
}

export type MyPredictionRow = {
  prediction_event_id: string;
  event_slug: string;
  event_name: string;
  event_date: string;
  status: string;
  picks_count: number;
  correct_count: number;
  total_points: number;
};

export async function listMyPredictions(
  userProfileId: string,
): Promise<MyPredictionRow[]> {
  if (!UUID_RE.test(userProfileId)) return [];
  const isRu = await isRuLocale();
  const rows = await db.execute<MyPredictionRow>(sql`
    SELECT
      pe.id::text AS prediction_event_id,
      e.slug AS event_slug,
      ${localizedEventNameSql("e", isRu)} AS event_name,
      e.date::text AS event_date,
      pe.status,
      COUNT(pp.id)::int AS picks_count,
      SUM(CASE WHEN pp.is_correct THEN 1 ELSE 0 END)::int AS correct_count,
      COALESCE(SUM(pp.total_points), 0)::int AS total_points
    FROM prediction_event pe
    JOIN event e ON e.id = pe.event_id
    JOIN prediction_pick pp
      ON pp.prediction_event_id = pe.id
      AND pp.user_id = ${userProfileId}::uuid
    GROUP BY pe.id, e.slug, e.short_name, e.name, e.date, pe.status
    ORDER BY e.date DESC
  `);
  return rows as unknown as MyPredictionRow[];
}
