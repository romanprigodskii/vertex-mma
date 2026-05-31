/**
 * Tests for the cold-start detector that keeps placeholder odds off the board.
 *   pnpm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { marketHasOdds } from "./market-odds";

describe("marketHasOdds", () => {
  it("treats the 2-way winner cold-start (50/50) as unpriced", () => {
    assert.equal(marketHasOdds([{ current_price: 0.5 }, { current_price: 0.5 }]), false);
  });

  it("treats the 6-way method cold-start (~16.7% each) as unpriced", () => {
    const sixth = 1 / 6;
    assert.equal(
      marketHasOdds(Array.from({ length: 6 }, () => ({ current_price: sixth }))),
      false,
    );
  });

  it("treats a 4-way round cold-start (25% each) as unpriced", () => {
    assert.equal(
      marketHasOdds(Array.from({ length: 4 }, () => ({ current_price: 0.25 }))),
      false,
    );
  });

  it("treats a synced, non-uniform line as priced", () => {
    assert.equal(marketHasOdds([{ current_price: 0.84 }, { current_price: 0.16 }]), true);
    assert.equal(marketHasOdds([{ current_price: 0.62 }, { current_price: 0.38 }]), true);
  });

  it("counts any traded market as priced even if prices round back near even", () => {
    assert.equal(marketHasOdds([{ current_price: 0.5 }, { current_price: 0.5 }], 250), true);
  });

  it("keeps a genuinely close synced line (52/48) visible", () => {
    assert.equal(marketHasOdds([{ current_price: 0.52 }, { current_price: 0.48 }]), true);
  });

  it("is unpriced for degenerate empty/single outcome sets with no volume", () => {
    assert.equal(marketHasOdds([]), false);
    assert.equal(marketHasOdds([{ current_price: 1 }]), false);
  });
});
