/**
 * Hydration-safe integer formatter with optional locale-aware grouping.
 *
 * Background: `Number.prototype.toLocaleString()` honors the runtime's locale,
 * which differs between server (en-US by default in Next's Node runtime) and
 * client (the user's browser locale). For Russian users in Chrome that yields
 * "2 697" client-side vs "2,697" server-side and React surfaces it as a
 * hydration mismatch warning.
 *
 * We avoid that by grouping with a FIXED separator per locale rather than via
 * `Intl`: a comma for everything except `ru`, and a non-breaking space (U+00A0)
 * for `ru` to match the Russian convention (and the hardcoded catalog copy like
 * "50 000 монет"). Crucially the separator is chosen from the *next-intl route
 * locale* — identical on server and client — and is a fixed code point, so the
 * result is deterministic on both sides (unlike `Intl`, whose space code point
 * for ru-RU drifts between ICU versions). Omitting `locale` keeps the legacy
 * comma grouping, so existing one-arg callers are unaffected.
 *
 * Use this for any user-visible integer (coin balances, fighter counts, filter
 * result counts, etc.).
 */
export function formatNumber(n: number, locale?: string): string {
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.trunc(n);
  const separator = locale === "ru" ? " " : ",";
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}
