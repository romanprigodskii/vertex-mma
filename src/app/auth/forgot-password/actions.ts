"use server";

import { headers } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";

import { mapAuthError } from "@/lib/auth-errors";
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
  // Canonical origin for the password-reset link. The request Host is
  // forwardable behind the proxy, so a spoofed Host could plant an
  // attacker-controlled redirectTo in the recovery email and intercept the
  // code — prefer the configured site URL, fall back to request-derived
  // headers only in development, and never trust the Host in production
  // (mirrors siteOrigin() in /auth/callback and signUpAction).
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  const origin =
    fromEnv ??
    (process.env.NODE_ENV !== "production"
      ? (h.get("origin") ??
        `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`)
      : "https://vertexmma.com");

  // Route through the existing /auth/callback handler so the recovery code is
  // exchanged for a session before we land on the reset form. Carry the locale
  // so a link opened on another device still renders in the user's language.
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/auth/reset-password&locale=${locale}`,
  });
  if (error) return { error: mapAuthError(error, t) };
  return { success: true };
}
