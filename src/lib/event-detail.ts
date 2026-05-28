import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { isRuLocale, localizedNameSql } from "@/lib/i18n-name";

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
  const isRu = await isRuLocale();
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
        'name_en', ${localizedNameSql("fa", isRu)},
        'nickname', fa.nickname,
        'photo_url', fa.photo_url,
        'country_code', fa.country_code
      ) AS fighter_a,
      json_build_object(
        'id', fb.id::text,
        'slug', fb.slug,
        'name_en', ${localizedNameSql("fb", isRu)},
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

export type MentionedEvent = {
  id: string;
  slug: string;
  name: string;
  short_name: string | null;
  /** The actual text that was verified to be present in the body, e.g.,
   *  "UFC 326" for an event whose full short_name is "UFC 326: Holloway
   *  vs. Oliveira 2". Articles almost always cite events by the prefix,
   *  not the full subtitle. */
  match_text: string;
};

/** Scan body text for any event whose prefix (text before ":") appears as
 *  a substring. Articles like "He lost to Caio Borralho at UFC 326" only
 *  cite the prefix, so matching on the full short_name "UFC 326: Holloway
 *  vs. Oliveira 2" would miss every real-world reference.
 *
 *  We return both `match_text` (the prefix that's actually in the body)
 *  and the canonical `short_name`/`name` so the autolinker can prefer a
 *  longer alias if the full string also happens to appear. */
export async function detectMentionedEvents(
  body: string,
): Promise<MentionedEvent[]> {
  if (!body || body.trim().length === 0) return [];
  const rows = (await db.execute<MentionedEvent>(sql`
    WITH candidate AS (
      SELECT
        e.id,
        e.slug,
        e.name,
        e.short_name,
        TRIM(split_part(COALESCE(e.short_name, e.name), ':', 1)) AS prefix
      FROM event e
      WHERE COALESCE(e.short_name, e.name) IS NOT NULL
    )
    SELECT
      c.id::text AS id,
      c.slug,
      c.name,
      c.short_name,
      c.prefix AS match_text
    FROM candidate c
    WHERE char_length(c.prefix) >= 5
      AND ${body} ILIKE '%' || c.prefix || '%'
    ORDER BY char_length(c.prefix) DESC
    LIMIT 20
  `)) as unknown as MentionedEvent[];
  return rows;
}

export type UpcomingEventSidebar = {
  id: string;
  slug: string;
  name: string;
  short_name: string | null;
  date: string;
  promotion: string;
  bout_count: number;
  main_event_fighter_a: string | null;
  main_event_fighter_b: string | null;
  main_event_weight_class: string | null;
};

/** Single-query helper for the news sidebar: the next upcoming event plus
 *  the names of its main-event corners. Returns null when nothing upcoming. */
export async function getNextUpcomingEventForSidebar(): Promise<UpcomingEventSidebar | null> {
  const isRu = await isRuLocale();
  const rows = (await db.execute<UpcomingEventSidebar>(sql`
    SELECT
      e.id::text AS id,
      e.slug,
      e.name,
      e.short_name,
      e.date::text AS date,
      e.promotion::text AS promotion,
      (SELECT COUNT(*)::int FROM bout WHERE event_id = e.id) AS bout_count,
      me.fighter_a_name AS main_event_fighter_a,
      me.fighter_b_name AS main_event_fighter_b,
      me.weight_class AS main_event_weight_class
    FROM event e
    LEFT JOIN LATERAL (
      SELECT
        ${localizedNameSql("fa", isRu)} AS fighter_a_name,
        ${localizedNameSql("fb", isRu)} AS fighter_b_name,
        b.weight_class::text AS weight_class
      FROM bout b
      JOIN fighter fa ON fa.id = b.fighter_a_id
      JOIN fighter fb ON fb.id = b.fighter_b_id
      WHERE b.event_id = e.id AND b.is_main_event = TRUE
      LIMIT 1
    ) me ON TRUE
    WHERE e.status IN ('upcoming', 'in_progress')
      AND e.date >= NOW() - INTERVAL '1 day'
    ORDER BY e.date ASC
    LIMIT 1
  `)) as unknown as UpcomingEventSidebar[];
  return rows[0] ?? null;
}
