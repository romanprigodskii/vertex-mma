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
  /** OKLCH colour for the tier badge. `transparent` for unranked (no badge). */
  badgeColor: string;
  badgeText: string;
}

export const TIER_STYLES: Record<VertexTier, TierStyle> = {
  apex: {
    tier: "apex",
    label: "Apex",
    badgeColor: "oklch(0.72 0.20 290)", // Vertex purple
    badgeText: "APEX",
  },
  elite: {
    tier: "elite",
    label: "Elite",
    badgeColor: "oklch(0.65 0.12 270)", // deep purple-blue
    badgeText: "ELITE",
  },
  veteran: {
    tier: "veteran",
    label: "Veteran",
    badgeColor: "oklch(0.55 0.06 240)", // teal grey
    badgeText: "VETERAN",
  },
  roster: {
    tier: "roster",
    label: "Roster",
    badgeColor: "oklch(0.45 0.02 240)", // slate
    badgeText: "ROSTER",
  },
  unranked: {
    tier: "unranked",
    label: "Unranked",
    badgeColor: "oklch(0 0 0 / 0)",
    badgeText: "",
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
  /** Outer-glow colour or null. */
  glowColor: string | null;
  badgeText: string;
  hasCrown: boolean;
}

export const CHAMPION_STYLES: Record<ChampionStatus, ChampionStyle> = {
  active: {
    status: "active",
    label: "Active Champion",
    borderColor: "oklch(0.82 0.18 70)", // bright gold
    borderWidth: 4,
    glowColor: "oklch(0.78 0.15 70 / 0.4)",
    badgeText: "ACTIVE CHAMPION",
    hasCrown: true,
  },
  dominant: {
    status: "dominant",
    label: "Dominant Champion",
    borderColor: "oklch(0.78 0.16 65)", // gold
    borderWidth: 3,
    glowColor: "oklch(0.75 0.14 70 / 0.3)",
    badgeText: "DOMINANT CHAMPION",
    hasCrown: true,
  },
  former: {
    status: "former",
    label: "Former Champion",
    borderColor: "oklch(0.62 0.10 75)", // antique gold
    borderWidth: 2,
    glowColor: null,
    badgeText: "FORMER CHAMPION",
    hasCrown: false,
  },
  none: {
    status: "none",
    label: "",
    borderColor: "transparent",
    borderWidth: 0,
    glowColor: null,
    badgeText: "",
    hasCrown: false,
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
