/**
 * Vertex Score classifier — Wave 3.5 step 4A.2.
 *
 * Tier (score-based) and Champion status (history-based) are independent
 * dimensions. A fighter has BOTH simultaneously:
 *
 *   Islam Makhachev     → tier=Apex,     champion=active   (gold border + APEX badge)
 *   Jon Jones           → tier=Apex,     champion=dominant (gold border + APEX badge)
 *   Israel Adesanya     → tier=Established, champion=dominant (gold border + ESTABLISHED badge)
 *   Donald Cerrone      → tier=Established, champion=none     (no border + ESTABLISHED badge)
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
  | "apex" // score >= 75
  | "elite" // score 55-74
  | "established" // score 35-54
  | "roster" // score < 35
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

  if (referenceScore >= 75) return "apex";
  if (referenceScore >= 55) return "elite";
  if (referenceScore >= 35) return "established";
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
  /** Solid fill behind the legacy badge (still exported for any callers that
   *  haven't migrated to the gradient + score representation). */
  badgeBg: string;
  badgeTextColor: string;
  badgeBorder: string;
  /** Top-of-card tint (OKLCH with alpha). Used as the `from` stop of a
   *  linear-gradient(180deg, ...) layered over the card background. */
  gradientFrom: string;
  /** Bottom stop — usually the same hue at 0 alpha so the gradient fades
   *  to transparent ~70% down the card. */
  gradientTo: string;
  /** Colour for the large score number rendered bottom-right of the card.
   *  Brighter than the gradient so the number reads against the tinted bg. */
  scoreColor: string;
}

// Tier visual values now resolve to @theme tokens (see globals.css —
// --color-tier-apex / -elite / -established / -roster). Variant A from
// the tier-direction preview: four retuned hues sitting on the warm
// Sodium surface, roster warmed to surface hue.
//
// scoreColor and badgeBorder are the only fields the live components
// (FighterCard, fighter-result-card, ScoreShapes) consume. The other
// fields (badgeBg / badgeTextColor / gradientFrom / gradientTo) are
// retained for back-compat with any older callers and now alias to
// the same per-tier token; their pre-rebrand lightness/chroma
// variations were never read off the live surface.
export const TIER_STYLES: Record<VertexTier, TierStyle> = {
  apex: {
    tier: "apex",
    label: "Apex",
    badgeText: "APEX",
    badgeBg: "var(--color-tier-apex)",
    badgeTextColor: "var(--color-tier-apex)",
    badgeBorder: "var(--color-tier-apex)",
    gradientFrom: "var(--color-tier-apex)",
    gradientTo: "var(--color-tier-apex)",
    scoreColor: "var(--color-tier-apex)",
  },
  elite: {
    tier: "elite",
    label: "Elite",
    badgeText: "ELITE",
    badgeBg: "var(--color-tier-elite)",
    badgeTextColor: "var(--color-tier-elite)",
    badgeBorder: "var(--color-tier-elite)",
    gradientFrom: "var(--color-tier-elite)",
    gradientTo: "var(--color-tier-elite)",
    scoreColor: "var(--color-tier-elite)",
  },
  established: {
    tier: "established",
    label: "Established",
    badgeText: "ESTABLISHED",
    badgeBg: "var(--color-tier-established)",
    badgeTextColor: "var(--color-tier-established)",
    badgeBorder: "var(--color-tier-established)",
    gradientFrom: "var(--color-tier-established)",
    gradientTo: "var(--color-tier-established)",
    scoreColor: "var(--color-tier-established)",
  },
  roster: {
    tier: "roster",
    label: "Roster",
    badgeText: "ROSTER",
    badgeBg: "var(--color-tier-roster)",
    badgeTextColor: "var(--color-tier-roster)",
    badgeBorder: "var(--color-tier-roster)",
    gradientFrom: "var(--color-tier-roster)",
    gradientTo: "var(--color-tier-roster)",
    scoreColor: "var(--color-tier-roster)",
  },
  unranked: {
    tier: "unranked",
    label: "Unranked",
    badgeText: "",
    badgeBg: "transparent",
    badgeTextColor: "transparent",
    badgeBorder: "transparent",
    gradientFrom: "transparent",
    gradientTo: "transparent",
    scoreColor: "transparent",
  },
};

export function getTierStyle(tier: VertexTier): TierStyle {
  return TIER_STYLES[tier];
}

// =====================================================================
// Champion visual config (border + crown)
// =====================================================================

export interface ChampionStyle {
  status: ChampionStatus;
  label: string;
  /** Gold border colour, used as a fallback for the 2× double-champion
   *  badge edge in FighterCard. */
  borderColor: string;
  badgeText: string;
  hasCrown: boolean;
  /** Crown icon fill — null when no crown. */
  crownColor: string | null;
}

// Champion gold survives the rebrand as a real-world belt signifier
// (intentional override of "kill all amber"). Active and dominant
// now resolve to @theme tokens — see --color-champion-active and
// --color-champion-dominant in globals.css. Former stays on its raw
// antique-gold value because nothing reads it visibly today (former
// has hasCrown: false, so the borderColor is never painted).
export const CHAMPION_STYLES: Record<ChampionStatus, ChampionStyle> = {
  active: {
    status: "active",
    label: "Active Champion",
    borderColor: "var(--color-champion-active)",
    badgeText: "ACTIVE CHAMPION",
    hasCrown: true,
    crownColor: "var(--color-champion-active)",
  },
  dominant: {
    status: "dominant",
    label: "Dominant Champion",
    borderColor: "var(--color-champion-dominant)",
    badgeText: "DOMINANT CHAMPION",
    hasCrown: true,
    crownColor: "var(--color-champion-dominant)",
  },
  former: {
    status: "former",
    label: "Former Champion",
    borderColor: "oklch(0.55 0.08 75)", // antique faded gold (unused at render time)
    badgeText: "FORMER CHAMPION",
    hasCrown: false,
    crownColor: null,
  },
  none: {
    status: "none",
    label: "",
    borderColor: "transparent",
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
