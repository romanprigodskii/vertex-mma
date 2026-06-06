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
  betCount: number;
  currentStreak: number;
  bestStreak: number;
  joinedAt: string;
  lastDailyBonusAt: string | null;
  usernameLastChangedAt: string | null;
  /** Staff/moderator capability, derived from the ADMIN_EMAILS allowlist. */
  isStaff: boolean;
  /** True when the account has an email/password identity (vs OAuth-only).
   *  Gates password re-authentication on destructive settings actions so we
   *  can step up password users without locking out Google-only accounts. */
  hasPassword: boolean;
};

/**
 * Whether an email is on the staff/moderator allowlist (ADMIN_EMAILS, a
 * comma-separated env var). This is the project's only privileged role today —
 * used for trust-and-safety actions like removing another user's comment.
 */
export function isStaffEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allow = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(email.toLowerCase());
}

type AuthUserLike = {
  identities?: { provider?: string | null }[] | null;
  app_metadata?: { provider?: string; providers?: string[] } | null;
};

/**
 * True when the user can re-authenticate with an email/password — i.e. has an
 * "email" identity — as opposed to an OAuth-only account that has no password
 * to verify. Used to gate password step-up on destructive actions (account
 * deletion, email change) without permanently locking out Google-only users,
 * who can never produce a password.
 */
export function userHasPassword(user: AuthUserLike | null | undefined): boolean {
  if (!user) return false;
  const identities = user.identities ?? [];
  if (identities.length > 0) {
    return identities.some((i) => i.provider === "email");
  }
  // Fall back to app_metadata when identities aren't expanded on the user.
  const providers = user.app_metadata?.providers ?? [];
  if (providers.length > 0) return providers.includes("email");
  return user.app_metadata?.provider === "email";
}

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
      betCount: userProfile.betCount,
      currentStreak: userProfile.currentStreak,
      bestStreak: userProfile.bestStreak,
      joinedAt: userProfile.joinedAt,
      lastDailyBonusAt: userProfile.lastDailyBonusAt,
      usernameLastChangedAt: userProfile.usernameLastChangedAt,
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
    betCount: row.betCount,
    currentStreak: row.currentStreak,
    bestStreak: row.bestStreak,
    joinedAt: row.joinedAt.toISOString(),
    lastDailyBonusAt: row.lastDailyBonusAt
      ? row.lastDailyBonusAt.toISOString()
      : null,
    usernameLastChangedAt: row.usernameLastChangedAt
      ? row.usernameLastChangedAt.toISOString()
      : null,
    isStaff: isStaffEmail(user.email),
    hasPassword: userHasPassword(user),
  };
}

// Public-safe shape: same fields as CurrentUser minus auth identifiers and
// balanceCoins (private). Used by /profile/[username] and any future
// leaderboard / @username link.
export type PublicProfile = {
  userProfileId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  countryCode: string | null;
  tier: string;
  totalCoinsEarned: number;
  betCount: number;
  currentStreak: number;
  bestStreak: number;
  joinedAt: string;
  lastDailyBonusAt: string | null;
};

export async function getUserProfileByUsername(
  username: string,
): Promise<PublicProfile | null> {
  const rows = await db
    .select({
      userProfileId: userProfile.id,
      username: userProfile.username,
      displayName: userProfile.displayName,
      avatarUrl: userProfile.avatarUrl,
      bio: userProfile.bio,
      countryCode: userProfile.countryCode,
      tier: userProfile.tier,
      totalCoinsEarned: userProfile.totalCoinsEarned,
      betCount: userProfile.betCount,
      currentStreak: userProfile.currentStreak,
      bestStreak: userProfile.bestStreak,
      joinedAt: userProfile.joinedAt,
      lastDailyBonusAt: userProfile.lastDailyBonusAt,
    })
    .from(userProfile)
    .where(eq(userProfile.username, username))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    joinedAt: row.joinedAt.toISOString(),
    lastDailyBonusAt: row.lastDailyBonusAt
      ? row.lastDailyBonusAt.toISOString()
      : null,
  };
}
