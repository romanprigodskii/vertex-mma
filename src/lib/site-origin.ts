/**
 * Resolve the canonical site origin (scheme + host, no trailing slash) for
 * building absolute URLs that leave the server — the targets of auth emails
 * (`emailRedirectTo` / `redirectTo`) and the post-callback browser redirect.
 *
 * Behind Traefik/Coolify the incoming request resolves to the internal
 * container origin (http://10.0.1.8:3000), which must never end up in an email
 * link or the user's redirect chain. NEXT_PUBLIC_SITE_URL is therefore the
 * canonical source of truth and always wins; the request-header fallbacks only
 * apply in local dev, where that env var is typically unset.
 *
 * Accepts any `Headers` — a route handler's `request.headers` or the
 * `ReadonlyHeaders` returned by `headers()` in a Server Action.
 */
export function siteOrigin(headers: Headers): string {
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  const origin = headers.get("origin");
  if (origin) return origin;
  const proto = headers.get("x-forwarded-proto") ?? "http";
  const host = headers.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}
