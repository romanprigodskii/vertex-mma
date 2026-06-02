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
  // The session was already established by /auth/callback during the
  // recovery flow, so updateUser writes through to the right user.
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { error: mapAuthError(error, t) };
  return { success: true };
}
