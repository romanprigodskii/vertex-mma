/**
 * Vertex Score classifier — Wave 3.5 step 4A.2.
 *
 * Tier (score-based) and Champion status (history-based) are independent
 * dimensions. A fighter has BOTH simultaneously:
 *
 *   Islam Makhachev     → tier=Apex,     champion=active   (gold border + APEX badge)
 *   Jon Jones           → tier=Apex,     champion=dominant (gold border + APEX badge)
 *   Israel Adesanya     → tier=Veteran,  champion=dominant (gold border + VETERAN badge)
 *   Donald Cerrone      → tier=Veteran,  champion=none     (no border + VETERAN badge)
 *
 * The UI layer renders these as two visual elements (border/crown vs. tier
 * badge) so they don't compete for the same slot.
 */

import {
  isActiveChampion,
  isDominantChampion,
  isDoubleChampion as isDoubleChampionHelper,
  isFormerChampion,
} from "./championship-history";

/** Score-based tier — independent of champion history. */
export type VertexTier =
  | "apex" // score >= 80
  | "elite" // score 60-79
  | "veteran" // score 40-59
  | "roster" // score < 40
  | "unranked"; // <3 UFC bouts OR no score

/** Championship history — independent of score. */
export type ChampionStatus =
  | "active" // holds a belt right now
  | "dominant" // 3+ title defenses across all reigns
  | "former" // was champion, <3 defenses
  | "none";

export interface FighterClassification {
  tier: VertexTier;
  championStatus: ChampionStatus;
  isDoubleChampion: boolean;
}

export interface ClassifyArgs {
  slug: string;
  vertexScore: number | null;
  vertexScoreAllTime: number | null;
  ufcBouts: number;
  /** Which score to feed the tier classifier. `current` (default) falls back
   *  to all-time when the current score is null; `all_time` reads all-time
   *  only. Used by leaderboards that toggle between the two views. */
  scoreMode?: "current" | "all_time";
}

function computeTier(args: ClassifyArgs): VertexTier {
  if (args.ufcBouts < 3) return "unranked";
  if (args.vertexScore == null && args.vertexScoreAllTime == null) {
    return "unranked";
  }

  const referenceScore =
    args.scoreMode === "all_time"
      ? args.vertexScoreAllTime ?? 0
      : args.vertexScore ?? args.vertexScoreAllTime ?? 0;

  if (referenceScore >= 80) return "apex";
  if (referenceScore >= 60) return "elite";
  if (referenceScore >= 40) return "veteran";
  return "roster";
}

function computeChampionStatus(slug: string): ChampionStatus {
  if (isActiveChampion(slug)) return "active";
  if (isDominantChampion(slug)) return "dominant";
  if (isFormerChampion(slug)) return "former";
  return "none";
}

export function classifyFighter(args: ClassifyArgs): FighterClassification {
  return {
    tier: computeTier(args),
    championStatus: computeChampionStatus(args.slug),
    isDoubleChampion: isDoubleChampionHelper(args.slug),
  };
}

// =====================================================================
// Tier visual config
// =====================================================================

export interface TierStyle {
  tier: VertexTier;
  label: string;
  badgeText: string;
  /** Solid fill behind the badge. */
  badgeBg: string;
  /** Foreground colour for the tier label AND the numeric score so the
   *  score visually reinforces the tier hue. */
  badgeTextColor: string;
  /** Subtle accent stroke around the badge. */
  badgeBorder: string;
}

// Explicit per-tier OKLCH triples (no color-mix). Each tier reads as a
// distinct hue on dark backgrounds:
//   Apex     purple/violet  — GOAT territory
//   Elite    blue           — championship class
//   Veteran  teal-grey      — solid pro
//   Roster   slate          — long-tail roster
export const TIER_STYLES: Record<VertexTier, TierStyle> = {
  apex: {
    tier: "apex",
    label: "Apex",
    badgeText: "APEX",
    badgeBg: "oklch(0.30 0.18 295)",
    badgeTextColor: "oklch(0.92 0.10 295)",
    badgeBorder: "oklch(0.55 0.20 295)",
  },
  elite: {
    tier: "elite",
    label: "Elite",
    badgeText: "ELITE",
    badgeBg: "oklch(0.28 0.14 235)",
    badgeTextColor: "oklch(0.88 0.10 235)",
    badgeBorder: "oklch(0.55 0.18 235)",
  },
  veteran: {
    tier: "veteran",
    label: "Veteran",
    badgeText: "VETERAN",
    badgeBg: "oklch(0.28 0.05 200)",
    badgeTextColor: "oklch(0.78 0.06 200)",
    badgeBorder: "oklch(0.45 0.07 200)",
  },
  roster: {
    tier: "roster",
    label: "Roster",
    badgeText: "ROSTER",
    badgeBg: "oklch(0.22 0.01 240)",
    badgeTextColor: "oklch(0.65 0.02 240)",
    badgeBorder: "oklch(0.35 0.02 240)",
  },
  unranked: {
    tier: "unranked",
    label: "Unranked",
    badgeText: "",
    badgeBg: "transparent",
    badgeTextColor: "transparent",
    badgeBorder: "transparent",
  },
};

export function getTierStyle(tier: VertexTier): TierStyle {
  return TIER_STYLES[tier];
}

// =====================================================================
// Champion visual config (border + glow + crown)
// =====================================================================

export interface ChampionStyle {
  status: ChampionStatus;
  label: string;
  borderColor: string;
  borderWidth: number;
  /** Outer-glow OKLCH (with alpha) or null. */
  glowColor: string | null;
  /** Box-shadow size template, e.g. "0 0 32px". Null when no glow. */
  glowSize: string | null;
  badgeText: string;
  hasCrown: boolean;
  /** Crown icon fill — null when no crown. */
  crownColor: string | null;
}

// Active vs. Dominant vs. Former: each step down one tier reduces border
// width, glow size, and crown brightness so the visual hierarchy is
// readable at a glance even before the user reads the score.
export const CHAMPION_STYLES: Record<ChampionStatus, ChampionStyle> = {
  active: {
    status: "active",
    label: "Active Champion",
    borderColor: "oklch(0.85 0.18 75)", // bright vibrant gold
    borderWidth: 4,
    glowColor: "oklch(0.82 0.18 75 / 0.5)",
    glowSize: "0 0 32px",
    badgeText: "ACTIVE CHAMPION",
    hasCrown: true,
    crownColor: "oklch(0.92 0.18 78)",
  },
  dominant: {
    status: "dominant",
    label: "Dominant Champion",
    borderColor: "oklch(0.72 0.15 70)", // standard gold
    borderWidth: 2,
    glowColor: "oklch(0.70 0.13 70 / 0.25)",
    glowSize: "0 0 18px",
    badgeText: "DOMINANT CHAMPION",
    hasCrown: true,
    crownColor: "oklch(0.78 0.15 72)",
  },
  former: {
    status: "former",
    label: "Former Champion",
    borderColor: "oklch(0.55 0.08 75)", // antique faded gold
    borderWidth: 1,
    glowColor: null,
    glowSize: null,
    badgeText: "FORMER CHAMPION",
    hasCrown: false,
    crownColor: null,
  },
  none: {
    status: "none",
    label: "",
    borderColor: "transparent",
    borderWidth: 0,
    glowColor: null,
    glowSize: null,
    badgeText: "",
    hasCrown: false,
    crownColor: null,
  },
};

export function getChampionStyle(status: ChampionStatus): ChampionStyle {
  return CHAMPION_STYLES[status];
}

/** Convenience — returns classification + both visual configs in one call. */
export function classifyAndStyle(args: ClassifyArgs): {
  classification: FighterClassification;
  tierStyle: TierStyle;
  championStyle: ChampionStyle;
} {
  const classification = classifyFighter(args);
  return {
    classification,
    tierStyle: getTierStyle(classification.tier),
    championStyle: getChampionStyle(classification.championStatus),
  };
}
