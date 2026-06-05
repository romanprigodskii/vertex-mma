/**
 * Vertex Sportsbook — read layer.
 *
 * Pure odds/settlement math lives in src/lib/sportsbook.ts (unit-tested,
 * DB-free). Bet PLACEMENT is a server action (src/app/[locale]/markets/
 * actions.ts, reads the Supabase session). Bet SETTLEMENT runs in the cron
 * script scripts/settle_fixed_odds.ts (raw postgres + the pure
 * `settleSelection` grader). This module is just the history read for
 * /me/bets and the profile.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  isRuLocale,
  localizedEventNameSql,
  localizedNameSql,
} from "@/lib/i18n-name";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MyFixedOddsBetRow = {
  bet_id: string;
  bout_id: string;
  market_kind: string;
  selection_code: string;
  stake_coins: number;
  decimal_odds: number;
  potential_payout: number;
  status: string;
  payout: number | null;
  created_at: string;
  settled_at: string | null;
  fighter_a_name: string;
  fighter_a_slug: string;
  fighter_b_name: string;
  fighter_b_slug: string;
  event_name: string;
  event_slug: string;
  event_date: string;
};

export type PublicParlayLeg = {
  selection_code: string;
  decimal_odds: number;
  status: string;
  fighter_a_name: string;
  fighter_a_slug: string;
  fighter_b_name: string;
  fighter_b_slug: string;
  event_name: string;
  event_slug: string;
  event_date: string;
};

export type PublicParlay = {
  id: string;
  stake_coins: number;
  combined_odds: number;
  potential_payout: number;
  num_legs: number;
  status: string;
  payout: number | null;
  created_at: string;
  settled_at: string | null;
  /** Bettor's PUBLIC profile only — never balance / private fields. */
  bettor_username: string;
  bettor_display_name: string | null;
  bettor_avatar_url: string | null;
  legs: PublicParlayLeg[];
};

/**
 * Public, by-id view of a parlay for the shareable /parlay/[id] page + OG
 * image. Exposes only the picks, odds, stake/payout, status, and the bettor's
 * public profile — no balance or other private data. Null when not found.
 */
export async function getParlayById(id: string): Promise<PublicParlay | null> {
  if (!UUID_RE.test(id)) return null;
  const isRu = await isRuLocale();
  const headRows = (await db.execute<{
    id: string;
    stake_coins: number;
    combined_odds: number;
    potential_payout: number;
    num_legs: number;
    status: string;
    payout: number | null;
    created_at: string;
    settled_at: string | null;
    bettor_username: string;
    bettor_display_name: string | null;
    bettor_avatar_url: string | null;
  }>(sql`
    SELECT
      p.id::text AS id,
      p.stake_coins,
      p.combined_odds::float AS combined_odds,
      p.potential_payout,
      p.num_legs,
      p.status::text AS status,
      p.payout,
      p.created_at::text AS created_at,
      p.settled_at::text AS settled_at,
      up.username AS bettor_username,
      up.display_name AS bettor_display_name,
      up.avatar_url AS bettor_avatar_url
    FROM parlay p
    JOIN user_profile up ON up.id = p.user_id
    WHERE p.id = ${id}::uuid
    LIMIT 1
  `)) as unknown as Array<PublicParlay>;
  const head = headRows[0];
  if (!head) return null;

  const legRows = (await db.execute<PublicParlayLeg>(sql`
    SELECT
      pl.selection_code AS selection_code,
      pl.decimal_odds::float AS decimal_odds,
      pl.status::text AS status,
      ${localizedNameSql("fa", isRu)} AS fighter_a_name,
      fa.slug AS fighter_a_slug,
      ${localizedNameSql("fb", isRu)} AS fighter_b_name,
      fb.slug AS fighter_b_slug,
      ${localizedEventNameSql("e", isRu)} AS event_name,
      e.slug AS event_slug,
      e.date::text AS event_date
    FROM parlay_leg pl
    JOIN bout bo ON bo.id = pl.bout_id
    JOIN event e ON e.id = bo.event_id
    JOIN fighter fa ON fa.id = bo.fighter_a_id
    JOIN fighter fb ON fb.id = bo.fighter_b_id
    WHERE pl.parlay_id = ${id}::uuid
    ORDER BY pl.created_at ASC
  `)) as unknown as PublicParlayLeg[];

  return { ...head, legs: legRows };
}

export type MyParlayLeg = {
  bout_id: string;
  selection_code: string;
  decimal_odds: number;
  status: string;
  fighter_a_name: string;
  fighter_b_name: string;
};

export type MyParlayRow = {
  parlay_id: string;
  stake_coins: number;
  combined_odds: number;
  potential_payout: number;
  num_legs: number;
  status: string;
  payout: number | null;
  created_at: string;
  legs: MyParlayLeg[];
};

/** A user's parlays (with legs), newest first. */
export async function listMyParlays(
  userProfileId: string,
  limit = 100,
): Promise<MyParlayRow[]> {
  if (!UUID_RE.test(userProfileId)) return [];
  const isRu = await isRuLocale();
  const parlays = (await db.execute<{
    parlay_id: string;
    stake_coins: number;
    combined_odds: number;
    potential_payout: number;
    num_legs: number;
    status: string;
    payout: number | null;
    created_at: string;
  }>(sql`
    SELECT id::text AS parlay_id, stake_coins, combined_odds::float AS combined_odds,
           potential_payout, num_legs, status::text AS status, payout,
           created_at::text AS created_at
    FROM parlay WHERE user_id = ${userProfileId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `)) as unknown as Array<{
    parlay_id: string;
    stake_coins: number;
    combined_odds: number;
    potential_payout: number;
    num_legs: number;
    status: string;
    payout: number | null;
    created_at: string;
  }>;
  if (parlays.length === 0) return [];

  // Fetch legs only for the (capped) page of parlays we just loaded, not for
  // every parlay the user has ever placed — the old `WHERE p.user_id = …`
  // join walked the user's entire parlay history through a 6-table join.
  const parlayIds = sql.join(
    parlays.map((p) => sql`${p.parlay_id}::uuid`),
    sql`, `,
  );
  const legRows = (await db.execute<MyParlayLeg & { parlay_id: string }>(sql`
    SELECT pl.parlay_id::text AS parlay_id,
           pl.bout_id::text AS bout_id,
           pl.selection_code AS selection_code,
           pl.decimal_odds::float AS decimal_odds,
           pl.status::text AS status,
           ${localizedNameSql("fa", isRu)} AS fighter_a_name,
           ${localizedNameSql("fb", isRu)} AS fighter_b_name
    FROM parlay_leg pl
    JOIN bout bo ON bo.id = pl.bout_id
    JOIN fighter fa ON fa.id = bo.fighter_a_id
    JOIN fighter fb ON fb.id = bo.fighter_b_id
    WHERE pl.parlay_id IN (${parlayIds})
    ORDER BY pl.created_at ASC
  `)) as unknown as Array<MyParlayLeg & { parlay_id: string }>;

  const byParlay = new Map<string, MyParlayLeg[]>();
  for (const r of legRows) {
    const list = byParlay.get(r.parlay_id) ?? [];
    list.push({
      bout_id: r.bout_id,
      selection_code: r.selection_code,
      decimal_odds: r.decimal_odds,
      status: r.status,
      fighter_a_name: r.fighter_a_name,
      fighter_b_name: r.fighter_b_name,
    });
    byParlay.set(r.parlay_id, list);
  }
  return parlays.map((p) => ({ ...p, legs: byParlay.get(p.parlay_id) ?? [] }));
}

/** A user's fixed-odds bet history, newest first. */
export async function listMyFixedOddsBets(
  userProfileId: string,
  limit = 100,
): Promise<MyFixedOddsBetRow[]> {
  if (!UUID_RE.test(userProfileId)) return [];
  const isRu = await isRuLocale();
  const rows = await db.execute<MyFixedOddsBetRow>(sql`
    SELECT
      fb.id::text AS bet_id,
      fb.bout_id::text AS bout_id,
      fb.market_kind::text AS market_kind,
      fb.selection_code AS selection_code,
      fb.stake_coins,
      fb.decimal_odds::float AS decimal_odds,
      fb.potential_payout,
      fb.status::text AS status,
      fb.payout,
      fb.created_at::text AS created_at,
      fb.settled_at::text AS settled_at,
      ${localizedNameSql("fa", isRu)} AS fighter_a_name,
      fa.slug AS fighter_a_slug,
      ${localizedNameSql("fb2", isRu)} AS fighter_b_name,
      fb2.slug AS fighter_b_slug,
      ${localizedEventNameSql("e", isRu)} AS event_name,
      e.slug AS event_slug,
      e.date::text AS event_date
    FROM fixed_odds_bet fb
    JOIN bout bo ON bo.id = fb.bout_id
    JOIN event e ON e.id = bo.event_id
    JOIN fighter fa ON fa.id = bo.fighter_a_id
    JOIN fighter fb2 ON fb2.id = bo.fighter_b_id
    WHERE fb.user_id = ${userProfileId}::uuid
    ORDER BY fb.created_at DESC
    LIMIT ${limit}
  `);
  return rows as unknown as MyFixedOddsBetRow[];
}
