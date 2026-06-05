import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export type LeaderboardSort = "profit" | "volume" | "achievements";

export type LeaderboardRow = {
  rank: number;
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  tier: string;
  balance: number;
  profit: number;
  total_lost: number;
  bet_count: number;
  achievement_count: number;
};

/**
 * Pulls top N for the requested sort.
 *
 *   profit       — net (total_coins_earned − total_coins_lost), descending.
 *                   Hides accounts that never engaged (no bets and untouched
 *                   default balance of 10,000) so the board doesn't fill
 *                   with zero-activity profiles.
 *   volume       — total_coins_lost descending. Same activity filter as
 *                   profit since high-volume players will have moved money.
 *   achievements — unlocked-achievement count descending. No activity
 *                   filter — any user with at least one achievement
 *                   qualifies (and the descending sort hides empties).
 *
 * Branches are inlined as three separate queries so each can keep an
 * order/filter the planner can reason about (a single dynamic
 * `${orderClause}` pattern fights the prepared-statement cache).
 */
export async function getLeaderboard(
  sort: LeaderboardSort,
  limit = 100,
): Promise<LeaderboardRow[]> {
  let rows;
  if (sort === "volume") {
    rows = await db.execute<LeaderboardRow>(sql`
      SELECT
        ROW_NUMBER() OVER (ORDER BY up.total_coins_lost DESC)::int AS rank,
        up.id::text AS user_id,
        up.username,
        up.display_name,
        up.avatar_url,
        up.tier::text AS tier,
        up.balance_coins::float8 AS balance,
        (up.total_coins_earned - up.total_coins_lost)::float8 AS profit,
        up.total_coins_lost::float8 AS total_lost,
        up.bet_count::float8 AS bet_count,
        (SELECT COUNT(*)::int FROM user_achievement WHERE user_id = up.id) AS achievement_count
      FROM user_profile up
      WHERE up.bet_count > 0 OR up.balance_coins <> 10000
      ORDER BY up.total_coins_lost DESC
      LIMIT ${limit}
    `);
  } else if (sort === "achievements") {
    rows = await db.execute<LeaderboardRow>(sql`
      WITH ach AS (
        SELECT user_id, COUNT(*)::int AS c
        FROM user_achievement
        GROUP BY user_id
      )
      SELECT
        ROW_NUMBER() OVER (ORDER BY COALESCE(ach.c, 0) DESC, up.bet_count DESC)::int AS rank,
        up.id::text AS user_id,
        up.username,
        up.display_name,
        up.avatar_url,
        up.tier::text AS tier,
        up.balance_coins::float8 AS balance,
        (up.total_coins_earned - up.total_coins_lost)::float8 AS profit,
        up.total_coins_lost::float8 AS total_lost,
        up.bet_count::float8 AS bet_count,
        COALESCE(ach.c, 0) AS achievement_count
      FROM user_profile up
      LEFT JOIN ach ON ach.user_id = up.id
      WHERE COALESCE(ach.c, 0) > 0
      ORDER BY COALESCE(ach.c, 0) DESC, up.bet_count DESC
      LIMIT ${limit}
    `);
  } else {
    rows = await db.execute<LeaderboardRow>(sql`
      SELECT
        ROW_NUMBER() OVER (ORDER BY (up.total_coins_earned - up.total_coins_lost) DESC)::int AS rank,
        up.id::text AS user_id,
        up.username,
        up.display_name,
        up.avatar_url,
        up.tier::text AS tier,
        up.balance_coins::float8 AS balance,
        (up.total_coins_earned - up.total_coins_lost)::float8 AS profit,
        up.total_coins_lost::float8 AS total_lost,
        up.bet_count::float8 AS bet_count,
        (SELECT COUNT(*)::int FROM user_achievement WHERE user_id = up.id) AS achievement_count
      FROM user_profile up
      WHERE up.bet_count > 0 OR up.balance_coins <> 10000
      ORDER BY (up.total_coins_earned - up.total_coins_lost) DESC
      LIMIT ${limit}
    `);
  }
  return rows as unknown as LeaderboardRow[];
}
