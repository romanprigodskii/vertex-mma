/**
 * Returns `raw` only if it is a safe, same-origin relative path; otherwise "/".
 *
 * Rejects absolute URLs, protocol-relative `//host`, and backslash `/\host`
 * (which several browsers normalise to `//host`). Shared by the sign-in form
 * and the /auth/callback route so the client preview and the server redirect
 * enforce exactly one rule — preventing post-auth open-redirect phishing.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
