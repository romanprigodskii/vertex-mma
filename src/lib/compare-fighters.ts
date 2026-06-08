import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { isRuLocale, localizedEventNameSql, localizedNameSql } from "@/lib/i18n-name";

export type CommonOpponentBout = {
  event_name: string;
  event_slug: string;
  event_date: string; // ISO timestamp
  result: "W" | "L" | "D" | "NC";
  method: string | null;
  round_finished: number | null;
  time_finished_seconds: number | null;
};

export type CommonOpponentEntry = {
  opponent_slug: string;
  opponent_name: string;
  opponent_nickname: string | null;
  /** Most recent bout fighter A had with this opponent. */
  a_bout: CommonOpponentBout;
  /** Most recent bout fighter B had with this opponent. */
  b_bout: CommonOpponentBout;
};

type RawRow = {
  opponent_slug: string;
  opponent_name: string;
  opponent_nickname: string | null;
  a_event_name: string;
  a_event_slug: string;
  a_event_date: string;
  a_result: CommonOpponentBout["result"];
  a_method: string | null;
  a_round_finished: number | null;
  a_time_finished_seconds: number | null;
  b_event_name: string;
  b_event_slug: string;
  b_event_date: string;
  b_result: CommonOpponentBout["result"];
  b_method: string | null;
  b_round_finished: number | null;
  b_time_finished_seconds: number | null;
};

/**
 * Find UFC opponents that BOTH fighters have faced. Returns the most-recent
 * bout against each shared opponent from each fighter's perspective.
 *
 * When either fighter has fought the same opponent multiple times we keep
 * only the most recent meeting (`DISTINCT ON (opp_id) ... ORDER BY date DESC`).
 * Skipping older rematches keeps the UI simple — the most recent meeting is
 * almost always the one fans want to see compared.
 */
export async function getCommonOpponents(
  fighterAId: string,
  fighterBId: string,
): Promise<CommonOpponentEntry[]> {
  if (fighterAId === fighterBId) return [];

  const isRu = await isRuLocale();
  const result = await db.execute<RawRow>(sql`
    WITH a_latest AS (
      SELECT DISTINCT ON (opp_id)
        opp_id,
        bout_id,
        event_name,
        event_slug,
        event_date,
        result,
        method,
        round_finished,
        time_finished_seconds
      FROM (
        SELECT
          CASE WHEN b.fighter_a_id = ${fighterAId}::uuid THEN b.fighter_b_id ELSE b.fighter_a_id END AS opp_id,
          b.id AS bout_id,
          ${localizedEventNameSql("e", isRu)} AS event_name,
          e.slug AS event_slug,
          e.date AS event_date,
          CASE
            WHEN b.method::text = 'no_contest' THEN 'NC'
            WHEN b.winner_id = ${fighterAId}::uuid THEN 'W'
            WHEN b.winner_id IS NOT NULL THEN 'L'
            ELSE 'D'
          END AS result,
          b.method::text AS method,
          b.round_finished,
          b.time_finished_seconds
        FROM bout b
        JOIN event e ON e.id = b.event_id
        WHERE (b.fighter_a_id = ${fighterAId}::uuid OR b.fighter_b_id = ${fighterAId}::uuid)
          AND b.status = 'completed'
      ) ranked_a
      ORDER BY opp_id, event_date DESC, bout_id DESC
    ),
    b_latest AS (
      SELECT DISTINCT ON (opp_id)
        opp_id,
        bout_id,
        event_name,
        event_slug,
        event_date,
        result,
        method,
        round_finished,
        time_finished_seconds
      FROM (
        SELECT
          CASE WHEN b.fighter_a_id = ${fighterBId}::uuid THEN b.fighter_b_id ELSE b.fighter_a_id END AS opp_id,
          b.id AS bout_id,
          ${localizedEventNameSql("e", isRu)} AS event_name,
          e.slug AS event_slug,
          e.date AS event_date,
          CASE
            WHEN b.method::text = 'no_contest' THEN 'NC'
            WHEN b.winner_id = ${fighterBId}::uuid THEN 'W'
            WHEN b.winner_id IS NOT NULL THEN 'L'
            ELSE 'D'
          END AS result,
          b.method::text AS method,
          b.round_finished,
          b.time_finished_seconds
        FROM bout b
        JOIN event e ON e.id = b.event_id
        WHERE (b.fighter_a_id = ${fighterBId}::uuid OR b.fighter_b_id = ${fighterBId}::uuid)
          AND b.status = 'completed'
      ) ranked_b
      ORDER BY opp_id, event_date DESC, bout_id DESC
    )
    SELECT
      f.slug AS opponent_slug,
      ${localizedNameSql("f", isRu)} AS opponent_name,
      f.nickname AS opponent_nickname,
      a.event_name AS a_event_name,
      a.event_slug AS a_event_slug,
      a.event_date::text AS a_event_date,
      a.result AS a_result,
      a.method AS a_method,
      a.round_finished AS a_round_finished,
      a.time_finished_seconds AS a_time_finished_seconds,
      b.event_name AS b_event_name,
      b.event_slug AS b_event_slug,
      b.event_date::text AS b_event_date,
      b.result AS b_result,
      b.method AS b_method,
      b.round_finished AS b_round_finished,
      b.time_finished_seconds AS b_time_finished_seconds
    FROM fighter f
    JOIN a_latest a ON a.opp_id = f.id
    JOIN b_latest b ON b.opp_id = f.id
    ORDER BY GREATEST(a.event_date, b.event_date) DESC
  `);

  const rows = result as unknown as RawRow[];
  return rows.map((r) => ({
    opponent_slug: r.opponent_slug,
    opponent_name: r.opponent_name,
    opponent_nickname: r.opponent_nickname,
    a_bout: {
      event_name: r.a_event_name,
      event_slug: r.a_event_slug,
      event_date: r.a_event_date,
      result: r.a_result,
      method: r.a_method,
      round_finished: r.a_round_finished,
      time_finished_seconds: r.a_time_finished_seconds,
    },
    b_bout: {
      event_name: r.b_event_name,
      event_slug: r.b_event_slug,
      event_date: r.b_event_date,
      result: r.b_result,
      method: r.b_method,
      round_finished: r.b_round_finished,
      time_finished_seconds: r.b_time_finished_seconds,
    },
  }));
}

export type HeadToHeadBout = {
  bout_id: string;
  event_name: string;
  event_slug: string;
  event_date: string;
  /** Result from fighter A's perspective. */
  a_result: "W" | "L" | "D" | "NC";
  method: string | null;
  round_finished: number | null;
  time_finished_seconds: number | null;
  is_title_fight: boolean;
};

export async function getHeadToHeadBouts(
  fighterAId: string,
  fighterBId: string,
): Promise<HeadToHeadBout[]> {
  if (fighterAId === fighterBId) return [];

  const isRu = await isRuLocale();
  const result = await db.execute<HeadToHeadBout>(sql`
    SELECT
      b.id::text AS bout_id,
      ${localizedEventNameSql("e", isRu)} AS event_name,
      e.slug AS event_slug,
      e.date::text AS event_date,
      CASE
        WHEN b.method::text = 'no_contest' THEN 'NC'
        WHEN b.winner_id = ${fighterAId}::uuid THEN 'W'
        WHEN b.winner_id = ${fighterBId}::uuid THEN 'L'
        ELSE 'D'
      END AS a_result,
      b.method::text AS method,
      b.round_finished,
      b.time_finished_seconds,
      b.is_title_fight
    FROM bout b
    JOIN event e ON e.id = b.event_id
    WHERE b.status = 'completed'
      AND (
        (b.fighter_a_id = ${fighterAId}::uuid AND b.fighter_b_id = ${fighterBId}::uuid)
        OR (b.fighter_a_id = ${fighterBId}::uuid AND b.fighter_b_id = ${fighterAId}::uuid)
      )
    ORDER BY e.date DESC
  `);
  return [...(result as unknown as HeadToHeadBout[])];
}

export type RecentFormEntry = {
  bout_id: string;
  result: "W" | "L" | "D" | "NC";
  opponent_name: string;
  opponent_slug: string;
  event_date: string;
  method: string | null;
};

export async function getRecentForm(
  fighterId: string,
  limit = 5,
): Promise<RecentFormEntry[]> {
  const isRu = await isRuLocale();
  const result = await db.execute<RecentFormEntry>(sql`
    SELECT
      b.id::text AS bout_id,
      CASE
        WHEN b.method::text = 'no_contest' THEN 'NC'
        WHEN b.winner_id = ${fighterId}::uuid THEN 'W'
        WHEN b.winner_id IS NOT NULL THEN 'L'
        ELSE 'D'
      END AS result,
      ${localizedNameSql("f_opp", isRu)} AS opponent_name,
      f_opp.slug AS opponent_slug,
      e.date::text AS event_date,
      b.method::text AS method
    FROM bout b
    JOIN event e ON e.id = b.event_id
    JOIN fighter f_opp ON f_opp.id = CASE
      WHEN b.fighter_a_id = ${fighterId}::uuid THEN b.fighter_b_id
      ELSE b.fighter_a_id
    END
    WHERE b.status = 'completed'
      AND (b.fighter_a_id = ${fighterId}::uuid OR b.fighter_b_id = ${fighterId}::uuid)
    -- Break same-date ties by card position, like getFightHistory: b.id is a
    -- UUID (effectively random), which would order two bouts on one date wrong.
    ORDER BY e.date DESC, b.bout_order DESC NULLS LAST, b.id DESC
    LIMIT ${limit}
  `);
  return [...(result as unknown as RecentFormEntry[])];
}
