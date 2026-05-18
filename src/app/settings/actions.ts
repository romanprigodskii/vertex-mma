"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { userProfile } from "@/lib/db/schema/users";
import { createClient } from "@/lib/supabase/server";

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

  await db
    .update(userProfile)
    .set({
      displayName: displayName || null,
      bio: bio || null,
      countryCode: countryCodeRaw || null,
    })
    .where(eq(userProfile.authUserId, user.id));

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

  await db
    .update(userProfile)
    .set({ avatarUrl: publicUrl })
    .where(eq(userProfile.authUserId, user.id));

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
