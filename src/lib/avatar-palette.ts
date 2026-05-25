/**
 * Avatar fallback palette + initials helpers.
 *
 * Used when a fighter has no photo URL. Renders as a deterministic
 * Sodium-tinted dark block with the fighter's initials.
 *
 * Pre-rebrand history: this used to be a 6-step *saturated* OKLCH
 * palette (red/gold/blue/purple/green/neutral) duplicated in both
 * `FighterAvatar.tsx` and `detail/FighterHero.tsx`. On real catalog data
 * those tints were the loudest thing on the page; the red one falsely
 * echoed the loss-red semantic. Both files now import this module.
 *
 * Current palette is a 4-step neutral monochrome ramp on the warm
 * Sodium surface. Colour carries no meaning here — the initials do the
 * distinguishing. The light spread (L 0.13 → 0.22) gives just enough
 * visual variety to not look like every avatar is identical.
 */

export const AVATAR_BG_PALETTE: readonly string[] = [
  "oklch(0.13 0.006 60)",
  "oklch(0.16 0.007 60)",
  "oklch(0.19 0.008 60)",
  "oklch(0.22 0.009 60)",
] as const;

/** Deterministic background pick — same fighter always gets the same tone. */
export function getAvatarBg(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash + name.charCodeAt(i)) | 0;
  }
  return AVATAR_BG_PALETTE[Math.abs(hash) % AVATAR_BG_PALETTE.length];
}

/** First letter of first name + first letter of last name. Falls back to
 *  the first two letters of a single-word name, or "?" when empty. */
export function getAvatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
