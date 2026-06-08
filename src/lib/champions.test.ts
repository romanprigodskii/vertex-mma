/**
 * Tests for the champions strip derived from championship-history.ts.
 *   pnpm test
 *
 * The whole point of deriving CURRENT_CHAMPIONS is that it can't drift from the
 * reign data, so the core invariant is: membership === an open reign. These
 * tests also pin the specific corrections from the b06 audit so a future hand
 * edit (or a stale reign) can't silently reintroduce them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHAMPION_BY_SLUG, CHAMPION_SLUGS, CURRENT_CHAMPIONS } from "./champions";
import { CHAMPIONSHIP_HISTORY, isCurrentChampion } from "./championship-history";

describe("CURRENT_CHAMPIONS (derived)", () => {
  it("contains exactly the fighters with an open reign", () => {
    const openSlugs = new Set(
      CHAMPIONSHIP_HISTORY.filter((r) => r.endDate === null).map((r) => r.slug),
    );
    const listSlugs = new Set(CURRENT_CHAMPIONS.map((c) => c.slug));
    assert.deepEqual([...listSlugs].sort(), [...openSlugs].sort());
  });

  it("only lists fighters isCurrentChampion() agrees are active", () => {
    for (const c of CURRENT_CHAMPIONS) {
      assert.equal(isCurrentChampion(c.slug), true, `${c.slug} should be active`);
    }
  });

  it("drops champions who lost or vacated (Pereira, Chimaev, Zhang)", () => {
    for (const slug of [
      "alex-pereira-e5549c",
      "khamzat-chimaev-767755",
      "zhang-weili-1ebe20",
    ]) {
      assert.equal(CHAMPION_BY_SLUG.has(slug), false, `${slug} is stale`);
      assert.equal(isCurrentChampion(slug), false, `${slug} has no open reign`);
    }
  });

  it("reflects the current LHW and MW champions", () => {
    assert.equal(CHAMPION_BY_SLUG.get("carlos-ulberg-9014c0")?.divisionShort, "LHW");
    assert.equal(CHAMPION_BY_SLUG.get("sean-strickland-0d8011")?.divisionShort, "MW");
  });

  it("labels the women's champions by their real division", () => {
    // Dern is strawweight (was mislabeled W-BW); Harrison holds W-BW.
    assert.equal(CHAMPION_BY_SLUG.get("mackenzie-dern-7447e9")?.divisionShort, "W-SW");
    assert.equal(CHAMPION_BY_SLUG.get("kayla-harrison-1af117")?.divisionShort, "W-BW");
  });

  it("preserves the interim flag for interim reigns only", () => {
    assert.equal(CHAMPION_BY_SLUG.get("justin-gaethje-9e8f6c")?.isInterim, true);
    assert.equal(CHAMPION_BY_SLUG.get("ilia-topuria-54f64b")?.isInterim, undefined);
  });

  it("keeps the derived helper exports in sync", () => {
    assert.equal(CHAMPION_SLUGS.length, CURRENT_CHAMPIONS.length);
    assert.equal(CHAMPION_BY_SLUG.size, CURRENT_CHAMPIONS.length);
  });
});
