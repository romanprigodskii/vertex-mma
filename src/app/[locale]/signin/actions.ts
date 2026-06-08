"use server";

import { getTranslations } from "next-intl/server";

import { mapAuthError } from "@/lib/auth-errors";
import { allowAction, AUTH_COOLDOWN_MS } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

export async function signInAction(
  formData: FormData,
): Promise<{ error?: string }> {
  const t = await getTranslations("auth");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: t("errFieldsRequired") };

  // Defence-in-depth on top of GoTrue's own limits: throttle scripted password
  // guessing against a single account. Invisible to a human (a real retry takes
  // longer than the cooldown to type).
  if (!allowAction(`signin:${email}`, AUTH_COOLDOWN_MS.signIn)) {
    return { error: t("errRateLimit") };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: mapAuthError(error, t) };
  return {};
}
