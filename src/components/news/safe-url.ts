/**
 * Render-time URL scheme guard. Returns the URL only when it parses to an
 * absolute http(s) URL, otherwise null. This is defense-in-depth: the Python
 * ingest already filters refs to http(s), but the TS types (NewsExternalRef.url,
 * news_item.url) and the DB schema (text) permit anything, and any future ingest
 * path (LLM-suggested refs, manual backfill, admin entry) would bypass that gate.
 * The render layer must defend itself so a stored `javascript:` / `data:` value
 * can never reach an href or <img src>.
 *
 * Pure, dependency-free, safe to import from both server and client components.
 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" ? url : null;
  } catch {
    // Relative paths and malformed strings throw — treat as unsafe for an
    // external href. (Internal navigation uses next-intl <Link>, not this.)
    return null;
  }
}
