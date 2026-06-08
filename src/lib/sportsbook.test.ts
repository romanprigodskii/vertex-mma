/**
 * Unit tests for the Vertex Sportsbook fixed-odds engine.
 *
 * Runs on Node's built-in test runner via tsx (no extra deps):
 *   pnpm test            # node --import tsx --test 'src/**\/*.test.ts'
 *
 * These functions decide every payout, so they get tight coverage: margin /
 * overround correctness, odds clamps, method reconciliation, and the full
 * settlement truth table (win/loss/void, draw, no-contest, DQ, decision vs
 * finish, round totals).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HOUSE_MARGIN,
  MAX_MARKET_EDGE,
  MAX_ODDS,
  MIN_ODDS,
  MAX_PARLAY_ODDS,
  VALUE_EDGE_THRESHOLD,
  type BoutResult,
  type SportsbookSimInput,
  applyEdgeGuard,
  combineParlayOdds,
  computeSportsbookOutcomes,
  hasValueEdge,
  isBoutBettable,
  marketProbFromOdds,
  methodBucket,
  modelEdgeForSide,
  oddsForMarket,
  potentialPayout,
  reconcileMethodProbs,
  resolveParlay,
  settleSelection,
} from "./sportsbook";

const A = "fighter-a";
const B = "fighter-b";

function baseResult(over: Partial<BoutResult> = {}): BoutResult {
  return {
    status: "completed",
    winnerId: A,
    fighterAId: A,
    fighterBId: B,
    method: "ko",
    roundFinished: 1,
    ...over,
  };
}

describe("oddsForMarket — margin + clamps", () => {
  it("applies ~HOUSE_MARGIN overround to a balanced 2-way book", () => {
    const odds = oddsForMarket([0.5, 0.5]);
    // implied = (0.5)*(1+m) each → sum of implied = 1+m
    const impliedSum = 1 / odds[0] + 1 / odds[1];
    // Odds are rounded to 2 decimals for display, so the book sums to
    // 1+margin only approximately.
    assert.ok(Math.abs(impliedSum - (1 + HOUSE_MARGIN)) < 0.01, `impliedSum=${impliedSum}`);
    // 0.5 fair → 2.00 fair → shaded below 2.00 by the margin
    assert.ok(odds[0] < 2.0 && odds[0] > 1.8);
  });

  it("favourite gets shorter odds than the dog", () => {
    const [oFav, oDog] = oddsForMarket([0.8, 0.2]);
    assert.ok(oFav < oDog);
    assert.ok(oFav > 1 && oDog > 1);
  });

  it("caps long-shot odds at MAX_ODDS and never below MIN_ODDS", () => {
    const odds = oddsForMarket([0.999, 0.001]);
    assert.equal(odds[1], MAX_ODDS); // ~0.1% prop capped
    assert.ok(odds[0] >= MIN_ODDS);
  });

  it("handles a 6-way method book summing to 1+margin in implied terms", () => {
    const probs = [0.3, 0.05, 0.1, 0.25, 0.05, 0.25];
    const odds = oddsForMarket(probs);
    const impliedSum = odds.reduce((a, o) => a + 1 / o, 0);
    // Some cells may hit the MAX_ODDS clamp, but with these inputs none do,
    // so the book should sum to ~1+margin (loose: 2-decimal odds rounding).
    assert.ok(Math.abs(impliedSum - (1 + HOUSE_MARGIN)) < 0.01, `impliedSum=${impliedSum}`);
  });

  it("degenerate all-zero book falls back to MIN_ODDS, never NaN/Infinity", () => {
    const odds = oddsForMarket([0, 0]);
    odds.forEach((o) => assert.ok(Number.isFinite(o) && o >= MIN_ODDS));
  });
});

describe("reconcileMethodProbs", () => {
  it("rescales each side's method cells to sum to the ensemble win prob", () => {
    const m = reconcileMethodProbs(
      {
        probKoA: 0.4,
        probSubA: 0.1,
        probDecisionA: 0.1, // MC A-side sums to 0.6
        probKoB: 0.1,
        probSubB: 0.1,
        probDecisionB: 0.2, // MC B-side sums to 0.4
        finishByRound: [0.3, 0.2, 0.1],
      },
      0.7, // ensemble A
      0.3, // ensemble B
    );
    const aSum = m.a_ko + m.a_sub + m.a_dec;
    const bSum = m.b_ko + m.b_sub + m.b_dec;
    assert.ok(Math.abs(aSum - 0.7) < 1e-9, `aSum=${aSum}`);
    assert.ok(Math.abs(bSum - 0.3) < 1e-9, `bSum=${bSum}`);
    // mix preserved: A's KO share was 0.4/0.6 of A
    assert.ok(Math.abs(m.a_ko - 0.7 * (0.4 / 0.6)) < 1e-9);
  });

  it("degenerate (all-zero) MC side splits the ensemble prob evenly", () => {
    const m = reconcileMethodProbs(
      {
        probKoA: 0,
        probSubA: 0,
        probDecisionA: 0,
        probKoB: 1,
        probSubB: 0,
        probDecisionB: 0,
        finishByRound: [1],
      },
      0.6,
      0.4,
    );
    assert.ok(Math.abs(m.a_ko - 0.2) < 1e-9);
    assert.ok(Math.abs(m.a_sub - 0.2) < 1e-9);
    assert.ok(Math.abs(m.a_dec - 0.2) < 1e-9);
  });
});

describe("computeSportsbookOutcomes", () => {
  const sim: SportsbookSimInput = {
    probA: 0.65,
    probB: 0.35,
    rounds: {
      probKoA: 0.3,
      probKoB: 0.1,
      probSubA: 0.05,
      probSubB: 0.05,
      probDecisionA: 0.3,
      probDecisionB: 0.2,
      finishByRound: [0.2, 0.15, 0.1, null, null],
    },
  };

  it("winner-only when no MC rounds", () => {
    const out = computeSportsbookOutcomes({ probA: 0.6, probB: 0.4, rounds: null });
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((o) => o.code).sort(), ["win_a", "win_b"]);
  });

  it("full board = 12 outcomes (2 winner + 6 method + 2 totals + 2 distance)", () => {
    const out = computeSportsbookOutcomes(sim);
    assert.equal(out.length, 12);
    const byKind = (k: string) => out.filter((o) => o.marketKind === k).length;
    assert.equal(byKind("winner"), 2);
    assert.equal(byKind("method"), 6);
    assert.equal(byKind("total_rounds"), 2);
    assert.equal(byKind("distance"), 2);
  });

  it("every outcome has finite odds within the clamp band", () => {
    for (const o of computeSportsbookOutcomes(sim)) {
      assert.ok(o.decimalOdds >= MIN_ODDS && o.decimalOdds <= MAX_ODDS, `${o.code}=${o.decimalOdds}`);
      assert.ok(o.prob > 0 && o.prob < 1);
    }
  });

  it("favourite (A) winner odds are shorter than the underdog (B)", () => {
    const out = computeSportsbookOutcomes(sim);
    const a = out.find((o) => o.code === "win_a")!;
    const b = out.find((o) => o.code === "win_b")!;
    assert.ok(a.decimalOdds < b.decimalOdds);
  });

  it("Under 2.5 prob = P(finish R1)+P(finish R2)", () => {
    const out = computeSportsbookOutcomes(sim);
    const u = out.find((o) => o.code === "u2_5")!;
    assert.ok(Math.abs(u.prob - (0.2 + 0.15)) < 1e-9);
  });
});

describe("methodBucket", () => {
  it("maps the bout_method enum to buckets", () => {
    assert.equal(methodBucket("ko"), "ko");
    assert.equal(methodBucket("tko"), "ko");
    assert.equal(methodBucket("submission"), "sub");
    assert.equal(methodBucket("decision_unanimous"), "dec");
    assert.equal(methodBucket("decision_split"), "dec");
    assert.equal(methodBucket("draw"), "draw");
    assert.equal(methodBucket("no_contest"), "nc");
    assert.equal(methodBucket("dq"), "dq");
    assert.equal(methodBucket(null), "unknown");
  });
});

describe("settleSelection — winner", () => {
  it("A wins by KO: win_a won, win_b lost", () => {
    const r = baseResult({ winnerId: A, method: "ko" });
    assert.equal(settleSelection("win_a", r), "won");
    assert.equal(settleSelection("win_b", r), "lost");
  });
  it("draw voids both winner sides", () => {
    const r = baseResult({ winnerId: null, method: "draw", roundFinished: 3 });
    assert.equal(settleSelection("win_a", r), "void");
    assert.equal(settleSelection("win_b", r), "void");
  });
  it("no-contest voids everything", () => {
    const r = baseResult({ winnerId: null, method: "no_contest", status: "no_contest" });
    assert.equal(settleSelection("win_a", r), "void");
    assert.equal(settleSelection("a_ko", r), "void");
    assert.equal(settleSelection("o2_5", r), "void");
    assert.equal(settleSelection("dist_yes", r), "void");
  });
});

describe("settleSelection — method", () => {
  it("A by KO hits a_ko, misses a_sub/a_dec/b_*", () => {
    const r = baseResult({ winnerId: A, method: "tko", roundFinished: 2 });
    assert.equal(settleSelection("a_ko", r), "won");
    assert.equal(settleSelection("a_sub", r), "lost");
    assert.equal(settleSelection("a_dec", r), "lost");
    assert.equal(settleSelection("b_ko", r), "lost");
  });
  it("A by decision hits a_dec", () => {
    const r = baseResult({ winnerId: A, method: "decision_unanimous", roundFinished: 3 });
    assert.equal(settleSelection("a_dec", r), "won");
    assert.equal(settleSelection("a_ko", r), "lost");
  });
  it("B by submission hits b_sub", () => {
    const r = baseResult({ winnerId: B, method: "submission", roundFinished: 2 });
    assert.equal(settleSelection("b_sub", r), "won");
    assert.equal(settleSelection("a_sub", r), "lost");
  });
  it("DQ voids all method bets but the winner still settles", () => {
    const r = baseResult({ winnerId: A, method: "dq", roundFinished: 2 });
    assert.equal(settleSelection("a_ko", r), "void");
    assert.equal(settleSelection("b_dec", r), "void");
    assert.equal(settleSelection("win_a", r), "won");
  });
  it("draw voids method bets", () => {
    const r = baseResult({ winnerId: null, method: "draw", roundFinished: 3 });
    assert.equal(settleSelection("a_dec", r), "void");
  });
});

describe("settleSelection — total rounds O/U 2.5", () => {
  it("finish in R1 → Under wins", () => {
    const r = baseResult({ method: "ko", roundFinished: 1 });
    assert.equal(settleSelection("u2_5", r), "won");
    assert.equal(settleSelection("o2_5", r), "lost");
  });
  it("finish in R2 → Under wins", () => {
    const r = baseResult({ method: "submission", roundFinished: 2 });
    assert.equal(settleSelection("u2_5", r), "won");
  });
  it("finish in R3 → Over wins", () => {
    const r = baseResult({ method: "ko", roundFinished: 3 });
    assert.equal(settleSelection("o2_5", r), "won");
    assert.equal(settleSelection("u2_5", r), "lost");
  });
  it("decision → Over wins (went the distance)", () => {
    const r = baseResult({ winnerId: A, method: "decision_split", roundFinished: 3 });
    assert.equal(settleSelection("o2_5", r), "won");
    assert.equal(settleSelection("u2_5", r), "lost");
  });
  it("draw → Over wins (full distance)", () => {
    const r = baseResult({ winnerId: null, method: "draw", roundFinished: 3 });
    assert.equal(settleSelection("o2_5", r), "won");
  });
  it("finish with missing round → void", () => {
    const r = baseResult({ method: "ko", roundFinished: null });
    assert.equal(settleSelection("u2_5", r), "void");
    assert.equal(settleSelection("o2_5", r), "void");
  });
});

describe("settleSelection — goes the distance", () => {
  it("decision → dist_yes won", () => {
    const r = baseResult({ winnerId: A, method: "decision_unanimous", roundFinished: 5 });
    assert.equal(settleSelection("dist_yes", r), "won");
    assert.equal(settleSelection("dist_no", r), "lost");
  });
  it("draw → dist_yes won (fight went the distance)", () => {
    const r = baseResult({ winnerId: null, method: "draw", roundFinished: 3 });
    assert.equal(settleSelection("dist_yes", r), "won");
    assert.equal(settleSelection("dist_no", r), "lost");
  });
  it("KO finish → dist_no won", () => {
    const r = baseResult({ method: "ko", roundFinished: 1 });
    assert.equal(settleSelection("dist_no", r), "won");
    assert.equal(settleSelection("dist_yes", r), "lost");
  });
  it("DQ finish → dist_no won", () => {
    const r = baseResult({ winnerId: A, method: "dq", roundFinished: 2 });
    assert.equal(settleSelection("dist_no", r), "won");
  });
});

describe("marketProbFromOdds (devig)", () => {
  it("devigs a 2-way moneyline", () => {
    const p = marketProbFromOdds(1.85, 2.15)!;
    // 1/1.85=.5405, 1/2.15=.4651 → .5405/(.5405+.4651)=.5375
    assert.ok(Math.abs(p - 0.5375) < 0.002, `p=${p}`);
  });
  it("heavy favourite devigs above 0.5", () => {
    assert.ok(marketProbFromOdds(1.12, 6.0)! > 0.8);
  });
  it("null on missing/invalid sides", () => {
    assert.equal(marketProbFromOdds(null, 2.0), null);
    assert.equal(marketProbFromOdds(1.0, 2.0), null);
    assert.equal(marketProbFromOdds(1.85, null), null);
  });
});

describe("applyEdgeGuard", () => {
  it("no market line → model prob unchanged (pure model)", () => {
    assert.equal(applyEdgeGuard(0.28, null), 0.28);
  });
  it("within the band → unchanged", () => {
    // model 0.50 vs market 0.54, gap 0.04 < 0.15
    assert.equal(applyEdgeGuard(0.5, 0.54), 0.5);
  });
  it("clamps a wild underdog call up to market − maxEdge (the Belal case)", () => {
    // model 0.28 vs market 0.54 → clamp to 0.54 − 0.15 = 0.39
    assert.ok(Math.abs(applyEdgeGuard(0.28, 0.54) - 0.39) < 1e-9);
  });
  it("clamps an over-confident call down to market + maxEdge", () => {
    assert.ok(Math.abs(applyEdgeGuard(0.95, 0.6) - (0.6 + MAX_MARKET_EDGE)) < 1e-9);
  });
  it("respects a custom maxEdge", () => {
    assert.ok(Math.abs(applyEdgeGuard(0.28, 0.54, 0.1) - 0.44) < 1e-9);
  });
});

describe("computeSportsbookOutcomes — edge-guard wiring", () => {
  const base: SportsbookSimInput = { probA: 0.28, probB: 0.72, rounds: null };
  it("with no marketProbA, win_a reflects the raw model prob", () => {
    const wa = computeSportsbookOutcomes(base).find((o) => o.code === "win_a")!;
    assert.ok(Math.abs(wa.prob - 0.28) < 1e-6);
  });
  it("with a market line, win_a is pulled into the ±band (Belal)", () => {
    const wa = computeSportsbookOutcomes({ ...base, marketProbA: 0.54 }).find(
      (o) => o.code === "win_a",
    )!;
    assert.ok(Math.abs(wa.prob - 0.39) < 1e-6, `prob=${wa.prob}`);
    // win_b is the complement of the guarded prob
    const wb = computeSportsbookOutcomes({ ...base, marketProbA: 0.54 }).find(
      (o) => o.code === "win_b",
    )!;
    assert.ok(Math.abs(wb.prob - 0.61) < 1e-6, `prob=${wb.prob}`);
  });
  it("guarded prob also rescales the method level", () => {
    const sim: SportsbookSimInput = {
      probA: 0.28,
      probB: 0.72,
      marketProbA: 0.54,
      rounds: {
        probKoA: 0.2, probKoB: 0.4, probSubA: 0.04, probSubB: 0.12,
        probDecisionA: 0.04, probDecisionB: 0.2, finishByRound: [0.3, 0.2, 0.1],
      },
    };
    const out = computeSportsbookOutcomes(sim);
    const aMethods = out.filter((o) => o.marketKind === "method" && o.side === "a");
    const aSum = aMethods.reduce((s, o) => s + o.prob, 0);
    // A's three method cells should sum to the GUARDED prob (0.39), not 0.28
    assert.ok(Math.abs(aSum - 0.39) < 0.02, `aSum=${aSum}`);
  });
});

describe("modelEdgeForSide + hasValueEdge", () => {
  it("edge for A is edgeA; for B it flips sign", () => {
    assert.equal(modelEdgeForSide(0.1, "a"), 0.1);
    assert.ok(Math.abs(modelEdgeForSide(0.1, "b")! + 0.1) < 1e-9);
    assert.equal(modelEdgeForSide(null, "a"), null);
  });
  it("flags the side the model rates above the market past the threshold", () => {
    // model rates A +10pp over market → value on A, not B
    assert.equal(hasValueEdge(0.1, "a"), true);
    assert.equal(hasValueEdge(0.1, "b"), false);
    // model rates B higher (edgeA negative) → value on B
    assert.equal(hasValueEdge(-0.1, "b"), true);
    assert.equal(hasValueEdge(-0.1, "a"), false);
  });
  it("below threshold → no badge; null edge → no badge", () => {
    assert.equal(hasValueEdge(VALUE_EDGE_THRESHOLD - 0.01, "a"), false);
    assert.equal(hasValueEdge(VALUE_EDGE_THRESHOLD, "a"), true);
    assert.equal(hasValueEdge(null, "a"), false);
  });
});

describe("combineParlayOdds", () => {
  it("multiplies leg odds, rounded to 2dp", () => {
    assert.equal(combineParlayOdds([1.85, 2.0]), 3.7);
    assert.equal(combineParlayOdds([1.5, 1.5, 1.5]), 3.38); // 3.375 → 3.38
  });
  it("empty → 1", () => {
    assert.equal(combineParlayOdds([]), 1);
  });
  it("caps at MAX_PARLAY_ODDS", () => {
    assert.equal(combineParlayOdds(Array(10).fill(5)), MAX_PARLAY_ODDS);
  });
});

describe("resolveParlay", () => {
  it("all legs win → stake × product", () => {
    const r = resolveParlay(
      [
        { status: "won", odds: 1.85 },
        { status: "won", odds: 2.0 },
      ],
      100,
    );
    assert.equal(r.status, "won");
    assert.equal(r.payout, 370); // 100 × 3.70
  });
  it("any leg lost → parlay lost, payout 0", () => {
    const r = resolveParlay(
      [
        { status: "won", odds: 1.85 },
        { status: "lost", odds: 2.0 },
        { status: "won", odds: 1.5 },
      ],
      100,
    );
    assert.equal(r.status, "lost");
    assert.equal(r.payout, 0);
  });
  it("a void leg drops out and combined odds recompute over survivors", () => {
    const r = resolveParlay(
      [
        { status: "won", odds: 1.85 },
        { status: "void", odds: 2.0 }, // pushed → excluded
        { status: "won", odds: 2.0 },
      ],
      100,
    );
    assert.equal(r.status, "won");
    assert.equal(r.payout, 370); // 100 × (1.85 × 2.0), void leg ignored
  });
  it("all legs void → refund the stake", () => {
    const r = resolveParlay(
      [
        { status: "void", odds: 1.85 },
        { status: "void", odds: 2.0 },
      ],
      100,
    );
    assert.equal(r.status, "void");
    assert.equal(r.payout, 100);
  });
  it("single surviving won leg pays like a straight bet", () => {
    const r = resolveParlay(
      [
        { status: "void", odds: 2.0 },
        { status: "won", odds: 1.5 },
      ],
      100,
    );
    assert.equal(r.status, "won");
    assert.equal(r.payout, 150);
  });
});

describe("potentialPayout + isBoutBettable", () => {
  it("payout floors stake × odds", () => {
    assert.equal(potentialPayout(100, 1.85), 185);
    assert.equal(potentialPayout(33, 2.33), 76); // 76.89 → 76
  });
  it("bettable only while scheduled and before the event starts", () => {
    const future = "2999-01-01 00:00:00+00";
    const past = "2000-01-01 00:00:00+00";
    assert.equal(isBoutBettable("scheduled", future), true);
    assert.equal(isBoutBettable("scheduled", past), false);
    assert.equal(isBoutBettable("completed", future), false);
    assert.equal(isBoutBettable("scheduled", null), false);
  });
  it("honours the actual timezone offset, never forcing UTC", () => {
    // The same instant rendered by Postgres `::text` under different DB
    // session timezones: 14:00Z == 09:00-05 == 19:30+05:30. The cutoff must
    // be identical regardless of how the offset is rendered — the old
    // slice(0,19)+"Z" parse misread the two non-UTC forms by their offset.
    const before = new Date("2026-06-20T13:00:00Z"); // 1h before the bout
    for (const d of [
      "2026-06-20 14:00:00+00",
      "2026-06-20 09:00:00-05",
      "2026-06-20 19:30:00+05:30",
    ]) {
      assert.equal(isBoutBettable("scheduled", d, before), true, `open: ${d}`);
    }
    const after = new Date("2026-06-20T14:01:00Z"); // 1min after real start
    for (const d of [
      "2026-06-20 14:00:00+00",
      "2026-06-20 09:00:00-05",
      "2026-06-20 19:30:00+05:30",
    ]) {
      assert.equal(isBoutBettable("scheduled", d, after), false, `closed: ${d}`);
    }
  });
});
