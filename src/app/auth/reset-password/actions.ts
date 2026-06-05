"use server";

import { getTranslations } from "next-intl/server";

import { mapAuthError } from "@/lib/auth-errors";
import { createClient } from "@/lib/supabase/server";

export async function resetPasswordAction(
  formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  const t = await getTranslations("auth");
  const newPassword = String(formData.get("newPassword") ?? "");
  if (newPassword.length < 8) {
    return { error: t("passwordTooShort") };
  }

  const supabase = await createClient();
  // The recovery session is minted by /auth/callback before the form renders.
  // If it's gone by submit time (expired/used link, or a direct hit), say so
  // explicitly instead of falling through to mapAuthError's generic message.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: t("resetInvalid") };

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { error: mapAuthError(error, t) };
  return { success: true };
}
