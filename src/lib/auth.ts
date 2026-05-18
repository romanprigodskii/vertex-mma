import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { userProfile } from "@/lib/db/schema/users";
import { createClient } from "@/lib/supabase/server";

export type CurrentUser = {
  authUserId: string;
  email: string | null;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  balanceCoins: number;
  tier: string;
};

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const rows = await db
    .select({
      authUserId: userProfile.authUserId,
      username: userProfile.username,
      displayName: userProfile.displayName,
      avatarUrl: userProfile.avatarUrl,
      balanceCoins: userProfile.balanceCoins,
      tier: userProfile.tier,
    })
    .from(userProfile)
    .where(eq(userProfile.authUserId, user.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  return {
    ...row,
    email: user.email ?? null,
  };
}
