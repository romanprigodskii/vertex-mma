"use server";

import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";

import { mapAuthError } from "@/lib/auth-errors";
import { allowAction } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

// App-level throttle on sign-in. signInWithPassword is an online password
// oracle (and is reused by the settings step-up actions), so an unthrottled
// path enables credential-stuffing / password-guessing limited only by
// Supabase's coarse limits. A min-gap per email AND per client IP is invisible
// to a human signing in but caps a script to one attempt per window per key.
const SIGNIN_COOLDOWN_MS = 2_000;

export async function signInAction(
  formData: FormData,
): Promise<{ error?: string }> {
  const t = await getTranslations("auth");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: t("errFieldsRequired") };

  const ip =
    (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  // Record BOTH hits (don't short-circuit with ||) so the per-IP gate counts
  // every attempt even when the per-email gate alone would have allowed it.
  const emailOk = allowAction(`signin:${email}`, SIGNIN_COOLDOWN_MS);
  const ipOk = allowAction(`signin-ip:${ip}`, SIGNIN_COOLDOWN_MS);
  if (!emailOk || !ipOk) return { error: t("errRateLimit") };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: mapAuthError(error, t) };
  return {};
}
