"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";

import { isEmailAlreadyRegisteredError, mapAuthError } from "@/lib/auth-errors";
import { db } from "@/lib/db";
import { userProfile } from "@/lib/db/schema/users";
import { allowAction } from "@/lib/rate-limit";
import { safeNext } from "@/lib/safe-redirect";
import { createClient } from "@/lib/supabase/server";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

export async function signUpAction(
  formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  const t = await getTranslations("auth");

  // Per-IP throttle. Signup is unauthenticated and does a public username
  // existence pre-check below — usernames are public (via /profile/[username]),
  // so availability is intentionally disclosed, but without a throttle that
  // pre-check is an unbounded enumeration oracle and the endpoint invites
  // scripted spam. Best-effort + process-local (see rate-limit.ts); the
  // load-bearing guarantees remain Supabase's own send limits and the
  // user_profile.username unique constraint.
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";
  const SIGNUP_COOLDOWN_MS = 2_000;
  if (!allowAction(`signup:${ip}`, SIGNUP_COOLDOWN_MS)) {
    return { error: t("errRateLimit") };
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const username = String(formData.get("username") ?? "").trim();
  // Carry the post-signup destination across the email-confirmation round-trip
  // so a user bounced here from a gated page lands there after confirming —
  // not on the homepage. safeNext rejects anything but a same-origin path.
  const next = safeNext(formData.get("next") as string | null);

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

  // Canonical origin for the email-confirmation link. The request Host is
  // forwardable behind the proxy, so prefer the configured site URL and only
  // fall back to request-derived headers in development; never trust the Host
  // in production (mirrors siteOrigin() in /auth/callback).
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  const origin =
    fromEnv ??
    (process.env.NODE_ENV !== "production"
      ? (h.get("origin") ??
        `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`)
      : "https://vertexmma.com");

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { username },
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
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
