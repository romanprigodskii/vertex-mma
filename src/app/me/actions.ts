"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { checkAndUnlockAchievements } from "@/lib/achievements";
import { db } from "@/lib/db";
import { userProfile } from "@/lib/db/schema/users";
import { createClient } from "@/lib/supabase/server";
import { dailyBonusAmount } from "@/lib/tier";

const COOLDOWN_HOURS = 20;

export async function claimDailyBonusAction(): Promise<{
  error?: string;
  awarded?: number;
  newlyUnlocked?: string[];
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const profileRows = await db
    .select({
      id: userProfile.id,
      lastDaily: userProfile.lastDailyBonusAt,
      tier: userProfile.tier,
    })
    .from(userProfile)
    .where(eq(userProfile.authUserId, user.id))
    .limit(1);
  const profile = profileRows[0];
  if (!profile) return { error: "Profile not found." };

  if (profile.lastDaily) {
    const lastMs = new Date(profile.lastDaily).getTime();
    const hoursSince = (Date.now() - lastMs) / (1000 * 60 * 60);
    if (hoursSince < COOLDOWN_HOURS) {
      const hoursLeft = Math.ceil(COOLDOWN_HOURS - hoursSince);
      return {
        error: `Try again in ${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}.`,
      };
    }
  }

  // Wave 47: tier drives the daily-bonus amount. The TS-side mapping in
  // src/lib/tier.ts mirrors the PL/pgSQL CASE in check_and_promote_tier.
  const amount = dailyBonusAmount(profile.tier);
  const tierLabel = profile.tier;

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE user_profile
      SET balance_coins = balance_coins + ${amount},
          total_coins_earned = total_coins_earned + ${amount},
          last_daily_bonus_at = NOW()
      WHERE id = ${profile.id}::uuid
    `);
    await tx.execute(sql`
      INSERT INTO transaction (user_id, type, amount, balance_after, description)
      SELECT
        ${profile.id}::uuid,
        'daily_bonus',
        ${amount},
        balance_coins,
        ${`Daily login bonus (${tierLabel})`}
      FROM user_profile WHERE id = ${profile.id}::uuid
    `);
    // Wave 47: the bonus just bumped total_coins_earned, so check whether
    // the user crossed into a new tier. Idempotent (no-op when below the
    // next threshold).
    await tx.execute(
      sql`SELECT public.check_and_promote_tier(${profile.id}::uuid)`,
    );
  });

  // After the bonus posts, daily_streak_7 / balance_50k / balance_100k
  // may unlock.
  const newlyUnlocked = await checkAndUnlockAchievements(profile.id);

  revalidatePath("/me");
  // Invalidate every /profile/[username] page so the owner's view picks up
  // the new balance + last-claim timestamp without us needing the username.
  revalidatePath("/profile/[username]", "page");
  revalidatePath("/leaderboard");
  return { awarded: amount, newlyUnlocked };
}
