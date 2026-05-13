/**
 * Convert an ISO 3166-1 alpha-2 country code to a flag emoji.
 * Returns a white flag for missing or malformed codes.
 */
export function getCountryFlag(code: string | null | undefined): string {
  if (!code || code.length !== 2) return "🏳️";
  const codePoints = code
    .toUpperCase()
    .split("")
    .map((c) => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}
