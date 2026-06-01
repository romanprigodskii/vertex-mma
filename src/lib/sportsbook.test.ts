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
  MAX_ODDS,
  MIN_ODDS,
  type BoutResult,
  type SportsbookSimInput,
  computeSportsbookOutcomes,
  isBoutBettable,
  methodBucket,
  oddsForMarket,
  potentialPayout,
  reconcileMethodProbs,
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
});
