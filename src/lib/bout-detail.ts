import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export type BoutDetailFighter = {
  id: string;
  slug: string;
  name_en: string;
  nickname: string | null;
  photo_url: string | null;
  photo_thumbnail_url: string | null;
  country_code: string | null;
};

export type BoutRoundStatsRow = {
  round: number;
  fighter_id: string;
  sig_str_landed: number;
  sig_str_attempted: number;
  sig_str_head_landed: number;
  sig_str_head_attempted: number;
  sig_str_body_landed: number;
  sig_str_body_attempted: number;
  sig_str_legs_landed: number;
  sig_str_legs_attempted: number;
  sig_str_distance_landed: number;
  sig_str_clinch_landed: number;
  sig_str_ground_landed: number;
  total_str_landed: number;
  total_str_attempted: number;
  takedowns_landed: number;
  takedowns_attempted: number;
  sub_attempts: number;
  reversals: number;
  control_time_seconds: number;
  knockdowns: number;
};

export type BoutDetail = {
  id: string;
  event: {
    id: string;
    slug: string;
    name: string;
    short_name: string | null;
    date: string;
    location_city: string | null;
    location_country: string | null;
    venue: string | null;
  };
  fighter_a: BoutDetailFighter;
  fighter_b: BoutDetailFighter;
  weight_class: string;
  is_title_fight: boolean;
  is_main_event: boolean;
  is_co_main_event: boolean;
  scheduled_rounds: number;
  status: string;
  winner_id: string | null;
  method: string | null;
  method_detail: string | null;
  round_finished: number | null;
  time_finished_seconds: number | null;
  rounds: BoutRoundStatsRow[];
};

type BoutHeaderRow = {
  id: string;
  event_id: string;
  event_slug: string;
  event_name: string;
  event_short_name: string | null;
  event_date: string;
  event_location_city: string | null;
  event_location_country: string | null;
  event_venue: string | null;
  fighter_a_id: string;
  fighter_a_slug: string;
  fighter_a_name_en: string;
  fighter_a_nickname: string | null;
  fighter_a_photo_url: string | null;
  fighter_a_photo_thumbnail_url: string | null;
  fighter_a_country_code: string | null;
  fighter_b_id: string;
  fighter_b_slug: string;
  fighter_b_name_en: string;
  fighter_b_nickname: string | null;
  fighter_b_photo_url: string | null;
  fighter_b_photo_thumbnail_url: string | null;
  fighter_b_country_code: string | null;
  weight_class: string;
  is_title_fight: boolean;
  is_main_event: boolean;
  is_co_main_event: boolean;
  scheduled_rounds: number;
  status: string;
  winner_id: string | null;
  method: string | null;
  method_detail: string | null;
  round_finished: number | null;
  time_finished_seconds: number | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getBoutById(id: string): Promise<BoutDetail | null> {
  if (!UUID_RE.test(id)) return null;

  const headerResult = await db.execute<BoutHeaderRow>(sql`
    SELECT
      b.id::text AS id,
      b.event_id::text AS event_id,
      e.slug AS event_slug,
      e.name AS event_name,
      e.short_name AS event_short_name,
      e.date::text AS event_date,
      e.location_city AS event_location_city,
      e.location_country AS event_location_country,
      e.venue AS event_venue,
      fa.id::text AS fighter_a_id,
      fa.slug AS fighter_a_slug,
      fa.name_en AS fighter_a_name_en,
      fa.nickname AS fighter_a_nickname,
      fa.photo_url AS fighter_a_photo_url,
      fa.photo_thumbnail_url AS fighter_a_photo_thumbnail_url,
      fa.country_code AS fighter_a_country_code,
      fb.id::text AS fighter_b_id,
      fb.slug AS fighter_b_slug,
      fb.name_en AS fighter_b_name_en,
      fb.nickname AS fighter_b_nickname,
      fb.photo_url AS fighter_b_photo_url,
      fb.photo_thumbnail_url AS fighter_b_photo_thumbnail_url,
      fb.country_code AS fighter_b_country_code,
      b.weight_class::text AS weight_class,
      b.is_title_fight,
      b.is_main_event,
      b.is_co_main_event,
      b.scheduled_rounds,
      b.status::text AS status,
      b.winner_id::text AS winner_id,
      b.method::text AS method,
      b.method_detail,
      b.round_finished,
      b.time_finished_seconds
    FROM bout b
    JOIN event e ON e.id = b.event_id
    JOIN fighter fa ON fa.id = b.fighter_a_id
    JOIN fighter fb ON fb.id = b.fighter_b_id
    WHERE b.id = ${id}::uuid
    LIMIT 1
  `);
  const headerRows = headerResult as unknown as BoutHeaderRow[];
  if (headerRows.length === 0) return null;
  const r = headerRows[0];

  const roundsResult = await db.execute<BoutRoundStatsRow>(sql`
    SELECT
      brs.round,
      brs.fighter_id::text AS fighter_id,
      brs.sig_str_landed,
      brs.sig_str_attempted,
      brs.sig_str_head_landed,
      brs.sig_str_head_attempted,
      brs.sig_str_body_landed,
      brs.sig_str_body_attempted,
      brs.sig_str_legs_landed,
      brs.sig_str_legs_attempted,
      brs.sig_str_distance_landed,
      brs.sig_str_clinch_landed,
      brs.sig_str_ground_landed,
      brs.total_str_landed,
      brs.total_str_attempted,
      brs.takedowns_landed,
      brs.takedowns_attempted,
      brs.sub_attempts,
      brs.reversals,
      brs.control_time_seconds,
      brs.knockdowns
    FROM bout_round_stats brs
    WHERE brs.bout_id = ${id}::uuid
    ORDER BY brs.round ASC, brs.fighter_id ASC
  `);
  const rounds = [...(roundsResult as unknown as BoutRoundStatsRow[])];

  return {
    id: r.id,
    event: {
      id: r.event_id,
      slug: r.event_slug,
      name: r.event_name,
      short_name: r.event_short_name,
      date: r.event_date,
      location_city: r.event_location_city,
      location_country: r.event_location_country,
      venue: r.event_venue,
    },
    fighter_a: {
      id: r.fighter_a_id,
      slug: r.fighter_a_slug,
      name_en: r.fighter_a_name_en,
      nickname: r.fighter_a_nickname,
      photo_url: r.fighter_a_photo_url,
      photo_thumbnail_url: r.fighter_a_photo_thumbnail_url,
      country_code: r.fighter_a_country_code,
    },
    fighter_b: {
      id: r.fighter_b_id,
      slug: r.fighter_b_slug,
      name_en: r.fighter_b_name_en,
      nickname: r.fighter_b_nickname,
      photo_url: r.fighter_b_photo_url,
      photo_thumbnail_url: r.fighter_b_photo_thumbnail_url,
      country_code: r.fighter_b_country_code,
    },
    weight_class: r.weight_class,
    is_title_fight: r.is_title_fight,
    is_main_event: r.is_main_event,
    is_co_main_event: r.is_co_main_event,
    scheduled_rounds: r.scheduled_rounds,
    status: r.status,
    winner_id: r.winner_id,
    method: r.method,
    method_detail: r.method_detail,
    round_finished: r.round_finished,
    time_finished_seconds: r.time_finished_seconds,
    rounds,
  };
}

export type RoundPair = {
  round: number;
  a: BoutRoundStatsRow | null;
  b: BoutRoundStatsRow | null;
};

export function groupRoundsByNumber(
  rounds: BoutRoundStatsRow[],
  fighterAId: string,
  fighterBId: string,
): RoundPair[] {
  const map = new Map<number, { a: BoutRoundStatsRow | null; b: BoutRoundStatsRow | null }>();
  for (const r of rounds) {
    const entry = map.get(r.round) ?? { a: null, b: null };
    if (r.fighter_id === fighterAId) entry.a = r;
    else if (r.fighter_id === fighterBId) entry.b = r;
    map.set(r.round, entry);
  }
  return Array.from(map.entries())
    .sort(([x], [y]) => x - y)
    .map(([round, fighters]) => ({ round, ...fighters }));
}

const NUMERIC_FIELDS: ReadonlyArray<Exclude<keyof BoutRoundStatsRow, "round" | "fighter_id">> = [
  "sig_str_landed",
  "sig_str_attempted",
  "sig_str_head_landed",
  "sig_str_head_attempted",
  "sig_str_body_landed",
  "sig_str_body_attempted",
  "sig_str_legs_landed",
  "sig_str_legs_attempted",
  "sig_str_distance_landed",
  "sig_str_clinch_landed",
  "sig_str_ground_landed",
  "total_str_landed",
  "total_str_attempted",
  "takedowns_landed",
  "takedowns_attempted",
  "sub_attempts",
  "reversals",
  "control_time_seconds",
  "knockdowns",
];

export function sumFighterRounds(
  rounds: BoutRoundStatsRow[],
  fighterId: string,
): BoutRoundStatsRow | null {
  const subset = rounds.filter((r) => r.fighter_id === fighterId);
  if (subset.length === 0) return null;
  const totals: BoutRoundStatsRow = {
    round: 0,
    fighter_id: fighterId,
    sig_str_landed: 0,
    sig_str_attempted: 0,
    sig_str_head_landed: 0,
    sig_str_head_attempted: 0,
    sig_str_body_landed: 0,
    sig_str_body_attempted: 0,
    sig_str_legs_landed: 0,
    sig_str_legs_attempted: 0,
    sig_str_distance_landed: 0,
    sig_str_clinch_landed: 0,
    sig_str_ground_landed: 0,
    total_str_landed: 0,
    total_str_attempted: 0,
    takedowns_landed: 0,
    takedowns_attempted: 0,
    sub_attempts: 0,
    reversals: 0,
    control_time_seconds: 0,
    knockdowns: 0,
  };
  for (const r of subset) {
    for (const f of NUMERIC_FIELDS) {
      totals[f] = (totals[f] ?? 0) + (r[f] ?? 0);
    }
  }
  return totals;
}
