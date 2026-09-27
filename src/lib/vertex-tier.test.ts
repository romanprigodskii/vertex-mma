/**
 * Tests for the division a fighter is labelled with.
 *   pnpm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { displayDivision } from "./vertex-tier";

describe("displayDivision", () => {
  it("names an active fighter by the division they fight in now", () => {
    assert.equal(
      displayDivision({
        rosterStatus: "active",
        currentDivision: "welterweight",
        weightClassPrimary: "lightweight",
      }),
      "welterweight",
    );
  });

  it("names a retired fighter by their career division, not a one-off last bout", () => {
    assert.equal(
      displayDivision({
        rosterStatus: "retired",
        currentDivision: "heavyweight",
        weightClassPrimary: "light_heavyweight",
      }),
      "light_heavyweight",
    );
  });

  it("skips a catchweight or openweight last bout", () => {
    for (const current of ["catchweight", "openweight"]) {
      assert.equal(
        displayDivision({
          rosterStatus: "active",
          currentDivision: current,
          weightClassPrimary: "flyweight",
        }),
        "flyweight",
      );
    }
  });

  it("falls back to the career division when there is no last bout", () => {
    assert.equal(
      displayDivision({
        rosterStatus: null,
        currentDivision: null,
        weightClassPrimary: "bantamweight",
      }),
      "bantamweight",
    );
  });
});
