import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export type AchievementRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon_url: string | null;
  reward_coins: number;
  rarity: string;
};

export type UserAchievementRow = AchievementRow & {
  unlocked_at: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RARITY_ORDER: Record<string, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
};

export async function listAchievements(): Promise<AchievementRow[]> {
  const rows = await db.execute<AchievementRow>(sql`
    SELECT
      id::text AS id,
      slug,
      name,
      description,
      icon_url,
      reward_coins,
      rarity
    FROM achievement
    ORDER BY rarity, slug
  `);
  const arr = rows as unknown as AchievementRow[];
  // Cast to a stable rarity ordering so common < uncommon < rare regardless
  // of locale collation on the raw enum/text column.
  return [...arr].sort((a, b) => {
    const ra = RARITY_ORDER[a.rarity] ?? 99;
    const rb = RARITY_ORDER[b.rarity] ?? 99;
    if (ra !== rb) return ra - rb;
    return a.slug.localeCompare(b.slug);
  });
}

export async function listUserAchievements(
  userProfileId: string,
): Promise<UserAchievementRow[]> {
  if (!UUID_RE.test(userProfileId)) return [];
  const rows = await db.execute<UserAchievementRow>(sql`
    SELECT
      a.id::text AS id,
      a.slug,
      a.name,
      a.description,
      a.icon_url,
      a.reward_coins,
      a.rarity,
      ua.unlocked_at::text AS unlocked_at
    FROM user_achievement ua
    JOIN achievement a ON a.id = ua.achievement_id
    WHERE ua.user_id = ${userProfileId}::uuid
    ORDER BY ua.unlocked_at DESC
  `);
  return rows as unknown as UserAchievementRow[];
}

/**
 * Idempotent unlock. The PL/pgSQL helper handles the unique-violation
 * conflict and only writes the bonus transaction on a fresh insert.
 */
export async function unlockAchievement(
  userProfileId: string,
  slug: string,
): Promise<boolean> {
  if (!UUID_RE.test(userProfileId)) return false;
  const rows = await db.execute<{ unlocked: boolean }>(sql`
    SELECT public.unlock_achievement(${userProfileId}::uuid, ${slug}) AS unlocked
  `);
  return (rows as unknown as Array<{ unlocked: boolean }>)[0]?.unlocked === true;
}

/**
 * Re-evaluate every achievement against the user's current state and
 * unlock anything newly eligible. Call after any action that could move
 * the needle: bet placed, ranking created, profile updated, daily bonus
 * claimed, bet settled.
 *
 * Returns the slugs of NEWLY unlocked achievements (empty array on no
 * change). All checks are idempotent; calling repeatedly is cheap.
 */
export async function checkAndUnlockAchievements(
  userProfileId: string,
): Promise<string[]> {
  if (!UUID_RE.test(userProfileId)) return [];

  const profileRows = await db.execute<{
    balance: number;
    bet_count: number;
    display_name: string | null;
    bio: string | null;
    country_code: string | null;
    avatar_url: string | null;
  }>(sql`
    SELECT
      balance_coins::float8 AS balance,
      bet_count::float8 AS bet_count,
      display_name,
      bio,
      country_code,
      avatar_url
    FROM user_profile
    WHERE id = ${userProfileId}::uuid
    LIMIT 1
  `);
  const profile = (
    profileRows as unknown as Array<{
      balance: number;
      bet_count: number;
      display_name: string | null;
      bio: string | null;
      country_code: string | null;
      avatar_url: string | null;
    }>
  )[0];
  if (!profile) return [];

  // Aggregate stats in parallel — each is a cheap COUNT against indexed
  // foreign keys.
  // Win-based achievements count ALL bet products: the LMSR prediction
  // market (`bet`), the fixed-odds sportsbook (`fixed_odds_bet`), and parlays
  // (`parlay`). Counting only `bet` would have shut sportsbook-only bettors
  // out of bet_10_wins / big_win.
  type SbAgg = { won: number; big: number; underdog: number };
  const [
    winRows,
    rankingRows,
    bigWinRows,
    dailyStreakRows,
    sbWinRows,
    parlayWinRows,
  ] = await Promise.all([
    db.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM bet
      WHERE user_id = ${userProfileId}::uuid
        AND payout > 0
        AND resolved_at IS NOT NULL
    `),
    db.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM custom_ranking
      WHERE user_id = ${userProfileId}::uuid
    `),
    db.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM bet
      WHERE user_id = ${userProfileId}::uuid
        AND payout >= 5000
    `),
    db.execute<{ days: number }>(sql`
      SELECT COUNT(DISTINCT DATE_TRUNC('day', created_at AT TIME ZONE 'UTC'))::int AS days
      FROM transaction
      WHERE user_id = ${userProfileId}::uuid
        AND type = 'daily_bonus'
        AND created_at > NOW() - INTERVAL '8 days'
    `),
    db.execute<SbAgg>(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'won')::int AS won,
        COUNT(*) FILTER (WHERE payout >= 5000)::int AS big,
        COUNT(*) FILTER (WHERE status = 'won' AND decimal_odds >= 3.0)::int AS underdog
      FROM fixed_odds_bet WHERE user_id = ${userProfileId}::uuid
    `),
    db.execute<SbAgg>(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'won')::int AS won,
        COUNT(*) FILTER (WHERE payout >= 5000)::int AS big,
        COUNT(*) FILTER (WHERE status = 'won' AND combined_odds >= 3.0)::int AS underdog
      FROM parlay WHERE user_id = ${userProfileId}::uuid
    `),
  ]);

  const lmsrWins = (winRows as unknown as Array<{ c: number }>)[0]?.c ?? 0;
  const rankingCount =
    (rankingRows as unknown as Array<{ c: number }>)[0]?.c ?? 0;
  const lmsrBig = (bigWinRows as unknown as Array<{ c: number }>)[0]?.c ?? 0;
  const dailyStreakDays =
    (dailyStreakRows as unknown as Array<{ days: number }>)[0]?.days ?? 0;
  const sb = (sbWinRows as unknown as SbAgg[])[0] ?? {
    won: 0,
    big: 0,
    underdog: 0,
  };
  const pl = (parlayWinRows as unknown as SbAgg[])[0] ?? {
    won: 0,
    big: 0,
    underdog: 0,
  };

  const winCount = lmsrWins + sb.won + pl.won;
  const bigWinCount = lmsrBig + sb.big + pl.big;
  const parlayWinCount = pl.won;
  const underdogWinCount = sb.underdog + pl.underdog;

  const candidates: Array<{ slug: string; condition: boolean }> = [
    { slug: "first_bet", condition: profile.bet_count >= 1 },
    { slug: "bet_10_wins", condition: winCount >= 10 },
    { slug: "first_ranking", condition: rankingCount >= 1 },
    {
      slug: "profile_complete",
      condition: !!(
        profile.display_name &&
        profile.bio &&
        profile.country_code &&
        profile.avatar_url
      ),
    },
    { slug: "daily_streak_7", condition: dailyStreakDays >= 7 },
    { slug: "balance_50k", condition: profile.balance >= 50_000 },
    { slug: "balance_100k", condition: profile.balance >= 100_000 },
    { slug: "big_win", condition: bigWinCount >= 1 },
    { slug: "parlay_win", condition: parlayWinCount >= 1 },
    { slug: "underdog_win", condition: underdogWinCount >= 1 },
  ];

  const newly: string[] = [];
  for (const c of candidates) {
    if (!c.condition) continue;
    const unlocked = await unlockAchievement(userProfileId, c.slug);
    if (unlocked) newly.push(c.slug);
  }
  return newly;
}
