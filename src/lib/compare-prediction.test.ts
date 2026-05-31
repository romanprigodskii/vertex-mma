/**
 * Tests for the free Compare win-probability estimate.
 *   pnpm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { estimateWinProbability } from "./compare-prediction";

describe("estimateWinProbability", () => {
  it("returns 50/50 for equal scores", () => {
    const f = estimateWinProbability({ allTime: 80, current: 80 }, { allTime: 80, current: 80 });
    assert.ok(f);
    assert.ok(Math.abs(f.probA - 0.5) < 1e-9);
    assert.ok(Math.abs(f.probB - 0.5) < 1e-9);
  });

  it("favours the higher Vertex Score and probs sum to 1", () => {
    const f = estimateWinProbability({ allTime: 90, current: 88 }, { allTime: 75, current: 70 })!;
    assert.ok(f.probA > f.probB);
    assert.ok(f.probA > 0.5 && f.probA < 1);
    assert.ok(Math.abs(f.probA + f.probB - 1) < 1e-12);
  });

  it("is monotonic — a bigger gap means a bigger favourite", () => {
    const small = estimateWinProbability({ allTime: 85, current: null }, { allTime: 80, current: null })!;
    const big = estimateWinProbability({ allTime: 95, current: null }, { allTime: 80, current: null })!;
    assert.ok(big.probA > small.probA);
  });

  it("gives sane, non-degenerate spreads (10pt ~65%, 30pt ~87%)", () => {
    const ten = estimateWinProbability({ allTime: 90, current: null }, { allTime: 80, current: null })!;
    const thirty = estimateWinProbability({ allTime: 100, current: null }, { allTime: 70, current: null })!;
    assert.ok(ten.probA > 0.62 && ten.probA < 0.68);
    assert.ok(thirty.probA > 0.84 && thirty.probA < 0.9);
    assert.ok(thirty.probA < 1); // never certain
  });

  it("prefers all-time, falls back to current when an all-time score is missing", () => {
    const allTime = estimateWinProbability({ allTime: 88, current: 50 }, { allTime: 80, current: 50 })!;
    assert.equal(allTime.basis, "all_time");
    assert.equal(allTime.scoreA, 88);

    const fallback = estimateWinProbability({ allTime: null, current: 88 }, { allTime: 80, current: 80 })!;
    assert.equal(fallback.basis, "current");
    assert.equal(fallback.scoreA, 88);
    assert.equal(fallback.scoreB, 80);
  });

  it("returns null when neither score basis is usable", () => {
    assert.equal(estimateWinProbability({ allTime: null, current: null }, { allTime: 80, current: 80 }), null);
    assert.equal(estimateWinProbability({ allTime: 80, current: 80 }, { allTime: null, current: null }), null);
  });
});
