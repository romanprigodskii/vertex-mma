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

  // Step-up gate: only a GENUINE recovery session (minted from the emailed
  // reset link by /auth/callback) may set a new password without proving the
  // old one. A normal — or hijacked / shared — credential session must NOT be
  // able to silently reset the password here; that flow lives in /settings,
  // where changePasswordAction re-verifies the current password.
  //
  // We read the session's AMR claim. A recovery session authenticates via the
  // one-time recovery token, so its methods NEVER include "password"/"oauth",
  // whereas a normal login always does. We gate on the ABSENCE of a credential
  // method rather than the exact "recovery" label so this stays correct even if
  // GoTrue records a recovery sign-in as "otp"/"magiclink" on some versions; an
  // empty/unknown AMR fails closed.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const methods = (
    (aal?.currentAuthenticationMethods ?? []) as Array<
      string | { method?: string | null }
    >
  ).map((m) => (typeof m === "string" ? m : (m?.method ?? "")));
  const isCredentialLogin =
    methods.includes("password") || methods.includes("oauth");
  if (methods.length === 0 || isCredentialLogin) {
    return { error: t("resetInvalid") };
  }

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { error: mapAuthError(error, t) };
  return { success: true };
}
