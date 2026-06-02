/**
 * Maps a Supabase auth error to a localized, user-safe message instead of
 * surfacing the raw English `error.message`. Keyed on the stable `code` where
 * available, with a message-substring fallback for older SDK paths. Callers
 * pass a translator scoped to the `auth` namespace.
 */
type AuthErrorLike = { code?: string | null; message?: string | null } | null;
type Translator = (key: string) => string;

export function mapAuthError(error: AuthErrorLike, t: Translator): string {
  if (!error) return t("errGeneric");
  const code = (error.code ?? "").toLowerCase();
  const msg = (error.message ?? "").toLowerCase();

  if (code === "invalid_credentials" || msg.includes("invalid login")) {
    return t("errInvalidCredentials");
  }
  if (
    code === "user_already_exists" ||
    msg.includes("already registered") ||
    msg.includes("already been registered")
  ) {
    return t("errEmailTaken");
  }
  if (
    code === "over_email_send_rate_limit" ||
    code === "over_request_rate_limit" ||
    msg.includes("rate limit") ||
    msg.includes("too many")
  ) {
    return t("errRateLimit");
  }
  if (
    code === "weak_password" ||
    msg.includes("weak password") ||
    msg.includes("at least 6")
  ) {
    return t("errWeakPassword");
  }
  if (code === "email_not_confirmed" || msg.includes("not confirmed")) {
    return t("errEmailNotConfirmed");
  }
  if (code === "same_password" || msg.includes("should be different")) {
    return t("errSamePassword");
  }
  return t("errGeneric");
}
