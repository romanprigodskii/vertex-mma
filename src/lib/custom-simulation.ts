import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { isRuLocale, localizedNameSql } from "@/lib/i18n-name";

/**
 * Custom "dream fight" simulations — read layer over the custom_simulation
 * queue (Wave 62). Requests are INSERTed by the server action in
 * src/app/[locale]/simulation/actions.ts; the Python worker
 * (scripts/simulation/scripts/run_custom.py) scores them and fills
 * `result` jsonb. Shape of `result` is defined by
 * scripts/simulation/src/custom.py score_pair() — keep in sync.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CustomSimStatus = "pending" | "done" | "failed";

export type CustomSimSide = {
  fighter_id: string;
  slug: string;
  name_en: string;
  name_ru: string | null;
  photo_thumbnail_url: string | null;
  as_of_bout_id: string | null;
  as_of_date: string;
  record: string;
  age: number | null;
  weight_class: string | null;
  vertex_score: number | null;
  vertex_score_all_time: number | null;
  slpm: number | null;
  td_per15: number | null;
  sub_per15: number | null;
  kd_per_fight: number | null;
  current_streak: number | null;
};

export type CustomSimResult = {
  prob_a: number;
  prob_b: number;
  mc: {
    n: number;
    prob_ko_a: number;
    prob_ko_b: number;
    prob_sub_a: number;
    prob_sub_b: number;
    prob_decision_a: number;
    prob_decision_b: number;
    avg_finish_seconds: number | null;
    finish_round: Record<string, number | null>;
  };
  context: {
    weight_class: string;
    scheduled_rounds: number;
    gender: string;
  };
  a: CustomSimSide;
  b: CustomSimSide;
};

export type CustomSimulation = {
  id: string;
  user_profile_id: string | null;
  fighter_a_id: string;
  fighter_b_id: string;
  as_of_bout_a_id: string | null;
  as_of_bout_b_id: string | null;
  status: CustomSimStatus;
  model_version: string | null;
  result: CustomSimResult | null;
  error: string | null;
  requested_at: string;
  completed_at: string | null;
  /** Localized display names resolved at read time (result payload may be
   *  missing while pending). */
  fighter_a_name: string;
  fighter_b_name: string;
  fighter_a_slug: string;
  fighter_b_slug: string;
};

export async function getCustomSimulation(
  id: string,
): Promise<CustomSimulation | null> {
  if (!UUID_RE.test(id)) return null;
  const isRu = await isRuLocale();
  const rows = await db.execute<CustomSimulation>(sql`
    SELECT
      cs.id::text AS id,
      cs.user_profile_id::text AS user_profile_id,
      cs.fighter_a_id::text AS fighter_a_id,
      cs.fighter_b_id::text AS fighter_b_id,
      cs.as_of_bout_a_id::text AS as_of_bout_a_id,
      cs.as_of_bout_b_id::text AS as_of_bout_b_id,
      cs.status,
      cs.model_version,
      cs.result,
      cs.error,
      cs.requested_at::text AS requested_at,
      cs.completed_at::text AS completed_at,
      ${localizedNameSql("fa", isRu)} AS fighter_a_name,
      ${localizedNameSql("fb", isRu)} AS fighter_b_name,
      fa.slug AS fighter_a_slug,
      fb.slug AS fighter_b_slug
    FROM custom_simulation cs
    JOIN fighter fa ON fa.id = cs.fighter_a_id
    JOIN fighter fb ON fb.id = cs.fighter_b_id
    WHERE cs.id = ${id}::uuid
    LIMIT 1
  `);
  return (rows as unknown as CustomSimulation[])[0] ?? null;
}

export type CustomSimListItem = {
  id: string;
  status: CustomSimStatus;
  requested_at: string;
  fighter_a_name: string;
  fighter_b_name: string;
  prob_a: number | null;
};

export async function listMyCustomSimulations(
  userProfileId: string,
  limit = 12,
): Promise<CustomSimListItem[]> {
  if (!UUID_RE.test(userProfileId)) return [];
  const isRu = await isRuLocale();
  const rows = await db.execute<CustomSimListItem>(sql`
    SELECT
      cs.id::text AS id,
      cs.status,
      cs.requested_at::text AS requested_at,
      ${localizedNameSql("fa", isRu)} AS fighter_a_name,
      ${localizedNameSql("fb", isRu)} AS fighter_b_name,
      (cs.result ->> 'prob_a')::float8 AS prob_a
    FROM custom_simulation cs
    JOIN fighter fa ON fa.id = cs.fighter_a_id
    JOIN fighter fb ON fb.id = cs.fighter_b_id
    WHERE cs.user_profile_id = ${userProfileId}::uuid
    ORDER BY cs.requested_at DESC
    LIMIT ${limit}
  `);
  return rows as unknown as CustomSimListItem[];
}

/** Same matchup + same form anchors already scored under any model version
 *  → reuse instead of re-queueing (checked in BOTH fighter orders). */
export async function findCachedCustomSimulation(
  fighterAId: string,
  asOfBoutAId: string | null,
  fighterBId: string,
  asOfBoutBId: string | null,
): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id
    FROM custom_simulation
    WHERE status = 'done'
      AND (
        (fighter_a_id = ${fighterAId}::uuid
          AND fighter_b_id = ${fighterBId}::uuid
          AND as_of_bout_a_id IS NOT DISTINCT FROM ${asOfBoutAId}::uuid
          AND as_of_bout_b_id IS NOT DISTINCT FROM ${asOfBoutBId}::uuid)
        OR
        (fighter_a_id = ${fighterBId}::uuid
          AND fighter_b_id = ${fighterAId}::uuid
          AND as_of_bout_a_id IS NOT DISTINCT FROM ${asOfBoutBId}::uuid
          AND as_of_bout_b_id IS NOT DISTINCT FROM ${asOfBoutAId}::uuid)
      )
    ORDER BY completed_at DESC
    LIMIT 1
  `);
  return (rows as unknown as { id: string }[])[0]?.id ?? null;
}

export type FormPickerBout = {
  bout_id: string;
  date: string;
  event_name: string;
  opponent_name: string;
  result: "W" | "L" | "D";
  method: string | null;
  weight_class: string;
};

/** A fighter's completed UFC bouts, newest first — the "take form from this
 *  bout" picker. Result letter is from THIS fighter's perspective. */
export async function listFighterBoutsForPicker(
  fighterId: string,
): Promise<FormPickerBout[]> {
  if (!UUID_RE.test(fighterId)) return [];
  const isRu = await isRuLocale();
  const rows = await db.execute<FormPickerBout>(sql`
    SELECT
      b.id::text AS bout_id,
      (e.date AT TIME ZONE 'UTC')::date::text AS date,
      COALESCE(e.short_name, e.name) AS event_name,
      ${localizedNameSql("o", isRu)} AS opponent_name,
      CASE
        WHEN b.winner_id = ${fighterId}::uuid THEN 'W'
        WHEN b.winner_id IS NOT NULL THEN 'L'
        ELSE 'D'
      END AS result,
      b.method::text AS method,
      b.weight_class::text AS weight_class
    FROM bout b
    JOIN event e ON e.id = b.event_id
    JOIN fighter o ON o.id = CASE
      WHEN b.fighter_a_id = ${fighterId}::uuid THEN b.fighter_b_id
      ELSE b.fighter_a_id
    END
    WHERE e.promotion = 'ufc'
      AND b.status = 'completed'
      AND (b.fighter_a_id = ${fighterId}::uuid OR b.fighter_b_id = ${fighterId}::uuid)
      AND b.method IS DISTINCT FROM 'no_contest'
    ORDER BY e.date DESC
  `);
  return rows as unknown as FormPickerBout[];
}
