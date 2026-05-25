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

// Explicit per-tier OKLCH triples (no color-mix). Each tier reads as a
// distinct hue on dark backgrounds:
//   Apex        purple/violet  — GOAT territory
//   Elite       blue           — championship class
//   Established  teal-grey     — solid pro
//   Roster      slate          — long-tail roster
export const TIER_STYLES: Record<VertexTier, TierStyle> = {
  apex: {
    tier: "apex",
    label: "Apex",
    badgeText: "APEX",
    badgeBg: "oklch(0.30 0.18 295)",
    badgeTextColor: "oklch(0.92 0.10 295)",
    badgeBorder: "oklch(0.55 0.20 295)",
    gradientFrom: "oklch(0.45 0.22 295 / 0.18)",
    gradientTo: "oklch(0.45 0.22 295 / 0)",
    scoreColor: "oklch(0.85 0.18 295)",
  },
  elite: {
    tier: "elite",
    label: "Elite",
    badgeText: "ELITE",
    badgeBg: "oklch(0.28 0.14 235)",
    badgeTextColor: "oklch(0.88 0.10 235)",
    badgeBorder: "oklch(0.55 0.18 235)",
    gradientFrom: "oklch(0.45 0.18 235 / 0.16)",
    gradientTo: "oklch(0.45 0.18 235 / 0)",
    scoreColor: "oklch(0.82 0.16 235)",
  },
  established: {
    tier: "established",
    label: "Established",
    badgeText: "ESTABLISHED",
    badgeBg: "oklch(0.28 0.05 200)",
    badgeTextColor: "oklch(0.78 0.06 200)",
    badgeBorder: "oklch(0.45 0.07 200)",
    gradientFrom: "oklch(0.50 0.08 200 / 0.12)",
    gradientTo: "oklch(0.50 0.08 200 / 0)",
    scoreColor: "oklch(0.75 0.07 200)",
  },
  roster: {
    tier: "roster",
    label: "Roster",
    badgeText: "ROSTER",
    badgeBg: "oklch(0.22 0.01 240)",
    badgeTextColor: "oklch(0.65 0.02 240)",
    badgeBorder: "oklch(0.35 0.02 240)",
    gradientFrom: "oklch(0.45 0.02 240 / 0.08)",
    gradientTo: "oklch(0.45 0.02 240 / 0)",
    scoreColor: "oklch(0.62 0.03 240)",
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
// Champion visual config (border + glow + crown)
// =====================================================================

export interface ChampionStyle {
  status: ChampionStatus;
  label: string;
  // Deprecated as of Wave 6F — champion visual moved to gradient density +
  // warm tint in FighterCard. Retained on the type for potential future
  // surfaces (event hero, share preview) that may want the bordered look.
  borderColor: string;
  borderWidth: number;
  /** Outer-glow OKLCH (with alpha) or null. Deprecated as of Wave 6F. */
  glowColor: string | null;
  /** Box-shadow size template, e.g. "0 0 32px". Deprecated as of Wave 6F. */
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

/**
 * Multiply the alpha channel of an OKLCH(L C h / a) color string. Clamps to
 * [0, 1]. Returns the input unchanged when no alpha is present (no-op for
 * `transparent`, named colors, or hex). Used by FighterCard to deepen the
 * tier gradient for champions without recoloring the hue (Wave 6F).
 *
 * Input forms supported:
 *   oklch(0.45 0.22 295 / 0.18)
 *   oklch(0.45 0.22 295 / .18)
 *   oklch(0.45 0.22 295 / 18%)
 */
export function boostAlpha(color: string, factor: number): string {
  const m = color.match(
    /^oklch\(\s*([^\s)]+)\s+([^\s)]+)\s+([^\s)]+)\s*\/\s*([0-9.]+)(%?)\s*\)$/i,
  );
  if (!m) return color;
  const [, l, c, h, alphaStr, pct] = m;
  const base = pct === "%" ? Number(alphaStr) / 100 : Number(alphaStr);
  if (!Number.isFinite(base)) return color;
  const next = Math.min(1, Math.max(0, base * factor));
  return `oklch(${l} ${c} ${h} / ${next.toFixed(3)})`;
}
