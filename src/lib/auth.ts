import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { userProfile } from "@/lib/db/schema/users";
import { createClient } from "@/lib/supabase/server";

export type CurrentUser = {
  authUserId: string;
  email: string | null;
  userProfileId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  countryCode: string | null;
  balanceCoins: number;
  tier: string;
  simulationCount: number;
  predictionCount: number;
  betCount: number;
  currentStreak: number;
  bestStreak: number;
  joinedAt: string;
};

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const rows = await db
    .select({
      userProfileId: userProfile.id,
      authUserId: userProfile.authUserId,
      username: userProfile.username,
      displayName: userProfile.displayName,
      avatarUrl: userProfile.avatarUrl,
      bio: userProfile.bio,
      countryCode: userProfile.countryCode,
      balanceCoins: userProfile.balanceCoins,
      tier: userProfile.tier,
      simulationCount: userProfile.simulationCount,
      predictionCount: userProfile.predictionCount,
      betCount: userProfile.betCount,
      currentStreak: userProfile.currentStreak,
      bestStreak: userProfile.bestStreak,
      joinedAt: userProfile.joinedAt,
    })
    .from(userProfile)
    .where(eq(userProfile.authUserId, user.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  return {
    userProfileId: row.userProfileId,
    authUserId: row.authUserId,
    email: user.email ?? null,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    bio: row.bio,
    countryCode: row.countryCode,
    balanceCoins: row.balanceCoins,
    tier: row.tier,
    simulationCount: row.simulationCount,
    predictionCount: row.predictionCount,
    betCount: row.betCount,
    currentStreak: row.currentStreak,
    bestStreak: row.bestStreak,
    joinedAt: row.joinedAt.toISOString(),
  };
}
