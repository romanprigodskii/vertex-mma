/**
 * Unit tests for the LMSR money math — the bookmaker's pricing core.
 *
 * Runs on Node's built-in test runner via tsx (no extra deps):
 *   pnpm test            # node --import tsx --test 'src/**\/*.test.ts'
 *
 * These functions decide what every trade costs and what every payout is, so
 * they get the tightest coverage in the codebase: price normalisation, cost
 * monotonicity, buy/cost round-tripping, numerical stability, and the guard
 * rails that keep the house from leaking (or minting) coins.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  logSumExp,
  lmsrBuyCost,
  lmsrCost,
  lmsrPrices,
  lmsrSharesForCoins,
  priceToDecimalOdds,
  sharesFromTargetProbs,
} from "./lmsr";

const B = 100;

describe("logSumExp", () => {
  it("returns -Infinity for the empty set", () => {
    assert.equal(logSumExp([]), -Infinity);
  });

  it("matches the naive computation for small inputs", () => {
    const vals = [0.5, -1.2, 2.0];
    const naive = Math.log(vals.reduce((a, v) => a + Math.exp(v), 0));
    assert.ok(Math.abs(logSumExp(vals) - naive) < 1e-12);
  });

  it("is numerically stable for large magnitudes (no overflow)", () => {
    // exp(1000) overflows to Infinity; the subtract-max trick must avoid it.
    const r = logSumExp([1000, 1000]);
    assert.ok(Number.isFinite(r));
    assert.ok(Math.abs(r - (1000 + Math.log(2))) < 1e-9);
  });
});

describe("lmsrPrices", () => {
  it("returns a uniform distribution when shares are equal", () => {
    const p = lmsrPrices([0, 0], B);
    assert.ok(Math.abs(p[0] - 0.5) < 1e-12);
    assert.ok(Math.abs(p[1] - 0.5) < 1e-12);
  });

  it("always produces a normalised probability vector", () => {
    for (const shares of [[10, 0], [0, 250], [5, 5, 5], [300, 1, 50]]) {
      const p = lmsrPrices(shares, B);
      const sum = p.reduce((a, c) => a + c, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, `sum=${sum} for ${shares}`);
      for (const x of p) assert.ok(x >= 0 && x <= 1);
    }
  });

  it("assigns a higher price to the outcome with more shares", () => {
    const p = lmsrPrices([200, 0], B);
    assert.ok(p[0] > p[1]);
  });

  it("throws when b <= 0", () => {
    assert.throws(() => lmsrPrices([1, 1], 0));
  });
});

describe("lmsrCost", () => {
  it("is monotonically increasing as shares of an outcome grow", () => {
    let prev = lmsrCost([0, 0], B);
    for (const q of [10, 50, 100, 500]) {
      const cur = lmsrCost([q, 0], B);
      assert.ok(cur > prev, `cost should grow: ${cur} <= ${prev}`);
      prev = cur;
    }
  });

  it("throws when b <= 0", () => {
    assert.throws(() => lmsrCost([1, 1], -1));
  });
});

describe("lmsrBuyCost", () => {
  it("returns a positive cost for a positive delta", () => {
    assert.ok(lmsrBuyCost([0, 0], B, 0, 10) > 0);
  });

  it("is monotonically increasing in delta", () => {
    let prev = 0;
    for (const d of [1, 10, 100, 1000]) {
      const c = lmsrBuyCost([0, 0], B, 0, d);
      assert.ok(c > prev, `buy cost should grow: ${c} <= ${prev}`);
      prev = c;
    }
  });

  it("never exceeds the LMSR worst-case bound b*ln(N) above marginal", () => {
    // Buying a huge amount of one outcome can cost at most that outcome's
    // share delta plus b*ln(N); sanity-check the cost stays finite & sane.
    const cost = lmsrBuyCost([0, 0], B, 0, 10_000);
    assert.ok(Number.isFinite(cost));
    assert.ok(cost < 10_000 + B * Math.log(2) + 1);
  });

  it("throws on a non-positive delta or an out-of-range index", () => {
    assert.throws(() => lmsrBuyCost([0, 0], B, 0, 0));
    assert.throws(() => lmsrBuyCost([0, 0], B, 5, 10));
  });
});

describe("lmsrSharesForCoins (the bisection inverse)", () => {
  it("returns 0 for a non-positive budget", () => {
    assert.equal(lmsrSharesForCoins([0, 0], B, 0, 0), 0);
    assert.equal(lmsrSharesForCoins([0, 0], B, 0, -5), 0);
  });

  it("round-trips: the cost of the solved shares ~ the budget", () => {
    for (const coins of [1, 10, 100, 1000, 50000]) {
      const shares = lmsrSharesForCoins([0, 0], B, 0, coins);
      assert.ok(shares > 0);
      const cost = lmsrBuyCost([0, 0], B, 0, shares);
      // Bisection converges to <1e-9; cost should be essentially the budget.
      assert.ok(Math.abs(cost - coins) < 1e-3, `coins=${coins} cost=${cost}`);
    }
  });

  it("buys more shares per coin on a cheaper (underpriced) outcome", () => {
    // Outcome 1 is the underdog (fewer shares -> lower price -> cheaper).
    const shares = [300, 0];
    const favShares = lmsrSharesForCoins(shares, B, 0, 100);
    const dogShares = lmsrSharesForCoins(shares, B, 1, 100);
    assert.ok(dogShares > favShares);
  });
});

describe("sharesFromTargetProbs", () => {
  it("produces shares that reproduce the target probabilities", () => {
    const target = [0.7, 0.3];
    const shares = sharesFromTargetProbs(target, B);
    const got = lmsrPrices(shares, B);
    assert.ok(Math.abs(got[0] - 0.7) < 1e-9);
    assert.ok(Math.abs(got[1] - 0.3) < 1e-9);
  });

  it("normalises inputs that don't sum to 1", () => {
    const shares = sharesFromTargetProbs([2, 1, 1], B); // -> 0.5, 0.25, 0.25
    const got = lmsrPrices(shares, B);
    assert.ok(Math.abs(got[0] - 0.5) < 1e-9);
    assert.ok(Math.abs(got[1] - 0.25) < 1e-9);
    assert.ok(Math.abs(got[2] - 0.25) < 1e-9);
  });

  it("anchors every share at >= 0", () => {
    const shares = sharesFromTargetProbs([0.9, 0.1], B);
    for (const s of shares) assert.ok(s >= 0);
  });

  it("returns [] for empty input and throws on zero/negative probs", () => {
    assert.deepEqual(sharesFromTargetProbs([], B), []);
    assert.throws(() => sharesFromTargetProbs([0, 0], B));
    assert.throws(() => sharesFromTargetProbs([0.5, 0], B)); // a 0-prob can't be expressed
    assert.throws(() => sharesFromTargetProbs([1, 1], 0)); // b must be > 0
  });
});

describe("priceToDecimalOdds", () => {
  it("converts valid prices to 1/price", () => {
    assert.equal(priceToDecimalOdds(0.5), "2.00");
    assert.equal(priceToDecimalOdds(0.2), "5.00");
    assert.equal(priceToDecimalOdds(0.8), "1.25");
  });

  it("returns the em-dash for degenerate / out-of-range prices", () => {
    assert.equal(priceToDecimalOdds(0), "—");
    assert.equal(priceToDecimalOdds(1), "—");
    assert.equal(priceToDecimalOdds(-0.1), "—");
    assert.equal(priceToDecimalOdds(Number.NaN), "—");
    assert.equal(priceToDecimalOdds(Infinity), "—");
  });
});
