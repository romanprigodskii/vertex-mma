/**
 * Returns `raw` only if it is a safe, same-origin relative path; otherwise "/".
 *
 * Rejects absolute URLs, protocol-relative `//host`, backslash `/\host` (which
 * several browsers normalise to `//host`), and — crucially — control-character
 * smuggling like `/%09//evil` or `/\n//evil`. The WHATWG URL parser silently
 * strips TAB/LF/CR, so a leading control char followed by `//` resolves to
 * host=evil once parsed; naive prefix checks miss it. We therefore strip ASCII
 * control chars, run the prefix checks against both the raw and percent-decoded
 * forms, and finally resolve against a sentinel origin and require the result
 * stay on it (decoding is detection-only — the returned path keeps its original
 * encoding).
 *
 * Shared by the sign-in form and the /auth/callback route so the client preview
 * and the server redirect enforce exactly one rule — preventing post-auth
 * open-redirect phishing.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/";

  // Strip ASCII control chars (TAB/LF/CR/NUL/DEL) the WHATWG URL parser would
  // silently drop. Done on the raw value so a literal control char — e.g. the
  // already-decoded `/\t//evil` that searchParams.get() yields from
  // `?next=/%09//evil` — can't hide a leading `//`.
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, "");

  // Detection-only copy: also examine the percent-decoded form so a *still*
  // encoded control char (a caller that never decoded) is caught too. We never
  // RETURN this — decoding the returned value would corrupt encoded query/path
  // characters (e.g. `?a=%26b` -> `?a=&b`). A malformed escape can't be a legit
  // app path, so reject it.
  let probe: string;
  try {
    probe = decodeURIComponent(cleaned).replace(/[\x00-\x1f\x7f]/g, "");
  } catch {
    return "/";
  }

  for (const v of [cleaned, probe]) {
    if (!v.startsWith("/")) return "/";
    if (v.startsWith("//") || v.startsWith("/\\")) return "/";
  }

  // Final authority: resolve against a sentinel origin and require the result
  // stay on it as a root-relative path. Anything that escapes the origin
  // (protocol-relative, embedded creds, backslash tricks) collapses to "/".
  try {
    const u = new URL(cleaned, "http://x.invalid");
    if (u.origin !== "http://x.invalid") return "/";
    if (u.pathname.startsWith("//")) return "/";
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return "/";
  }
}
