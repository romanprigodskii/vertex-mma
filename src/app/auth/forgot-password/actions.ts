"use server";

import { headers } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";

import { mapAuthError } from "@/lib/auth-errors";
import { siteOrigin } from "@/lib/site-origin";
import { createClient } from "@/lib/supabase/server";

export async function forgotPasswordAction(
  formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  const t = await getTranslations("auth");
  const locale = await getLocale();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) return { error: t("errEmailRequired") };

  const supabase = await createClient();
  const h = await headers();
  const origin = siteOrigin(h);

  // Route through the existing /auth/callback handler so the recovery code is
  // exchanged for a session before we land on the reset form. Carry the locale
  // so a link opened on another device still renders in the user's language.
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/auth/reset-password&locale=${locale}`,
  });
  if (error) return { error: mapAuthError(error, t) };
  return { success: true };
}
