/**
 * Vertex Sportsbook — fixed-odds betting engine.
 *
 * Unlike the LMSR prediction market (src/lib/lmsr.ts), the sportsbook offers
 * FIXED decimal odds derived from our own prediction model: the blended
 * winner probability (bout_simulation; model output, NOT post-hoc calibrated)
 * plus the Monte-Carlo method / round distribution (bout_simulation_rounds).
 * The user stakes coins at the odds
 * shown; odds lock at bet time; payout = floor(stake × odds) if the
 * selection hits.
 *
 * Odds are PURE MODEL (no market blending — a deliberate product choice) but
 * carry a TIERED overround (HOUSE_MARGIN_WINNER / HOUSE_MARGIN_PROP) so the
 * house holds a structural edge and the coin economy stays solvent — a no-vig
 * book is <=-EV for the house, worse the less calibrated the model. Every prop
 * market (method / totals / distance) is derived from ONE reconciled
 * distribution anchored to the edge-guarded winner prob, so the books can't be
 * arbitraged against each other. See scripts/backtest_sportsbook.ts for the
 * realized house-P&L check behind the margin choice.
 *
 * This module is intentionally DB-free so the money math is unit-tested in
 * isolation (src/lib/sportsbook.test.ts), exactly like the LMSR core.
 */

// =====================================================================
// Tunables
// =====================================================================

/** Overround (vig) baked into a market: its fair probs are inflated to sum to
 *  1 + margin before inverting to odds, so the house holds a structural edge.
 *  TIERED by how trustworthy the underlying model is:
 *   - winner is the best-calibrated market → light vig.
 *   - method / totals / distance ride the Monte-Carlo method+round split, the
 *     least reliable and most exploitable part of the model → heavier vig.
 *  (A no-vig book, both 0, is <=-EV for the house — the prior setting.) */
export const HOUSE_MARGIN_WINNER = 0.04;
export const HOUSE_MARGIN_PROP = 0.08;

/** Hard floor / ceiling on displayed decimal odds. The ceiling bounds the
 *  payout on ~0%-probability props (e.g. "by submission" when the model says
 *  0.3%) so a single long-shot can't drain the coin economy. The floor keeps a
 *  near-certain favourite from paying a meaningless 1.00x — but note it
 *  OVERPAYS on extreme favourites whose fair odds fall below MIN_ODDS (model
 *  p > 1/MIN_ODDS), a small −EV to the house. Kept low (1.02) so that overpay
 *  window is narrow and the house margin survives for realistic favourites; the
 *  MAX_ODDS cap + round-down on the long-shot side more than offset it across a
 *  full two-way book. */
export const MIN_ODDS = 1.02;
export const MAX_ODDS = 25;

/** Edge-guard: max distance (in probability) the model's winner prob may sit
 *  from the bookmaker consensus when one exists. Pure-model odds are the
 *  product (no blending), but a model that's wildly off the market — e.g. it
 *  put Belal Muhammad at 28% vs a 54% market — would otherwise hand bettors a
 *  huge +EV line. Where odds exist we clamp the model to ±this band around the
 *  devigged market prob; where they don't, the model is used unguarded. The
 *  model is only market-LEVEL out-of-sample (not proven better), so this is
 *  damage-control, not a profit cap — it bounds the worst case without
 *  neutralising genuine smaller edges. */
export const MAX_MARKET_EDGE = 0.15;

// =====================================================================
// Types
// =====================================================================

export type SportsbookMarketKind =
  | "winner"
  | "method"
  | "total_rounds"
  | "distance";

/** Every offerable selection code. The settlement logic and the UI both key
 *  off these exact strings, so they're the contract between bet placement
 *  and grading. */
export type SportsbookSelectionCode =
  | "win_a"
  | "win_b"
  | "a_ko"
  | "a_sub"
  | "a_dec"
  | "b_ko"
  | "b_sub"
  | "b_dec"
  | "o2_5"
  | "u2_5"
  | "dist_yes"
  | "dist_no";

export interface SportsbookOutcome {
  marketKind: SportsbookMarketKind;
  code: SportsbookSelectionCode;
  /** Which fighter the selection is about (winner / method), else null. */
  side: "a" | "b" | null;
  /** Fair model probability (post-floor, pre-margin) — shown as "model %". */
  prob: number;
  /** Locked decimal odds (post-margin, clamped). payout = floor(stake×odds). */
  decimalOdds: number;
}

/** Minimal slice of the Monte-Carlo round distribution the engine needs. */
export interface SportsbookRoundsInput {
  probKoA: number;
  probKoB: number;
  probSubA: number;
  probSubB: number;
  probDecisionA: number;
  probDecisionB: number;
  /** Index 0 = round 1 … P(fight finished IN that round, any method/side).
   *  null for rounds beyond the bout's scheduled length. */
  finishByRound: (number | null)[];
}

export interface SportsbookSimInput {
  /** Blended ensemble winner probabilities (sum ≈ 1). Model output — not
   *  post-hoc calibrated; the shipped weighted_mean blend is mildly
   *  under-dispersed (see scripts/simulation/src/ensemble.py). */
  probA: number;
  probB: number;
  /** Monte-Carlo method/round split. null → only the winner market is offered. */
  rounds: SportsbookRoundsInput | null;
  /** Devigged bookmaker consensus prob that A wins, if available. When set,
   *  the edge-guard clamps the model's winner prob to ±MAX_MARKET_EDGE of it.
   *  null → pure model (no market line for this bout). */
  marketProbA?: number | null;
}

// =====================================================================
// Probability helpers
// =====================================================================

function clampProb(p: number): number {
  if (!Number.isFinite(p) || p <= 0) return 1e-6;
  if (p >= 1) return 1 - 1e-6;
  return p;
}

/**
 * Reconcile the raw MC method probabilities so each side's three method
 * cells (ko/sub/dec) sum to the ENSEMBLE winner prob for that side, not the
 * MC's standalone winner prob. The ensemble (LightGBM + isotonic) is the
 * better model of WHICH fighter wins; the MC is the better model of HOW.
 * Keeps the MC's relative method MIX, rescales the LEVEL. Mirrors
 * reconcileMcMethodProbs in bout-simulation.ts but stays DB-free here.
 */
export function reconcileMethodProbs(
  rounds: SportsbookRoundsInput,
  probA: number,
  probB: number,
): {
  a_ko: number;
  a_sub: number;
  a_dec: number;
  b_ko: number;
  b_sub: number;
  b_dec: number;
} {
  const side = (
    ko: number,
    sub: number,
    dec: number,
    ensemble: number,
  ): [number, number, number] => {
    const total = ko + sub + dec;
    if (!(total > 0)) {
      // Degenerate MC side — split the ensemble prob evenly so the cells
      // still sum correctly and no method is offered at absurd odds.
      const third = ensemble / 3;
      return [third, third, third];
    }
    return [
      ensemble * (ko / total),
      ensemble * (sub / total),
      ensemble * (dec / total),
    ];
  };
  const [a_ko, a_sub, a_dec] = side(
    rounds.probKoA,
    rounds.probSubA,
    rounds.probDecisionA,
    probA,
  );
  const [b_ko, b_sub, b_dec] = side(
    rounds.probKoB,
    rounds.probSubB,
    rounds.probDecisionB,
    probB,
  );
  return { a_ko, a_sub, a_dec, b_ko, b_sub, b_dec };
}

/** Devigged 2-way market prob that A wins, from decimal moneyline odds.
 *  Returns null when either side is missing / invalid. */
export function marketProbFromOdds(
  aDecimal: number | null,
  bDecimal: number | null,
): number | null {
  if (!(typeof aDecimal === "number" && aDecimal > 1)) return null;
  if (!(typeof bDecimal === "number" && bDecimal > 1)) return null;
  const pa = 1 / aDecimal;
  const pb = 1 / bDecimal;
  const sum = pa + pb;
  if (!(sum > 0)) return null;
  return pa / sum;
}

/** Edge-guard: clamp the model's winner prob to ±maxEdge of the market when a
 *  market prob is available; otherwise return the model prob unchanged
 *  (pure model). See MAX_MARKET_EDGE. */
export function applyEdgeGuard(
  modelProbA: number,
  marketProbA: number | null,
  maxEdge = MAX_MARKET_EDGE,
): number {
  if (marketProbA == null || !Number.isFinite(marketProbA)) {
    return clampProb(modelProbA);
  }
  const lo = marketProbA - maxEdge;
  const hi = marketProbA + maxEdge;
  return clampProb(Math.min(hi, Math.max(lo, modelProbA)));
}

/** Threshold (probability points) at which the model's disagreement with the
 *  market is surfaced as a "value edge" badge on the winner market. The model
 *  is only market-LEVEL out-of-sample (calibration audit), so this flags
 *  "our model leans harder than the bookmakers here", NOT a guaranteed +EV. */
export const VALUE_EDGE_THRESHOLD = 0.07;

/** v0.8.0 debut gate: bouts with a UFC debutant are scored by the debut
 *  specialist, which is clearly WEAKER than the bookmakers on that segment
 *  (backtest log-loss ~0.64 vs market ~0.59 — books see regional-circuit
 *  records our pipeline has no data for). Offering house odds from that
 *  model alone would hand sharp users +EV, so debut bouts are bettable
 *  ONLY when a consensus line exists for the edge-guard to anchor prices
 *  to (±MAX_MARKET_EDGE). The same rule must gate BOTH display
 *  (sportsbook-board) and bet placement (markets/actions) — keep in sync. */
export function debutBoutBettable(
  anyDebut: boolean,
  marketProbA: number | null,
): boolean {
  return !anyDebut || (marketProbA != null && Number.isFinite(marketProbA));
}

/** Signed model-vs-market edge for one winner side, in probability (0–1).
 *  Positive = the model rates this side higher than the bookmaker consensus.
 *  `edgeA` is bout_simulation.edge_a = model_prob_a − market_prob_a; null when
 *  the bout has no market line. */
export function modelEdgeForSide(
  edgeA: number | null,
  side: "a" | "b",
): number | null {
  if (edgeA == null || !Number.isFinite(edgeA)) return null;
  return side === "a" ? edgeA : -edgeA;
}

/** Whether a winner side clears the value-edge threshold (badge-worthy). */
export function hasValueEdge(
  edgeA: number | null,
  side: "a" | "b",
  threshold = VALUE_EDGE_THRESHOLD,
): boolean {
  const e = modelEdgeForSide(edgeA, side);
  return e != null && e >= threshold;
}

// =====================================================================
// Margin → decimal odds
// =====================================================================

/**
 * Convert a market's fair probabilities into decimal odds with a house
 * overround applied. Each market is normalised independently so its book
 * sums to (1 + margin) of implied probability, then inverted and clamped to
 * [MIN_ODDS, MAX_ODDS]. Pass the market's tier (HOUSE_MARGIN_WINNER vs
 * HOUSE_MARGIN_PROP); defaults to the winner tier.
 *
 *   fair p_i → q_i = (p_i / Σp) · (1 + margin) → odds_i = 1 / q_i
 */
export function oddsForMarket(
  fairProbs: number[],
  margin = HOUSE_MARGIN_WINNER,
): number[] {
  const ps = fairProbs.map(clampProb);
  const sum = ps.reduce((a, c) => a + c, 0);
  if (!(sum > 0)) return ps.map(() => MIN_ODDS);
  return ps.map((p) => {
    const implied = (p / sum) * (1 + margin);
    const odds = 1 / implied;
    if (!Number.isFinite(odds)) return MAX_ODDS;
    return Math.min(MAX_ODDS, Math.max(MIN_ODDS, Math.round(odds * 100) / 100));
  });
}

// =====================================================================
// Build the full outcome board for a bout
// =====================================================================

/**
 * Compute every offerable outcome (winner / method / totals / distance) with
 * its locked decimal odds. The winner market always renders; method / totals
 * / distance require the Monte-Carlo `rounds` slice and are omitted when it's
 * missing (older predictions, MC not yet run).
 */
export function computeSportsbookOutcomes(
  sim: SportsbookSimInput,
): SportsbookOutcome[] {
  const out: SportsbookOutcome[] = [];

  // Edge-guard the winner prob against the market (no-op when no market line).
  // The guarded prob drives both the winner market AND the method level (via
  // reconciliation), so a market-blind model error can't escape through props.
  const guardedA = applyEdgeGuard(sim.probA, sim.marketProbA ?? null);
  const guardedB = clampProb(1 - guardedA);

  // ── Winner (moneyline) — light tier ──────────────────────────────
  {
    const probs = [guardedA, guardedB];
    const odds = oddsForMarket(probs, HOUSE_MARGIN_WINNER);
    out.push({ marketKind: "winner", code: "win_a", side: "a", prob: probs[0], decimalOdds: odds[0] });
    out.push({ marketKind: "winner", code: "win_b", side: "b", prob: probs[1], decimalOdds: odds[1] });
  }

  if (!sim.rounds) return out;
  const r = sim.rounds;

  // Single reconciled distribution for ALL props, anchored to the edge-guarded
  // winner prob. method P(decision), the totals split, and distance Yes/No are
  // ALL derived from this one source so they're mutually consistent — the old
  // code priced method off the reconciled probs but totals/distance off the RAW
  // finishByRound (whose Σ ≠ the reconciled finish total), which at zero margin
  // was a guaranteed cross-market +EV for the bettor.
  const m = reconcileMethodProbs(r, guardedA, guardedB);
  const decTotal = m.a_dec + m.b_dec; // P(goes to decision) = P(distance)
  const finishTotal = 1 - decTotal; // P(any KO/Sub, either side)
  // Rescale the per-round finish curve so it sums to the reconciled finish
  // total; this is what ties the totals market to method + distance.
  const rawFinish = r.finishByRound.reduce<number>((acc, x) => acc + (x ?? 0), 0);
  const finishScale = rawFinish > 0 ? finishTotal / rawFinish : 0;

  // ── Method of victory (6-way: A/B × KO·Sub·Dec) — prop tier ──────
  {
    const probs = [m.a_ko, m.a_sub, m.a_dec, m.b_ko, m.b_sub, m.b_dec].map(clampProb);
    const odds = oddsForMarket(probs, HOUSE_MARGIN_PROP);
    const codes: { code: SportsbookSelectionCode; side: "a" | "b" }[] = [
      { code: "a_ko", side: "a" },
      { code: "a_sub", side: "a" },
      { code: "a_dec", side: "a" },
      { code: "b_ko", side: "b" },
      { code: "b_sub", side: "b" },
      { code: "b_dec", side: "b" },
    ];
    codes.forEach((c, i) => {
      out.push({ marketKind: "method", code: c.code, side: c.side, prob: probs[i], decimalOdds: odds[i] });
    });
  }

  // ── Total rounds: Over / Under 2.5 (whole-round basis) — prop tier ─
  // Under 2.5 = finished in round 1 or 2. Over 2.5 = reached round 3+ OR went
  // to a decision. Built from the RESCALED finish curve so it agrees with the
  // method/distance markets. Skipped when the MC produced no finish mass to
  // split across rounds (can't price a round total without a round shape).
  if (rawFinish > 0) {
    const f1 = (r.finishByRound[0] ?? 0) * finishScale;
    const f2 = (r.finishByRound[1] ?? 0) * finishScale;
    const pUnder = clampProb(f1 + f2);
    const pOver = clampProb(1 - (f1 + f2));
    const odds = oddsForMarket([pOver, pUnder], HOUSE_MARGIN_PROP);
    out.push({ marketKind: "total_rounds", code: "o2_5", side: null, prob: pOver, decimalOdds: odds[0] });
    out.push({ marketKind: "total_rounds", code: "u2_5", side: null, prob: pUnder, decimalOdds: odds[1] });
  }

  // ── Goes the distance: Yes / No — prop tier ──────────────────────
  // pYes is exactly the method market's P(decision) (decTotal), so a bettor
  // can't arb "dist_yes" against "a_dec + b_dec".
  {
    const pYes = clampProb(decTotal);
    const pNo = clampProb(finishTotal);
    const odds = oddsForMarket([pYes, pNo], HOUSE_MARGIN_PROP);
    out.push({ marketKind: "distance", code: "dist_yes", side: null, prob: pYes, decimalOdds: odds[0] });
    out.push({ marketKind: "distance", code: "dist_no", side: null, prob: pNo, decimalOdds: odds[1] });
  }

  return out;
}

// =====================================================================
// Settlement
// =====================================================================

export type SettleStatus = "won" | "lost" | "void";

export interface BoutResult {
  /** bout.status — 'completed' | 'no_contest' | … */
  status: string;
  /** bout.winner_id (null on draw / NC / unresolved). */
  winnerId: string | null;
  fighterAId: string;
  fighterBId: string;
  /** bout.method enum text: ko, tko, submission, decision_unanimous|split|
   *  majority, draw, no_contest, dq. */
  method: string | null;
  /** Round the bout ended (null for unscored / data gaps). */
  roundFinished: number | null;
  /** Scheduled rounds (3 or 5). Lets a DRAW be graded for distance/totals by
   *  whether it actually reached the final round — a TECHNICAL draw can end
   *  early. Optional: when absent, a draw falls back to "went the distance"
   *  (the common decision-draw case). */
  scheduledRounds?: number | null;
}

type MethodBucket = "ko" | "sub" | "dec" | "dq" | "draw" | "nc" | "unknown";

export function methodBucket(method: string | null): MethodBucket {
  if (method == null) return "unknown";
  const m = method.toLowerCase();
  if (m === "ko" || m === "tko") return "ko";
  if (m === "submission") return "sub";
  if (m.startsWith("decision")) return "dec";
  if (m === "draw") return "draw";
  if (m === "no_contest") return "nc";
  if (m === "dq") return "dq";
  return "unknown";
}

/**
 * Grade one selection against a resolved bout. Returns:
 *   • "won"  — the selection hit → credit floor(stake × odds)
 *   • "lost" — the selection missed → no payout (stake already debited)
 *   • "void" — push / unsettleable → refund the stake
 *
 * Void rules: any No-Contest voids everything. A DRAW voids winner + method
 * (no winning fighter) but still settles distance/totals (the fight went the
 * full scheduled distance). A DQ voids method (no KO/Sub/Dec bucket) but
 * settles winner / totals / distance normally. Missing round data voids the
 * totals market only.
 */
export function settleSelection(
  code: SportsbookSelectionCode,
  r: BoutResult,
): SettleStatus {
  const mb = methodBucket(r.method);

  // Unresolved or No-Contest → refund everything.
  if (r.status === "no_contest" || mb === "nc" || mb === "unknown") {
    // 'unknown' (null method) on a non-completed bout means we can't grade
    // anything yet — caller should only invoke on resolved bouts, but void
    // is the safe answer if it slips through.
    if (mb === "unknown" && r.status === "completed" && r.winnerId != null) {
      // Completed with a winner but null method: grade winner-only, void rest.
      if (code === "win_a") return r.winnerId === r.fighterAId ? "won" : "lost";
      if (code === "win_b") return r.winnerId === r.fighterBId ? "won" : "lost";
    }
    return "void";
  }

  // A decision always went the full distance. A DRAW usually did too (a
  // decision draw), but a TECHNICAL draw can end early — if we know the
  // scheduled length and it stopped before the final round, it did NOT go the
  // distance. Absent scheduledRounds/roundFinished, fall back to "went distance".
  const drawWentDistance =
    r.roundFinished == null ||
    r.scheduledRounds == null ||
    r.roundFinished >= r.scheduledRounds;
  const wentDistance = mb === "dec" || (mb === "draw" && drawWentDistance);

  switch (code) {
    // ── Winner ──────────────────────────────────────────────────
    case "win_a":
      if (r.winnerId == null) return "void"; // draw / NC
      return r.winnerId === r.fighterAId ? "won" : "lost";
    case "win_b":
      if (r.winnerId == null) return "void";
      return r.winnerId === r.fighterBId ? "won" : "lost";

    // ── Method (fighter × bucket) ───────────────────────────────
    case "a_ko":
    case "a_sub":
    case "a_dec":
    case "b_ko":
    case "b_sub":
    case "b_dec": {
      if (r.winnerId == null) return "void"; // draw → no winning fighter
      const side = code[0] === "a" ? r.fighterAId : r.fighterBId;
      if (mb === "dq") {
        // A DQ has no KO/Sub/Dec bucket. A bet on the LOSER clearly lost; a bet
        // on the actual WINNER is void (he won, but not by a gradeable method).
        // (Old behaviour voided BOTH sides, refunding losing-side method bets.)
        return r.winnerId === side ? "void" : "lost";
      }
      const bucket = code.slice(2); // "ko" | "sub" | "dec"
      return r.winnerId === side && mb === bucket ? "won" : "lost";
    }

    // ── Total rounds O/U 2.5 (whole-round basis) ────────────────
    case "o2_5":
    case "u2_5": {
      // Decision / draw → fight went the full scheduled distance → Over.
      if (wentDistance) return code === "o2_5" ? "won" : "lost";
      // Finish (ko/sub/dq) → need the round it ended.
      if (r.roundFinished == null) return "void";
      const under = r.roundFinished <= 2;
      return code === "u2_5"
        ? under ? "won" : "lost"
        : under ? "lost" : "won";
    }

    // ── Goes the distance Yes / No ──────────────────────────────
    case "dist_yes":
      return wentDistance ? "won" : "lost";
    case "dist_no":
      return wentDistance ? "lost" : "won";

    default:
      return "void";
  }
}

// =====================================================================
// Display + payout helpers
// =====================================================================

/** payout (stake back + profit) if the selection wins. Floor so the book
 *  never hands out fractional-coin freebies. */
export function potentialPayout(stakeCoins: number, decimalOdds: number): number {
  return Math.floor(stakeCoins * decimalOdds);
}

// =====================================================================
// Parlays (accumulators)
// =====================================================================

export const MIN_PARLAY_LEGS = 2;
export const MAX_PARLAY_LEGS = 12;
/** Cap on combined odds so stake×odds can't overflow int4 (1M stake ×
 *  1000 = 1e9 < 2.1e9) and one lottery ticket can't drain the economy. */
export const MAX_PARLAY_ODDS = 1000;

/** Combined parlay odds = product of leg odds, rounded to 2dp and capped. */
export function combineParlayOdds(legOdds: number[]): number {
  if (legOdds.length === 0) return 1;
  const product = legOdds.reduce((acc, o) => acc * o, 1);
  if (!Number.isFinite(product)) return MAX_PARLAY_ODDS;
  return Math.min(MAX_PARLAY_ODDS, Math.round(product * 100) / 100);
}

export interface ParlayLegResult {
  status: SettleStatus;
  /** The leg's locked decimal odds (only used when it won). */
  odds: number;
}

export interface ParlayResolution {
  status: SettleStatus;
  payout: number;
}

/**
 * Resolve a parlay from its (fully-graded) legs:
 *   • any leg lost            → parlay lost, payout 0
 *   • all legs void (push)    → parlay void, refund the stake
 *   • else (≥1 won, rest void) → won; payout = floor(stake × Π won-leg odds)
 *     — void legs drop out and the combined odds recompute over survivors,
 *     standard sportsbook behaviour.
 *
 * Caller MUST ensure every leg is resolved (no 'open') before calling.
 */
export function resolveParlay(
  legs: ParlayLegResult[],
  stake: number,
): ParlayResolution {
  if (legs.some((l) => l.status === "lost")) return { status: "lost", payout: 0 };
  const won = legs.filter((l) => l.status === "won");
  if (won.length === 0) return { status: "void", payout: stake };
  const combined = combineParlayOdds(won.map((l) => l.odds));
  return { status: "won", payout: Math.floor(stake * combined) };
}

export interface SelectionDescriptor {
  marketKind: SportsbookMarketKind;
  /** Fighter the pick is about (winner/method); null otherwise. */
  side: "a" | "b" | null;
  /** Method bucket for the `method` market. */
  methodKey?: "ko" | "sub" | "dec";
  /** Over/Under for the `total_rounds` market. */
  totalKey?: "over" | "under";
  /** Yes/No for the `distance` market. */
  distanceKey?: "yes" | "no";
}

/** Structured, locale-free description of a selection code so the UI can
 *  localise it with the fighter names + a `sportsbook` i18n namespace. */
export function describeSelection(
  code: SportsbookSelectionCode,
): SelectionDescriptor {
  switch (code) {
    case "win_a":
      return { marketKind: "winner", side: "a" };
    case "win_b":
      return { marketKind: "winner", side: "b" };
    case "a_ko":
      return { marketKind: "method", side: "a", methodKey: "ko" };
    case "a_sub":
      return { marketKind: "method", side: "a", methodKey: "sub" };
    case "a_dec":
      return { marketKind: "method", side: "a", methodKey: "dec" };
    case "b_ko":
      return { marketKind: "method", side: "b", methodKey: "ko" };
    case "b_sub":
      return { marketKind: "method", side: "b", methodKey: "sub" };
    case "b_dec":
      return { marketKind: "method", side: "b", methodKey: "dec" };
    case "o2_5":
      return { marketKind: "total_rounds", side: null, totalKey: "over" };
    case "u2_5":
      return { marketKind: "total_rounds", side: null, totalKey: "under" };
    case "dist_yes":
      return { marketKind: "distance", side: null, distanceKey: "yes" };
    case "dist_no":
      return { marketKind: "distance", side: null, distanceKey: "no" };
  }
}

/** Plain-English label for a selection (for the OG image / non-localised
 *  contexts). The localised UI builds its own from `describeSelection` + the
 *  `sportsbook` i18n namespace. */
export function selectionLabelEn(
  code: SportsbookSelectionCode,
  fighterAName: string,
  fighterBName: string,
): string {
  const d = describeSelection(code);
  const name = d.side === "a" ? fighterAName : fighterBName;
  switch (d.marketKind) {
    case "winner":
      return name;
    case "method": {
      const m =
        d.methodKey === "ko"
          ? "by KO/TKO"
          : d.methodKey === "sub"
            ? "by submission"
            : "by decision";
      return `${name} ${m}`;
    }
    case "total_rounds":
      return d.totalKey === "over" ? "Over 2.5 rounds" : "Under 2.5 rounds";
    case "distance":
      return d.distanceKey === "yes" ? "Goes the distance" : "Doesn't go the distance";
  }
}

const ALL_SELECTION_CODES: SportsbookSelectionCode[] = [
  "win_a", "win_b",
  "a_ko", "a_sub", "a_dec", "b_ko", "b_sub", "b_dec",
  "o2_5", "u2_5",
  "dist_yes", "dist_no",
];

/** Runtime guard for an untrusted selection code coming off the wire. */
export function isSelectionCode(v: string): v is SportsbookSelectionCode {
  return (ALL_SELECTION_CODES as string[]).includes(v);
}

/** The fighter side ("a"/"b") a selection bets on, or null. Used to
 *  denormalise selected_fighter_id at placement. */
export function selectionSide(code: SportsbookSelectionCode): "a" | "b" | null {
  return describeSelection(code).side;
}

export function formatOdds(decimalOdds: number): string {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) return "—";
  return decimalOdds.toFixed(2);
}

/** True when a bout is open for sportsbook betting: still scheduled and the
 *  event hasn't started. `eventDate` is the event's ISO date string. */
export function isBoutBettable(
  status: string,
  eventDate: string | null,
  now = new Date(),
): boolean {
  if (status !== "scheduled") return false;
  if (!eventDate) return false;
  const start = new Date(eventDate.slice(0, 19).replace(" ", "T") + "Z");
  if (Number.isNaN(start.getTime())) return false;
  return start.getTime() > now.getTime();
}
