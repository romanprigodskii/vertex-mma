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
 * Profit and volume are computed from the `bet` table — NOT from the
 * cached `total_coins_earned − total_coins_lost`, which inflates by
 * the 10,000 starting bonus baked into total_coins_earned's default.
 *
 *   profit       — realized P/L: SUM(payout − coins_spent) over settled
 *                   bets, descending. Only users with at least one bet
 *                   qualify (system credits alone don't put a user on
 *                   the board).
 *   volume       — SUM(coins_spent) across all bets, descending. Same
 *                   activity filter.
 *   achievements — unlocked-achievement count descending. Independent
 *                   of betting activity.
 *
 * Branches are inlined as three separate queries so each can keep an
 * order/filter the planner can reason about (a single dynamic
 * `${orderClause}` pattern fights the prepared-statement cache).
 */
export async function getLeaderboard(
  sort: LeaderboardSort,
  limit = 100,
): Promise<LeaderboardRow[]> {
  // Per-user betting activity from the bet table. `profit` is realized
  // only — unsettled bets neither help nor hurt. `volume` counts all
  // coins committed regardless of resolution.
  const userStats = sql`
    SELECT
      bt.user_id,
      COUNT(*)::int AS bet_count,
      COALESCE(SUM(bt.coins_spent), 0)::int AS volume,
      COALESCE(
        SUM(COALESCE(bt.payout, 0) - bt.coins_spent)
          FILTER (WHERE bt.resolved_at IS NOT NULL),
        0
      )::int AS profit
    FROM bet bt
    GROUP BY bt.user_id
  `;

  let rows;
  if (sort === "volume") {
    rows = await db.execute<LeaderboardRow>(sql`
      WITH us AS (${userStats})
      SELECT
        ROW_NUMBER() OVER (ORDER BY us.volume DESC)::int AS rank,
        up.id::text AS user_id,
        up.username,
        up.display_name,
        up.avatar_url,
        up.tier::text AS tier,
        up.balance_coins AS balance,
        us.profit,
        us.volume AS total_lost,
        us.bet_count,
        (SELECT COUNT(*)::int FROM user_achievement WHERE user_id = up.id) AS achievement_count
      FROM user_profile up
      INNER JOIN us ON us.user_id = up.id
      WHERE us.bet_count > 0
      ORDER BY us.volume DESC
      LIMIT ${limit}
    `);
  } else if (sort === "achievements") {
    rows = await db.execute<LeaderboardRow>(sql`
      WITH ach AS (
        SELECT user_id, COUNT(*)::int AS c
        FROM user_achievement
        GROUP BY user_id
      ),
      us AS (${userStats})
      SELECT
        ROW_NUMBER() OVER (ORDER BY COALESCE(ach.c, 0) DESC, COALESCE(us.bet_count, 0) DESC)::int AS rank,
        up.id::text AS user_id,
        up.username,
        up.display_name,
        up.avatar_url,
        up.tier::text AS tier,
        up.balance_coins AS balance,
        COALESCE(us.profit, 0) AS profit,
        COALESCE(us.volume, 0) AS total_lost,
        COALESCE(us.bet_count, 0) AS bet_count,
        COALESCE(ach.c, 0) AS achievement_count
      FROM user_profile up
      LEFT JOIN ach ON ach.user_id = up.id
      LEFT JOIN us ON us.user_id = up.id
      WHERE COALESCE(ach.c, 0) > 0
      ORDER BY COALESCE(ach.c, 0) DESC, COALESCE(us.bet_count, 0) DESC
      LIMIT ${limit}
    `);
  } else {
    rows = await db.execute<LeaderboardRow>(sql`
      WITH us AS (${userStats})
      SELECT
        ROW_NUMBER() OVER (ORDER BY us.profit DESC)::int AS rank,
        up.id::text AS user_id,
        up.username,
        up.display_name,
        up.avatar_url,
        up.tier::text AS tier,
        up.balance_coins AS balance,
        us.profit,
        us.volume AS total_lost,
        us.bet_count,
        (SELECT COUNT(*)::int FROM user_achievement WHERE user_id = up.id) AS achievement_count
      FROM user_profile up
      INNER JOIN us ON us.user_id = up.id
      WHERE us.bet_count > 0
      ORDER BY us.profit DESC
      LIMIT ${limit}
    `);
  }
  return rows as unknown as LeaderboardRow[];
}
