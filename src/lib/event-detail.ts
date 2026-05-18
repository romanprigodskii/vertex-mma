import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export type EventListItem = {
  id: string;
  slug: string;
  name: string;
  short_name: string | null;
  date: string;
  location_city: string | null;
  location_country: string | null;
  venue: string | null;
  poster_url: string | null;
  status: string;
  promotion: string;
  bout_count: number;
};

export type EventListFilter = "upcoming" | "past" | "all";

/**
 * Listing for /events. Three filters:
 *   upcoming  — status in (upcoming, in_progress) AND date >= yesterday;
 *               ASC by date so the next card sits first.
 *   past      — status = completed OR date < yesterday; DESC so the most
 *               recent event is first.
 *   all       — everything, DESC.
 *
 * `bout_count` is a subselect on bout.event_id (indexed) so each card
 * gets its count in one round-trip.
 */
export async function listEvents(
  filter: EventListFilter = "all",
  limit = 60,
): Promise<EventListItem[]> {
  if (filter === "upcoming") {
    const rows = await db.execute<EventListItem>(sql`
      SELECT
        e.id::text AS id,
        e.slug,
        e.name,
        e.short_name,
        e.date::text AS date,
        e.location_city,
        e.location_country,
        e.venue,
        e.poster_url,
        e.status::text AS status,
        e.promotion::text AS promotion,
        (SELECT COUNT(*)::int FROM bout WHERE event_id = e.id) AS bout_count
      FROM event e
      WHERE e.status IN ('upcoming', 'in_progress')
        AND e.date >= NOW() - INTERVAL '1 day'
      ORDER BY e.date ASC
      LIMIT ${limit}
    `);
    return rows as unknown as EventListItem[];
  }
  if (filter === "past") {
    const rows = await db.execute<EventListItem>(sql`
      SELECT
        e.id::text AS id,
        e.slug,
        e.name,
        e.short_name,
        e.date::text AS date,
        e.location_city,
        e.location_country,
        e.venue,
        e.poster_url,
        e.status::text AS status,
        e.promotion::text AS promotion,
        (SELECT COUNT(*)::int FROM bout WHERE event_id = e.id) AS bout_count
      FROM event e
      WHERE e.status = 'completed' OR e.date < NOW() - INTERVAL '1 day'
      ORDER BY e.date DESC
      LIMIT ${limit}
    `);
    return rows as unknown as EventListItem[];
  }
  const rows = await db.execute<EventListItem>(sql`
    SELECT
      e.id::text AS id,
      e.slug,
      e.name,
      e.short_name,
      e.date::text AS date,
      e.location_city,
      e.location_country,
      e.venue,
      e.poster_url,
      e.status::text AS status,
      e.promotion::text AS promotion,
      (SELECT COUNT(*)::int FROM bout WHERE event_id = e.id) AS bout_count
    FROM event e
    ORDER BY e.date DESC
    LIMIT ${limit}
  `);
  return rows as unknown as EventListItem[];
}

export type EventFighterRef = {
  id: string;
  slug: string;
  name_en: string;
  nickname: string | null;
  photo_url: string | null;
  country_code: string | null;
};

export type EventBout = {
  id: string;
  bout_order: number | null;
  weight_class: string;
  is_title_fight: boolean;
  is_main_event: boolean;
  is_co_main_event: boolean;
  scheduled_rounds: number;
  status: string;
  winner_id: string | null;
  method: string | null;
  round_finished: number | null;
  time_finished_seconds: number | null;
  fighter_a: EventFighterRef;
  fighter_b: EventFighterRef;
};

export type EventDetail = {
  id: string;
  slug: string;
  name: string;
  short_name: string | null;
  promotion: string;
  date: string; // ISO timestamp
  location_city: string | null;
  location_country: string | null;
  venue: string | null;
  poster_url: string | null;
  status: string;
};

export async function getEventBySlug(slug: string): Promise<EventDetail | null> {
  const result = await db.execute<EventDetail>(sql`
    SELECT
      id::text AS id,
      slug,
      name,
      short_name,
      promotion::text AS promotion,
      date::text AS date,
      location_city,
      location_country,
      venue,
      poster_url,
      status::text AS status
    FROM event
    WHERE slug = ${slug}
    LIMIT 1
  `);
  const rows = result as unknown as EventDetail[];
  return rows[0] ?? null;
}

/**
 * All bouts for an event in card order (top of card first).
 * `bout_order` ascending feels intuitive but in our data the field is
 * "card position" where 1 = first prelim and main events get the highest
 * numbers, so we ORDER DESC to show main event first. Fall back to id when
 * order is null.
 */
export async function getEventBouts(eventId: string): Promise<EventBout[]> {
  const result = await db.execute<EventBout>(sql`
    SELECT
      b.id::text AS id,
      b.bout_order,
      b.weight_class::text AS weight_class,
      b.is_title_fight,
      b.is_main_event,
      b.is_co_main_event,
      b.scheduled_rounds,
      b.status::text AS status,
      b.winner_id::text AS winner_id,
      b.method::text AS method,
      b.round_finished,
      b.time_finished_seconds,
      json_build_object(
        'id', fa.id::text,
        'slug', fa.slug,
        'name_en', fa.name_en,
        'nickname', fa.nickname,
        'photo_url', fa.photo_url,
        'country_code', fa.country_code
      ) AS fighter_a,
      json_build_object(
        'id', fb.id::text,
        'slug', fb.slug,
        'name_en', fb.name_en,
        'nickname', fb.nickname,
        'photo_url', fb.photo_url,
        'country_code', fb.country_code
      ) AS fighter_b
    FROM bout b
    JOIN fighter fa ON fa.id = b.fighter_a_id
    JOIN fighter fb ON fb.id = b.fighter_b_id
    WHERE b.event_id = ${eventId}::uuid
    ORDER BY b.is_main_event DESC, b.is_co_main_event DESC,
             b.bout_order DESC NULLS LAST, b.id ASC
  `);
  return [...(result as unknown as EventBout[])];
}
