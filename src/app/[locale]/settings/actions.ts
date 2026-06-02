"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { checkAndUnlockAchievements } from "@/lib/achievements";
import { db } from "@/lib/db";
import { userProfile } from "@/lib/db/schema/users";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const COUNTRY_RE = /^[A-Z]{2}$/;

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const USERNAME_CHANGE_COOLDOWN_DAYS = 30;

export async function updateProfileAction(
  formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const displayName = String(formData.get("displayName") ?? "")
    .trim()
    .slice(0, 60);
  const bio = String(formData.get("bio") ?? "").trim().slice(0, 280);
  const countryCodeRaw = String(formData.get("countryCode") ?? "")
    .trim()
    .toUpperCase()
    .slice(0, 2);

  if (countryCodeRaw && !COUNTRY_RE.test(countryCodeRaw)) {
    return { error: "Country code must be two letters (e.g. BR, US)." };
  }

  const updated = await db
    .update(userProfile)
    .set({
      displayName: displayName || null,
      bio: bio || null,
      countryCode: countryCodeRaw || null,
    })
    .where(eq(userProfile.authUserId, user.id))
    .returning({ id: userProfile.id });

  // profile_complete may unlock now that display name / bio / country are set.
  if (updated[0]?.id) {
    await checkAndUnlockAchievements(updated[0].id);
  }

  revalidatePath("/me");
  revalidatePath("/settings");
  return { success: true };
}

// Avatar URL is set after a successful client-side upload to the avatars
// bucket. The uploader passes the public URL back so the server can
// persist it on user_profile.avatar_url.
const ALLOWED_AVATAR_HOST_SUFFIX = ".supabase.co";

export async function updateAvatarUrlAction(
  publicUrl: string,
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  // Sanity: only accept URLs pointing at our Supabase storage host. Stops
  // a malicious client from pasting an arbitrary external URL (which
  // would still pass RLS but isn't an upload we'd want surfaced).
  let host: string;
  try {
    host = new URL(publicUrl).host;
  } catch {
    return { error: "Invalid avatar URL." };
  }
  if (!host.endsWith(ALLOWED_AVATAR_HOST_SUFFIX)) {
    return { error: "Avatar URL must be a Supabase storage URL." };
  }

  const updated = await db
    .update(userProfile)
    .set({ avatarUrl: publicUrl })
    .where(eq(userProfile.authUserId, user.id))
    .returning({ id: userProfile.id });

  // profile_complete may unlock once an avatar lands.
  if (updated[0]?.id) {
    await checkAndUnlockAchievements(updated[0].id);
  }

  revalidatePath("/me");
  revalidatePath("/settings");
  return { success: true };
}

export async function changePasswordAction(
  formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  const t = await getTranslations("settings");
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  if (newPassword.length < 8) {
    return { error: t("passwordTooShort") };
  }
  if (!currentPassword) {
    return { error: t("currentPasswordRequired") };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { error: t("currentPasswordWrong") };

  // Re-verify the current password before allowing a change — a logged-in
  // session alone shouldn't be enough to set a new password (defends against
  // a hijacked tab / shared device).
  const { error: verifyError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
  });
  if (verifyError) return { error: t("currentPasswordWrong") };

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { error: error.message };
  return { success: true };
}

export async function changeEmailAction(
  formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  const newEmail = String(formData.get("newEmail") ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(newEmail)) {
    return { error: "Please enter a valid email address." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };
  if (user.email === newEmail) {
    return { error: "That is already your email." };
  }

  // Supabase auto-handles double-confirmation: a "Confirm change" link is
  // sent to the current address AND a "Confirm new address" link is sent
  // to the new one. The change only takes effect once both are clicked.
  const { error } = await supabase.auth.updateUser({ email: newEmail });
  if (error) return { error: error.message };
  return { success: true };
}

export async function deleteAccountAction(): Promise<{
  error?: string;
  success?: boolean;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const userId = user.id;
  // Clear session cookies first so the client lands on a signed-out state
  // even if the admin delete races something.
  await supabase.auth.signOut();

  // admin.deleteUser fires auth.users DELETE → on_auth_user_deleted trigger
  // (Wave 34) cascades into user_profile and its FK-dependent rows.
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) return { error: error.message };

  return { success: true };
}

export async function changeUsernameAction(
  formData: FormData,
): Promise<{
  error?: string;
  success?: boolean;
  newUsername?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const newUsername = String(formData.get("newUsername") ?? "").trim();
  if (!USERNAME_RE.test(newUsername)) {
    return {
      error:
        "Username must be 3–30 chars: letters, digits, underscore.",
    };
  }

  const profileRows = await db
    .select({
      id: userProfile.id,
      currentUsername: userProfile.username,
      lastChanged: userProfile.usernameLastChangedAt,
    })
    .from(userProfile)
    .where(eq(userProfile.authUserId, user.id))
    .limit(1);
  const profile = profileRows[0];
  if (!profile) return { error: "Profile not found." };

  if (profile.currentUsername === newUsername) {
    return { error: "That is already your username." };
  }

  if (profile.lastChanged) {
    const daysSince =
      (Date.now() - new Date(profile.lastChanged).getTime()) /
      (1000 * 60 * 60 * 24);
    if (daysSince < USERNAME_CHANGE_COOLDOWN_DAYS) {
      const daysLeft = Math.ceil(
        USERNAME_CHANGE_COOLDOWN_DAYS - daysSince,
      );
      return {
        error: `You can change again in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`,
      };
    }
  }

  // Uniqueness pre-check. The unique constraint on user_profile.username
  // is the ultimate safety net, but a friendly error message is nicer
  // than a 500 on the rare race.
  const existing = await db
    .select({ id: userProfile.id })
    .from(userProfile)
    .where(eq(userProfile.username, newUsername))
    .limit(1);
  if (existing.length > 0) {
    return { error: "Username already taken." };
  }

  await db
    .update(userProfile)
    .set({
      username: newUsername,
      usernameLastChangedAt: new Date(),
    })
    .where(eq(userProfile.id, profile.id));

  revalidatePath("/settings");
  revalidatePath(`/profile/${profile.currentUsername}`);
  revalidatePath(`/profile/${newUsername}`);
  return { success: true, newUsername };
}
