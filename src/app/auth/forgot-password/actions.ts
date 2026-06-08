"use server";

import { headers } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";

import { mapAuthError } from "@/lib/auth-errors";
import { allowAction, AUTH_COOLDOWN_MS, clientIp } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

export async function forgotPasswordAction(
  formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  const t = await getTranslations("auth");
  const locale = await getLocale();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) return { error: t("errEmailRequired") };

  const h = await headers();
  // Throttle reset-email sends: per-IP (enumeration / mailbombing from one host)
  // and per-email (don't resend to the same address in quick succession). The
  // IP check runs first so an IP-blocked request doesn't consume the email slot.
  if (
    !allowAction(`forgot-ip:${clientIp(h)}`, AUTH_COOLDOWN_MS.forgotPasswordIp) ||
    !allowAction(`forgot:${email}`, AUTH_COOLDOWN_MS.forgotPassword)
  ) {
    return { error: t("errRateLimit") };
  }

  const supabase = await createClient();
  // Build the recovery link from the canonical site origin (not request headers,
  // which are attacker-influenceable Host/X-Forwarded-* values) so a spoofed
  // Host can't redirect the emailed link to another domain.
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
    h.get("origin") ||
    `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;

  // Route through the existing /auth/callback handler so the recovery code is
  // exchanged for a session before we land on the reset form. Carry the locale
  // so a link opened on another device still renders in the user's language.
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/auth/reset-password&locale=${locale}`,
  });
  if (error) return { error: mapAuthError(error, t) };
  return { success: true };
}
