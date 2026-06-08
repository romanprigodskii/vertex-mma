"use server";

import { getTranslations } from "next-intl/server";

import { mapAuthError } from "@/lib/auth-errors";
import { createClient } from "@/lib/supabase/server";

/** Most-recent authentication method from the JWT `amr` claim. Supabase emits
 *  it either as an RFC-8176 string[] (most-recent last) or as detailed entries
 *  carrying timestamps; handle both. Returns null when no method is present. */
function mostRecentAuthMethod(
  amr: ReadonlyArray<string | { method: string; timestamp?: number }> | null | undefined,
): string | null {
  if (!Array.isArray(amr) || amr.length === 0) return null;
  let bestMethod: string | null = null;
  let bestTs = -Infinity;
  for (let i = 0; i < amr.length; i += 1) {
    const entry = amr[i];
    const method = typeof entry === "string" ? entry : entry.method;
    // String form is most-recent-last, so the index is a fine recency proxy;
    // the detailed form carries a real timestamp. `>=` lets a later equal-rank
    // entry win, keeping the most recent method.
    const ts = typeof entry === "string" ? i : entry.timestamp ?? i;
    if (ts >= bestTs) {
      bestTs = ts;
      bestMethod = method;
    }
  }
  return bestMethod;
}

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

  // Step-up guard: this endpoint may ONLY be used by a genuine recovery
  // session. Such a session is minted fresh from the recovery link, so its
  // most-recent auth method is the email/recovery/OTP proof — never
  // `password`/`oauth`. A normal logged-in session (stolen cookie, borrowed
  // device, hijacked tab) that authenticated with a password or via OAuth must
  // NOT be able to silently set a new password here; it has to go through
  // Settings → Change password (changePasswordAction), which re-verifies the
  // current password. getClaims() validates the JWT and exposes the `amr`.
  //
  // Fail closed: we only proceed when the session actually presents a
  // recovery-type method. `null` (claim absent / unclassifiable) is rejected
  // too — a denylist of password/oauth alone would let an unexpected/empty
  // amr slip through. This can't lock out real recovery users: getUser()
  // above already confirmed a valid session, so getClaims() returns its
  // claims, and a recovery session's amr always carries a recovery/otp method.
  const { data: claimsData } = await supabase.auth.getClaims();
  const authMethod = mostRecentAuthMethod(claimsData?.claims?.amr);
  if (authMethod === null || authMethod === "password" || authMethod === "oauth") {
    return { error: t("resetNotRecovery") };
  }

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { error: mapAuthError(error, t) };
  return { success: true };
}
