/**
 * Vertex Score tier classifier (Wave 3.5 step 4A).
 *
 * Combines score-based tiers (Elite / Contender / Pro / Veteran / Unranked)
 * with championship-pedigree overrides (Active / Dominant / Former Champion).
 * Champion overrides supersede score-based tiers in display: a current
 * champion who happens to score 70 is still shown as "Active Champion," not
 * "Pro." Conversely a non-champion who scores 96 is "Elite."
 *
 * Wave 3.5's score formula maxes out around 90 in practice (no fighter has
 * reached 95+ in the current data); the Elite breakpoint stays at 95 by
 * design so the tier is reserved for genuinely transcendent performances
 * if the formula is recalibrated in the future.
 */

import {
  isActiveChampion,
  isDominantChampion,
  isFormerChampion,
} from "./championship-history";

export type VertexTier =
  | "active_champion"
  | "dominant_champion"
  | "former_champion"
  | "elite"
  | "contender"
  | "pro"
  | "veteran"
  | "unranked";

export interface TierStyle {
  tier: VertexTier;
  label: string;
  /** Border colour as an OKLCH() value; "transparent" for unranked. */
  borderColor: string;
  borderWidth: number;
  /** Optional outer glow (oklch w/ alpha); null when no glow. */
  glowColor: string | null;
  /** Short uppercase label for badges; "" for unranked (no badge). */
  badgeText: string;
  /** Optional decorative accent for the badge — UI step renders an icon. */
  badgeAccent?: "crown" | "double-crown";
}

export const TIER_STYLES: Record<VertexTier, TierStyle> = {
  active_champion: {
    tier: "active_champion",
    label: "Active Champion",
    borderColor: "oklch(0.82 0.18 70)",
    borderWidth: 4,
    glowColor: "oklch(0.78 0.15 70 / 0.4)",
    badgeText: "ACTIVE CHAMPION",
    badgeAccent: "crown",
  },
  dominant_champion: {
    tier: "dominant_champion",
    label: "Dominant Champion",
    borderColor: "oklch(0.78 0.16 65)",
    borderWidth: 3,
    glowColor: "oklch(0.75 0.14 70 / 0.3)",
    badgeText: "DOMINANT",
    badgeAccent: "crown",
  },
  former_champion: {
    tier: "former_champion",
    label: "Former Champion",
    borderColor: "oklch(0.62 0.10 75)",
    borderWidth: 2,
    glowColor: null,
    badgeText: "FORMER CHAMPION",
  },
  elite: {
    tier: "elite",
    label: "Elite",
    borderColor: "oklch(0.70 0.18 290)",
    borderWidth: 2,
    glowColor: null,
    badgeText: "ELITE",
  },
  contender: {
    tier: "contender",
    label: "Contender",
    borderColor: "oklch(0.65 0.12 235)",
    borderWidth: 2,
    glowColor: null,
    badgeText: "CONTENDER",
  },
  pro: {
    tier: "pro",
    label: "Pro",
    borderColor: "oklch(0.55 0.06 200)",
    borderWidth: 2,
    glowColor: null,
    badgeText: "PRO",
  },
  veteran: {
    tier: "veteran",
    label: "Veteran",
    borderColor: "oklch(0.45 0.02 240)",
    borderWidth: 1,
    glowColor: null,
    badgeText: "VETERAN",
  },
  unranked: {
    tier: "unranked",
    label: "Unranked",
    borderColor: "transparent",
    borderWidth: 0,
    glowColor: null,
    badgeText: "",
  },
};

export interface ClassifyArgs {
  slug: string;
  vertexScore: number | null;
  vertexScoreAllTime: number | null;
  ufcBouts: number;
}

/**
 * Score-based tier breaks (used when no champion override applies):
 *   Elite      95+
 *   Contender  75-94
 *   Pro        50-74
 *   Veteran    0-49
 *
 * Reference score: current if active and present, else all-time, else 0.
 */
export function classifyFighter(args: ClassifyArgs): VertexTier {
  if (args.ufcBouts < 3) return "unranked";
  if (args.vertexScore === null && args.vertexScoreAllTime === null) {
    return "unranked";
  }

  if (isActiveChampion(args.slug)) return "active_champion";
  if (isDominantChampion(args.slug)) return "dominant_champion";
  if (isFormerChampion(args.slug)) return "former_champion";

  const referenceScore = args.vertexScore ?? args.vertexScoreAllTime ?? 0;
  if (referenceScore >= 95) return "elite";
  if (referenceScore >= 75) return "contender";
  if (referenceScore >= 50) return "pro";
  return "veteran";
}

export function getTierStyle(tier: VertexTier): TierStyle {
  return TIER_STYLES[tier];
}

export function getFighterTierStyle(args: ClassifyArgs): TierStyle {
  return getTierStyle(classifyFighter(args));
}
