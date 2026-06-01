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

/** A user's fixed-odds bet history, newest first. */
export async function listMyFixedOddsBets(
  userProfileId: string,
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
  `);
  return rows as unknown as MyFixedOddsBetRow[];
}
