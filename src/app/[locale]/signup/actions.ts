"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";

import { isEmailAlreadyRegisteredError, mapAuthError } from "@/lib/auth-errors";
import { db } from "@/lib/db";
import { userProfile } from "@/lib/db/schema/users";
import { createClient } from "@/lib/supabase/server";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

export async function signUpAction(
  formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  const t = await getTranslations("auth");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const username = String(formData.get("username") ?? "").trim();

  if (!email || !password || !username) {
    return { error: t("errAllFieldsRequired") };
  }
  if (!USERNAME_RE.test(username)) {
    return { error: t("errUsernameFormat") };
  }
  if (password.length < 8) {
    return { error: t("passwordTooShort") };
  }

  // Pre-check username uniqueness; the trigger has a final safety net
  // (numeric suffix on collision) but we want to surface a clean error.
  const existing = await db
    .select({ id: userProfile.id })
    .from(userProfile)
    .where(eq(userProfile.username, username))
    .limit(1);
  if (existing.length > 0) {
    return { error: t("errUsernameTaken") };
  }

  const supabase = await createClient();

  const h = await headers();
  const origin =
    h.get("origin") ??
    `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { username },
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });
  if (error) {
    // Don't reveal whether the email is already registered — return the same
    // neutral "check your email" state as a fresh signup (mirrors the
    // forgot-password flow, which never discloses account existence). Genuine
    // errors (weak password, send rate-limit) still surface.
    if (isEmailAlreadyRegisteredError(error)) return { success: true };
    return { error: mapAuthError(error, t) };
  }

  return { success: true };
}
