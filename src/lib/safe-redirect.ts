/**
 * Returns `raw` only if it is a safe, same-origin relative path; otherwise "/".
 *
 * Rejects absolute URLs, protocol-relative `//host`, and backslash `/\host`
 * (which several browsers normalise to `//host`). Also rejects any control
 * character or whitespace (CR / LF / TAB / space, plus the Unicode line
 * separators U+2028 / U+2029): embedded in a `Location` value these enable
 * header / response splitting or get normalised by browsers in surprising
 * ways, either of which can slip a crafted path past the allowlist's intent.
 * Finally the path is round-tripped through the URL parser and re-emitted as
 * path + query + hash only, so the result is provably same-origin and free of
 * any smuggled host/scheme. Shared by the sign-in form and the /auth/callback
 * route so the client preview and the server redirect enforce exactly one
 * rule - preventing post-auth open-redirect phishing.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  // Any C0 control char (U+0000-U+001F), DEL (U+007F) or whitespace (\s, which
  // also covers U+2028 / U+2029 and the no-break space) is never legitimate in
  // a redirect path - reject before it can be smuggled into a header value.
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return "/";
  // Re-derive the path against a throwaway origin and re-emit only the
  // path-ish parts; anything that resolves to a different host/scheme or a
  // protocol-relative path collapses back to "/".
  try {
    const url = new URL(raw, "http://x");
    const out = `${url.pathname}${url.search}${url.hash}`;
    if (!out.startsWith("/") || out.startsWith("//")) return "/";
    return out;
  } catch {
    return "/";
  }
}
