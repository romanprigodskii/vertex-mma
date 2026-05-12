import type { fighter } from "@/lib/db/schema/fighters";

type Fighter = typeof fighter.$inferSelect;

const DEFAULT_SILHOUETTE = "/images/silhouette-fighter-male.svg";

/**
 * Returns the best available photo URL for a fighter, falling back to a silhouette.
 */
export function getFighterPhotoUrl(
  f: Pick<
    Fighter,
    "photoUrl" | "photoThumbnailUrl" | "photoSilhouetteUrl"
  >,
  variant: "full" | "thumbnail" = "full",
): string {
  if (f.photoUrl) {
    if (variant === "thumbnail" && f.photoThumbnailUrl) {
      return f.photoThumbnailUrl;
    }
    return f.photoUrl;
  }
  return f.photoSilhouetteUrl ?? DEFAULT_SILHOUETTE;
}

/**
 * Format a fighter record as `W-L-D` (with optional `(N NC)` suffix).
 */
export function formatRecord(w: number, l: number, d: number, nc?: number): string {
  let result = `${w}-${l}-${d}`;
  if (nc && nc > 0) result += ` (${nc} NC)`;
  return result;
}

/**
 * Pick the right display name pair for a locale, lifting the nickname to primary if present.
 */
export function getDisplayName(
  f: Pick<Fighter, "nameEn" | "nameRu" | "nickname">,
  locale: "en" | "ru" = "en",
): { primary: string; secondary?: string } {
  const name = locale === "ru" && f.nameRu ? f.nameRu : f.nameEn;
  if (f.nickname) {
    return { primary: f.nickname.toUpperCase(), secondary: name };
  }
  return { primary: name };
}

/**
 * Convert an ISO 3166-1 alpha-2 country code to a flag emoji. Returns a white flag for missing codes.
 */
export function getCountryFlag(code: string | null | undefined): string {
  if (!code || code.length !== 2) return "🏳️";
  const codePoints = code
    .toUpperCase()
    .split("")
    .map((c) => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}
