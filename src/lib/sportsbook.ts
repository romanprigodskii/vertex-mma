/**
 * Vertex Sportsbook — fixed-odds betting engine.
 *
 * Unlike the LMSR prediction market (src/lib/lmsr.ts), the sportsbook offers
 * FIXED decimal odds derived from our own prediction model: the calibrated
 * winner probability (bout_simulation) plus the Monte-Carlo method / round
 * distribution (bout_simulation_rounds). The user stakes coins at the odds
 * shown; odds lock at bet time; payout = floor(stake × odds) if the
 * selection hits.
 *
 * Odds are PURE MODEL (no market blending — a deliberate product choice): the
 * book's edge comes entirely from the overround (HOUSE_MARGIN) baked into the
 * decimal odds, plus the MAX_ODDS cap that bounds payout on long-shot props.
 *
 * This module is intentionally DB-free so the money math is unit-tested in
 * isolation (src/lib/sportsbook.test.ts), exactly like the LMSR core.
 */

// =====================================================================
// Tunables
// =====================================================================

/** Overround baked into every market: fair probs are inflated to sum to
 *  1 + HOUSE_MARGIN before inverting to odds, so the book keeps ~6% on a
 *  balanced book. Bumping this widens the house edge across the board. */
export const HOUSE_MARGIN = 0.06;

/** Hard floor / ceiling on displayed decimal odds. The ceiling bounds the
 *  payout on ~0%-probability props (e.g. "by submission" when the model
 *  says 0.3%) so a single long-shot can't drain the coin economy. The floor
 *  keeps a near-certain favourite from paying out a meaningless 1.00x. */
export const MIN_ODDS = 1.04;
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
  /** Calibrated ensemble winner probabilities (sum ≈ 1). */
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

/** P(fight goes the distance) = 1 − P(any finish). Driven by the round
 *  finish distribution so it stays consistent with the totals market. */
function distanceProb(rounds: SportsbookRoundsInput): number {
  const finish = rounds.finishByRound.reduce<number>(
    (acc, r) => acc + (r ?? 0),
    0,
  );
  return clampProb(1 - finish);
}

// =====================================================================
// Margin → decimal odds
// =====================================================================

/**
 * Convert a market's fair probabilities into decimal odds with the house
 * overround applied. Each market is normalised independently so its book
 * sums to (1 + HOUSE_MARGIN) of implied probability, then inverted and
 * clamped to [MIN_ODDS, MAX_ODDS].
 *
 *   fair p_i → q_i = (p_i / Σp) · (1 + margin) → odds_i = 1 / q_i
 */
export function oddsForMarket(
  fairProbs: number[],
  margin = HOUSE_MARGIN,
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

  // ── Winner (moneyline) ───────────────────────────────────────────
  {
    const probs = [guardedA, guardedB];
    const odds = oddsForMarket(probs);
    out.push({ marketKind: "winner", code: "win_a", side: "a", prob: probs[0], decimalOdds: odds[0] });
    out.push({ marketKind: "winner", code: "win_b", side: "b", prob: probs[1], decimalOdds: odds[1] });
  }

  if (!sim.rounds) return out;
  const r = sim.rounds;

  // ── Method of victory (6-way: A/B × KO·Sub·Dec) ─────────────────
  {
    const m = reconcileMethodProbs(r, guardedA, guardedB);
    const probs = [m.a_ko, m.a_sub, m.a_dec, m.b_ko, m.b_sub, m.b_dec].map(clampProb);
    const odds = oddsForMarket(probs);
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

  // ── Total rounds: Over / Under 2.5 (whole-round basis) ───────────
  // Under 2.5 = finished in round 1 or 2. Over 2.5 = reached round 3+
  // OR went to a decision. Whole-round (not 2:30) basis to settle
  // unambiguously from round_finished + method.
  {
    const f1 = r.finishByRound[0] ?? 0;
    const f2 = r.finishByRound[1] ?? 0;
    const pUnder = clampProb(f1 + f2);
    const pOver = clampProb(1 - (f1 + f2));
    const odds = oddsForMarket([pOver, pUnder]);
    out.push({ marketKind: "total_rounds", code: "o2_5", side: null, prob: pOver, decimalOdds: odds[0] });
    out.push({ marketKind: "total_rounds", code: "u2_5", side: null, prob: pUnder, decimalOdds: odds[1] });
  }

  // ── Goes the distance: Yes / No ──────────────────────────────────
  {
    const pYes = distanceProb(r);
    const pNo = clampProb(1 - pYes);
    const odds = oddsForMarket([pYes, pNo]);
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

  const wentDistance = mb === "dec" || mb === "draw";

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
      if (mb === "dq") return "void"; // no KO/Sub/Dec bucket for a DQ
      const side = code[0] === "a" ? r.fighterAId : r.fighterBId;
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
