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
// Canonical headline-score rule — the single source of truth for
// "which number do we broadcast for this fighter, everywhere".
// =====================================================================

/** roster.watch membership (fighter.roster_status). 'active' = currently
 *  rostered; the headline rule treats retired/released/inactive alike. */
export type RosterStatus =
  | "active"
  | "retired"
  | "released"
  | "inactive"
  | "unknown";

const RETIRED_ROSTER_STATUSES: ReadonlySet<RosterStatus> = new Set([
  "retired",
  "released",
  "inactive",
]);

export interface HeadlineScoreInput {
  /** fighter.roster_status (string for ergonomics; unknown values → active). */
  rosterStatus: string | null;
  /** Per-division CURRENT score for the fighter's active division
   *  (fighter_divisional_score where division = current_division AND
   *  in_active_ranking). Null when the fighter has no such row. */
  divisionalScore: number | null;
  /** Global CURRENT score (fighter.vertex_score — NULL for many inactive
   *  fighters and <5-bout careers). */
  vertexScore: number | null;
  /** Global ALL-TIME score (fighter.vertex_score_all_time). */
  vertexScoreAllTime: number | null;
}

export interface HeadlineScore {
  /** The single number every surface should render (pre-clamp). Null → "—". */
  value: number | null;
  /** Tier-classification mode that matches `value` — feed this straight into
   *  classifyAndStyle so the colour always agrees with the number. */
  scoreMode: "current" | "all_time";
  /** Where `value` came from. Callers that change layout by source (e.g. the
   *  profile hero drops its Current octagon when basis === "all_time") read
   *  this; pure number surfaces can ignore it. */
  basis: "divisional" | "global" | "all_time";
}

/**
 * The canonical Vertex headline — one number, identical on every surface
 * (search palette, catalog cards, profile hero, compare, …):
 *
 *   • RETIRED / released / inactive → ALL-TIME. Any stale `vertex_score`
 *     these fighters still carry (108 of them as of the Wave-rating audit)
 *     is intentionally ignored — a retired legend headlines their legacy
 *     rating, never a decayed near-zero current value.
 *   • ACTIVE / unknown → CURRENT: divisional score for their active division
 *     when present, else the global current score, else an all-time fallback
 *     (102 active fighters carry only an all-time score).
 *
 * Tier classification MUST consume the returned `{ value, scoreMode }` so the
 * ring/tier colour matches the displayed number. Keep this the ONLY place the
 * rule lives — surfaces calling their own ad-hoc coalesce is exactly what
 * produced the search-≠-profile divergence.
 */
export function headlineScore(input: HeadlineScoreInput): HeadlineScore {
  const status = (input.rosterStatus ?? "unknown") as RosterStatus;
  if (RETIRED_ROSTER_STATUSES.has(status)) {
    // Retired/released/inactive headline their ALL-TIME legacy rating, never a
    // decayed current value (see the rule note above). But when a retired
    // fighter has NO all-time score at all (short careers, fresh imports), a
    // bare "—" is strictly worse than their stale current score — fall back to
    // it so the surface still shows a number. scoreMode/basis follow the source
    // so the tier colour keeps agreeing with the displayed value.
    if (input.vertexScoreAllTime != null) {
      return {
        value: input.vertexScoreAllTime,
        scoreMode: "all_time",
        basis: "all_time",
      };
    }
    if (input.vertexScore != null) {
      return { value: input.vertexScore, scoreMode: "current", basis: "global" };
    }
    return { value: null, scoreMode: "all_time", basis: "all_time" };
  }
  if (input.divisionalScore != null) {
    return {
      value: input.divisionalScore,
      scoreMode: "current",
      basis: "divisional",
    };
  }
  if (input.vertexScore != null) {
    return { value: input.vertexScore, scoreMode: "current", basis: "global" };
  }
  return {
    value: input.vertexScoreAllTime,
    scoreMode: "all_time",
    basis: "all_time",
  };
}

/** Clamp a raw score to the 0–100 integer the UI renders. Raw all-time values
 *  can exceed 100 for sort ordering; the tier breaks are calibrated on [0,100]. */
export function clampHeadline(value: number | null): number | null {
  return value == null ? null : Math.min(100, Math.max(0, Math.round(value)));
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
  /** Same hue as `gradientFrom` but with alpha pre-boosted ~2.2× for
   *  champion cards — the tier wash needs to feel like a status step
   *  above peers, not the same. Pre-computed at the CSS-variable layer
   *  because `gradientFrom` is now a `var(...)` token and the runtime
   *  regex-bumper can't introspect those. */
  gradientFromChampion: string;
  /** Bottom stop — usually the same hue at 0 alpha so the gradient fades
   *  to transparent ~70% down the card. */
  gradientTo: string;
  /** Colour for the large score number rendered bottom-right of the card.
   *  Brighter than the gradient so the number reads against the tinted bg. */
  scoreColor: string;
}

// Tier gradients drive the card backgrounds and were tuned against the
// dark surface — purple at 0.18 alpha disappears into a near-black bg, but
// the same value lights up a near-white surface. We route every theme-
// sensitive colour through a CSS variable so :root[data-theme="light"] can
// dial it down without touching this file.
//
// Each tier reads as a distinct hue:
//   Apex        purple/violet — GOAT territory
//   Elite       blue          — championship class
//   Established teal-grey     — solid pro
//   Roster      slate         — long-tail roster
export const TIER_STYLES: Record<VertexTier, TierStyle> = {
  apex: {
    tier: "apex",
    label: "Apex",
    badgeText: "APEX",
    badgeBg: "var(--tier-apex-badge-bg)",
    badgeTextColor: "var(--tier-apex-badge-text)",
    badgeBorder: "var(--tier-apex-badge-border)",
    gradientFrom: "var(--tier-apex-gradient-from)",
    gradientFromChampion: "var(--tier-apex-gradient-from-champion)",
    gradientTo: "var(--tier-apex-gradient-to)",
    scoreColor: "var(--tier-apex-score)",
  },
  elite: {
    tier: "elite",
    label: "Elite",
    badgeText: "ELITE",
    badgeBg: "var(--tier-elite-badge-bg)",
    badgeTextColor: "var(--tier-elite-badge-text)",
    badgeBorder: "var(--tier-elite-badge-border)",
    gradientFrom: "var(--tier-elite-gradient-from)",
    gradientFromChampion: "var(--tier-elite-gradient-from-champion)",
    gradientTo: "var(--tier-elite-gradient-to)",
    scoreColor: "var(--tier-elite-score)",
  },
  established: {
    tier: "established",
    label: "Established",
    badgeText: "ESTABLISHED",
    badgeBg: "var(--tier-established-badge-bg)",
    badgeTextColor: "var(--tier-established-badge-text)",
    badgeBorder: "var(--tier-established-badge-border)",
    gradientFrom: "var(--tier-established-gradient-from)",
    gradientFromChampion: "var(--tier-established-gradient-from-champion)",
    gradientTo: "var(--tier-established-gradient-to)",
    scoreColor: "var(--tier-established-score)",
  },
  roster: {
    tier: "roster",
    label: "Roster",
    badgeText: "ROSTER",
    badgeBg: "var(--tier-roster-badge-bg)",
    badgeTextColor: "var(--tier-roster-badge-text)",
    badgeBorder: "var(--tier-roster-badge-border)",
    gradientFrom: "var(--tier-roster-gradient-from)",
    gradientFromChampion: "var(--tier-roster-gradient-from-champion)",
    gradientTo: "var(--tier-roster-gradient-to)",
    scoreColor: "var(--tier-roster-score)",
  },
  unranked: {
    tier: "unranked",
    label: "Unranked",
    badgeText: "",
    badgeBg: "transparent",
    badgeTextColor: "transparent",
    badgeBorder: "transparent",
    gradientFrom: "transparent",
    gradientFromChampion: "transparent",
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

