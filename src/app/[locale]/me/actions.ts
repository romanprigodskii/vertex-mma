"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { checkAndUnlockAchievements } from "@/lib/achievements";
import { db } from "@/lib/db";
import { userProfile } from "@/lib/db/schema/users";
import { COOLDOWN_MS, allowAction } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { dailyBonusAmount } from "@/lib/tier";

const COOLDOWN_HOURS = 20;

export async function claimDailyBonusAction(): Promise<{
  error?: string;
  hoursLeft?: number;
  awarded?: number;
  newlyUnlocked?: string[];
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "NOT_SIGNED_IN" };
  // The 20h cooldown is enforced below; this just stops a script from pounding
  // the endpoint (and the pooler) far faster than that check can run.
  if (!allowAction(`daily:${user.id}`, COOLDOWN_MS.dailyBonus)) {
    return { error: "RATE_LIMITED" };
  }

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
  if (!profile) return { error: "PROFILE_NOT_FOUND" };

  if (profile.lastDaily) {
    const lastMs = new Date(profile.lastDaily).getTime();
    const hoursSince = (Date.now() - lastMs) / (1000 * 60 * 60);
    if (hoursSince < COOLDOWN_HOURS) {
      const hoursLeft = Math.ceil(COOLDOWN_HOURS - hoursSince);
      return { error: "COOLDOWN_ACTIVE", hoursLeft };
    }
  }

  // Wave 47: tier drives the daily-bonus amount. The TS-side mapping in
  // src/lib/tier.ts mirrors the PL/pgSQL CASE in check_and_promote_tier.
  const amount = dailyBonusAmount(profile.tier);
  const tierLabel = profile.tier;

  const claimed = await db.transaction(async (tx) => {
    // Atomic claim guard. The TS cooldown check above is only an early,
    // friendly bail-out — on its own it's a read-then-write race: two
    // concurrent requests both read the old timestamp, both pass, and both
    // credit (double bonus). The real guard is this conditional UPDATE: the
    // cooldown is re-checked against the row's CURRENT timestamp inside the
    // statement, so concurrent claims serialize on the row lock and the
    // loser's WHERE no longer matches → it credits nothing. We award only
    // when a row actually came back.
    const rows = (await tx.execute(sql`
      UPDATE user_profile
      SET balance_coins = balance_coins + ${amount},
          total_coins_earned = total_coins_earned + ${amount},
          last_daily_bonus_at = NOW()
      WHERE id = ${profile.id}::uuid
        AND (
          last_daily_bonus_at IS NULL
          OR last_daily_bonus_at < NOW() - make_interval(hours => ${COOLDOWN_HOURS})
        )
      RETURNING balance_coins::float8 AS balance_coins
    `)) as unknown as Array<{ balance_coins: number }>;

    if (rows.length === 0) return false; // lost the race / cooldown still active

    const balanceAfter = rows[0]?.balance_coins ?? 0;
    await tx.execute(sql`
      INSERT INTO transaction (user_id, type, amount, balance_after, description)
      VALUES (
        ${profile.id}::uuid,
        'daily_bonus',
        ${amount},
        ${balanceAfter},
        ${`Daily login bonus (${tierLabel})`}
      )
    `);
    // Wave 47: the bonus just bumped total_coins_earned, so check whether
    // the user crossed into a new tier. Idempotent (no-op when below the
    // next threshold).
    await tx.execute(
      sql`SELECT public.check_and_promote_tier(${profile.id}::uuid)`,
    );
    return true;
  });

  if (!claimed) {
    // Another concurrent claim won the race (or the cooldown is still active).
    return { error: "ALREADY_CLAIMED" };
  }

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
