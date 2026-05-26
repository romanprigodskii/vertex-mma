import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export type WatchListRow = {
  bout_id: string;
  fighter_a_name: string;
  fighter_a_slug: string;
  fighter_b_name: string;
  fighter_b_slug: string;
  event_name: string;
  event_short_name: string | null;
  event_slug: string;
  event_date: string;
  weight_class: string;
  is_title_fight: boolean;
  winner_id: string | null;
  fighter_a_id: string;
  fighter_b_id: string;
  method: string | null;
  // One row per bout — we pick the "best" linked video as the cover:
  // longest-running upload (closer to the real unedited fight than the
  // condensed clips).
  youtube_video_id: string;
  video_title: string;
  video_duration_seconds: number | null;
  total_videos: number;
};

/** Returns all bouts that have at least one linked YouTube clip, newest
 *  event first. Bouts with multiple videos collapse to one card; clicking
 *  through goes to the bout page where every linked video is shown. */
export async function listWatchableBouts(limit = 200): Promise<WatchListRow[]> {
  const result = await db.execute<WatchListRow>(sql`
    WITH ranked AS (
      SELECT
        bv.*,
        ROW_NUMBER() OVER (
          PARTITION BY bv.bout_id
          ORDER BY bv.duration_seconds DESC NULLS LAST, bv.created_at DESC
        ) AS rn,
        COUNT(*) OVER (PARTITION BY bv.bout_id) AS total
      FROM bout_video bv
    )
    SELECT
      b.id::text AS bout_id,
      fa.name_en AS fighter_a_name,
      fa.slug AS fighter_a_slug,
      fa.id::text AS fighter_a_id,
      fb.name_en AS fighter_b_name,
      fb.slug AS fighter_b_slug,
      fb.id::text AS fighter_b_id,
      e.name AS event_name,
      e.short_name AS event_short_name,
      e.slug AS event_slug,
      e.date::text AS event_date,
      b.weight_class::text AS weight_class,
      b.is_title_fight,
      b.winner_id::text AS winner_id,
      b.method::text AS method,
      r.youtube_video_id,
      r.title AS video_title,
      r.duration_seconds AS video_duration_seconds,
      r.total::int AS total_videos
    FROM ranked r
    JOIN bout b ON b.id = r.bout_id
    JOIN fighter fa ON fa.id = b.fighter_a_id
    JOIN fighter fb ON fb.id = b.fighter_b_id
    JOIN event e ON e.id = b.event_id
    WHERE r.rn = 1
    ORDER BY e.date DESC NULLS LAST, b.is_main_event DESC, b.is_co_main_event DESC
    LIMIT ${limit}
  `);
  return [...(result as unknown as WatchListRow[])];
}
