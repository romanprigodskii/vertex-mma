/**
 * Convert an ISO 3166-1 alpha-2 country code to a flag emoji.
 * Returns a white flag for missing or malformed codes.
 */
export function getCountryFlag(code: string | null | undefined): string {
  // country_code is CHAR(2) scraped from an external source and not enum-
  // validated, so reject anything that isn't two ASCII letters — otherwise
  // codes like "1A"/"--" map outside the regional-indicator block (U+1F1E6..
  // U+1F1FF) and render as stray glyphs / tofu instead of a flag.
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return "🏳️";
  const codePoints = code
    .toUpperCase()
    .split("")
    .map((c) => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}
