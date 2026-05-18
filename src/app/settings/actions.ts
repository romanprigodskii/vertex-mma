"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { checkAndUnlockAchievements } from "@/lib/achievements";
import { db } from "@/lib/db";
import { userProfile } from "@/lib/db/schema/users";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const COUNTRY_RE = /^[A-Z]{2}$/;

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
  const newPassword = String(formData.get("newPassword") ?? "");
  if (newPassword.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  const supabase = await createClient();
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
