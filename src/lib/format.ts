/**
 * Locale-independent integer formatter.
 *
 * Background: `Number.prototype.toLocaleString()` honors the runtime's locale,
 * which differs between server (en-US by default in Next's Node runtime) and
 * client (the user's browser locale). For Russian users in Chrome that yields
 * "2 697" client-side vs "2,697" server-side and React surfaces it as a
 * hydration mismatch warning. We pin the formatter to en-US-style grouping
 * with a comma so SSR and CSR produce identical strings everywhere.
 *
 * Use this for any user-visible integer in the catalog (fighter counts,
 * filter result counts, country fighter counts, etc.).
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.trunc(n);
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
