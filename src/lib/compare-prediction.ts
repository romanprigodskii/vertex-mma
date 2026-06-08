/**
 * FREE, lightweight win-probability estimate for the Compare tool.
 *
 * This is deliberately NOT the paid AI fight simulation. It answers only
 * "who's favoured and by how much" for ANY two fighters, using a simple
 * Elo-style logistic on the Vertex Score gap (the public 0–100 number every
 * fighter already has). The full ML simulation — finish method, round-by-round,
 * the 10,000-run Monte Carlo, and the "why the model thinks so" breakdown —
 * stays the premium Simulation feature. Compare gives the teaser; Simulation
 * gives the depth.
 */

// Scale of the logistic on the Vertex Score gap. Tuned so a ~10-pt gap reads
// as a clear favourite without ever pinning to 0/100:
//   gap  0 → 50%   gap 10 → ~65%   gap 20 → ~78%   gap 30 → ~87%
const SCORE_SCALE = 16;

export type CompareForecast = {
  /** P(fighter A wins), 0..1. */
  probA: number;
  /** P(fighter B wins), 0..1 (= 1 − probA). */
  probB: number;
  /** The two scores the estimate was computed from. */
  scoreA: number;
  scoreB: number;
  /** Which Vertex Score was used — all-time is fairer across eras. */
  basis: "all_time" | "current";
} | null;

type ScorePair = { allTime: number | null; current: number | null };

/** Shared logistic core — both public entry points resolve their two scores
 *  first, then hand off here so the probability curve lives in exactly one
 *  place. */
function logistic(
  scoreA: number,
  scoreB: number,
  basis: "all_time" | "current",
): NonNullable<CompareForecast> {
  const probA = 1 / (1 + Math.exp(-(scoreA - scoreB) / SCORE_SCALE));
  return { probA, probB: 1 - probA, scoreA, scoreB, basis };
}

/**
 * Estimate P(A beats B) from Vertex Scores. Prefers all-time (fair for
 * cross-era / retired-legend fantasy matchups), falls back to current.
 * Returns null when either fighter lacks a usable score (e.g. < 3 UFC bouts) —
 * the caller should then show a "not enough data" state rather than a fake 50/50.
 */
export function estimateWinProbability(a: ScorePair, b: ScorePair): CompareForecast {
  let scoreA = a.allTime;
  let scoreB = b.allTime;
  let basis: "all_time" | "current" = "all_time";
  if (scoreA == null || scoreB == null) {
    scoreA = a.current;
    scoreB = b.current;
    basis = "current";
  }
  if (scoreA == null || scoreB == null) return null;
  return logistic(scoreA, scoreB, basis);
}

/** Per-fighter headline input — the single resolved number plus which mode it
 *  represents, taken straight off `headlineScore` ({ value, scoreMode }). */
export type HeadlineScorePair = {
  value: number | null;
  mode: "current" | "all_time";
};

/**
 * Win-probability from the canonical HEADLINE scores — the SAME numbers the
 * Compare hero (ScoreCompare) and every card / profile / search surface
 * render. Use this instead of {@link estimateWinProbability} so the forecast
 * bar, its caption, and the hero never disagree: an active fighter's headline
 * is their *divisional* score, which the raw all-time/current scores fed to
 * estimateWinProbability never reflect.
 *
 * Each fighter carries its own headline mode, but the single caption can only
 * say one thing — so it reports "all-time" only when BOTH sides are all-time
 * (e.g. two retired legends) and "current" otherwise, matching the
 * live-by-default framing of any matchup involving an active fighter. Returns
 * null when either fighter has no usable headline value.
 */
export function estimateWinProbabilityFromHeadline(
  a: HeadlineScorePair,
  b: HeadlineScorePair,
): CompareForecast {
  if (a.value == null || b.value == null) return null;
  const basis: "all_time" | "current" =
    a.mode === "all_time" && b.mode === "all_time" ? "all_time" : "current";
  return logistic(a.value, b.value, basis);
}
