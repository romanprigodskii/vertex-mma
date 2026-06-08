"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { checkAndUnlockAchievements } from "@/lib/achievements";
import { userHasPassword } from "@/lib/auth";
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
  const t = await getTranslations("settings");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: t("notSignedIn") };

  const displayName = String(formData.get("displayName") ?? "")
    .trim()
    .slice(0, 60);
  const bio = String(formData.get("bio") ?? "").trim().slice(0, 280);
  const countryCodeRaw = String(formData.get("countryCode") ?? "")
    .trim()
    .toUpperCase()
    .slice(0, 2);

  if (countryCodeRaw && !COUNTRY_RE.test(countryCodeRaw)) {
    return { error: t("countryCodeInvalid") };
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

// Avatar uploads run entirely server-side. The browser POSTs the raw file
// to this action; we validate it, write it to the avatars bucket via the
// service-role client, then persist the public URL on user_profile.
//
// The storage path is derived from the authenticated session — NEVER from
// client input — so a user can only ever overwrite their own avatar. That
// guarantee no longer leans on storage RLS policies being present or
// correct: the service role bypasses RLS, and the path is the boundary.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

// We sniff the actual leading bytes rather than trusting the browser-declared
// file.type: the extension AND the stored content-type are both derived from
// what the file genuinely is, so a renamed/mislabelled payload can never land
// in storage with a mismatched content-type.
function sniffAvatar(bytes: Buffer): { mime: string; ext: string } | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }
  // JPEG: FF D8 FF
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

export async function uploadAvatarAction(
  formData: FormData,
): Promise<{ error?: string; success?: boolean; url?: string }> {
  const t = await getTranslations("settings");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: t("notSignedIn") };

  const file = formData.get("file");
  // Re-validate server-side; never trust the client's size/type checks.
  if (!(file instanceof File) || file.size === 0) {
    return { error: t("uploadFailed") };
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return { error: t("avatarTooLarge") };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await file.arrayBuffer());
  } catch {
    return { error: t("uploadFailed") };
  }
  // Content sniff is the real type gate — covers both a wrong declared type
  // and bytes that don't match any allowed image format.
  const kind = sniffAvatar(bytes);
  if (!kind) {
    return { error: t("avatarWrongType") };
  }

  // Path comes from the session, not the upload — this is the real authz.
  const path = `${user.id}/avatar.${kind.ext}`;

  const admin = createAdminClient();
  const { error: uploadError } = await admin.storage
    .from("avatars")
    .upload(path, bytes, { upsert: true, contentType: kind.mime });
  if (uploadError) return { error: t("uploadFailed") };

  const {
    data: { publicUrl },
  } = admin.storage.from("avatars").getPublicUrl(path);
  // Cache-bust so the CDN-cached <img src> refreshes immediately.
  const versionedUrl = `${publicUrl}?v=${Date.now()}`;

  const updated = await db
    .update(userProfile)
    .set({ avatarUrl: versionedUrl })
    .where(eq(userProfile.authUserId, user.id))
    .returning({ id: userProfile.id });

  // profile_complete may unlock once an avatar lands.
  if (updated[0]?.id) {
    await checkAndUnlockAchievements(updated[0].id);
  }

  revalidatePath("/me");
  revalidatePath("/settings");
  return { success: true, url: versionedUrl };
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
  const t = await getTranslations("settings");
  const newEmail = String(formData.get("newEmail") ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(newEmail)) {
    return { error: t("emailInvalid") };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: t("notSignedIn") };
  if (user.email === newEmail) {
    return { error: t("emailSameAsCurrent") };
  }

  // Changing the account email is the first step of a takeover (the new
  // address can later drive password recovery). For password accounts,
  // re-verify the current password before initiating the change — matching
  // changePasswordAction — so a hijacked tab / borrowed session can't reroute
  // the email on the live session alone. OAuth-only accounts have no password
  // to verify and rely on Supabase's double-confirmation instead.
  if (userHasPassword(user)) {
    if (!user.email) return { error: t("currentPasswordWrong") };
    const currentPassword = String(formData.get("currentPassword") ?? "");
    if (!currentPassword) return { error: t("currentPasswordRequired") };
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });
    if (verifyError) return { error: t("currentPasswordWrong") };
  }

  // Supabase auto-handles double-confirmation: a "Confirm change" link is
  // sent to the current address AND a "Confirm new address" link is sent
  // to the new one. The change only takes effect once both are clicked.
  const { error } = await supabase.auth.updateUser({ email: newEmail });
  if (error) return { error: error.message };
  return { success: true };
}

export async function deleteAccountAction(formData?: FormData): Promise<{
  error?: string;
  success?: boolean;
}> {
  const t = await getTranslations("settings");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: t("notSignedIn") };

  // Account deletion is irreversible and cascades the entire profile, so it
  // demands step-up auth — a live session alone (hijacked tab, borrowed
  // device, stolen cookie, or a direct call bypassing the typed-DELETE prompt)
  // must not be enough. Re-verify the current password for password accounts
  // before touching anything. OAuth-only accounts have no password to verify,
  // so they fall back to the deliberate typed-DELETE confirmation.
  if (userHasPassword(user)) {
    if (!user.email) return { error: t("currentPasswordWrong") };
    const currentPassword = String(formData?.get("currentPassword") ?? "");
    if (!currentPassword) return { error: t("currentPasswordRequired") };
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });
    if (verifyError) return { error: t("currentPasswordWrong") };
  }

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
  const t = await getTranslations("settings");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: t("notSignedIn") };

  const newUsername = String(formData.get("newUsername") ?? "").trim();
  if (!USERNAME_RE.test(newUsername)) {
    return { error: t("usernameFormatInvalid") };
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
  if (!profile) return { error: t("profileNotFound") };

  if (profile.currentUsername === newUsername) {
    return { error: t("usernameSameAsCurrent") };
  }

  if (profile.lastChanged) {
    const daysSince =
      (Date.now() - new Date(profile.lastChanged).getTime()) /
      (1000 * 60 * 60 * 24);
    if (daysSince < USERNAME_CHANGE_COOLDOWN_DAYS) {
      const daysLeft = Math.ceil(
        USERNAME_CHANGE_COOLDOWN_DAYS - daysSince,
      );
      return { error: t("usernameCooldown", { count: daysLeft }) };
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
    return { error: t("usernameTaken") };
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
