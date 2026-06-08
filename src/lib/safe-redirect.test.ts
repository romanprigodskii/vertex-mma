/**
 * Tests for safeNext — the post-auth open-redirect guard.
 *   pnpm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { safeNext } from "./safe-redirect";

describe("safeNext", () => {
  it("passes through safe same-origin relative paths", () => {
    assert.equal(safeNext("/ok"), "/ok");
    assert.equal(safeNext("/me/predictions"), "/me/predictions");
    assert.equal(safeNext("/fighters?weight=lw&sort=wins"), "/fighters?weight=lw&sort=wins");
    assert.equal(safeNext("/news#latest"), "/news#latest");
  });

  it("falls back to / for empty / nullish input", () => {
    assert.equal(safeNext(null), "/");
    assert.equal(safeNext(undefined), "/");
    assert.equal(safeNext(""), "/");
  });

  it("blocks absolute and scheme URLs", () => {
    assert.equal(safeNext("https://evil.com"), "/");
    assert.equal(safeNext("http://evil.com/path"), "/");
    assert.equal(safeNext("javascript:alert(1)"), "/");
    assert.equal(safeNext("relative-no-slash"), "/");
  });

  it("blocks protocol-relative and backslash tricks", () => {
    assert.equal(safeNext("//evil"), "/");
    assert.equal(safeNext("//evil.com/path"), "/");
    assert.equal(safeNext("/\\evil"), "/");
    assert.equal(safeNext("/\\/evil"), "/");
  });

  it("blocks control-character smuggling (encoded and literal)", () => {
    // %09 = TAB, %0a = LF — the WHATWG URL parser strips these, so a leading
    // control char + // would otherwise resolve to host=evil.
    assert.equal(safeNext("/%09//evil"), "/");
    assert.equal(safeNext("/%0a//evil"), "/");
    assert.equal(safeNext("/\n//evil"), "/");
    assert.equal(safeNext("\t//evil"), "/");
    assert.equal(safeNext("/\t/\t/evil.com"), "/");
  });

  it("rejects malformed percent-escapes", () => {
    assert.equal(safeNext("/foo%ZZbar"), "/");
  });

  it("preserves encoded query/path characters (no double-decode)", () => {
    // searchParams.get() already decoded once; safeNext must not decode again
    // and corrupt encoded delimiters in a legitimate target.
    assert.equal(safeNext("/path?a=%26b%3Dc"), "/path?a=%26b%3Dc");
    assert.equal(safeNext("/cards/a%2Fb"), "/cards/a%2Fb");
  });

  it("keeps Unicode-whitespace-prefixed targets same-origin", () => {
    // C1 / format chars (NEL, ZWSP, BOM, NBSP) are NOT stripped by the URL
    // parser, so they stay inside the path — the result must remain a
    // same-origin path, never protocol-relative.
    for (const cp of [0x85, 0x200b, 0xfeff, 0xa0]) {
      const out = safeNext("/" + String.fromCharCode(cp) + "//evil.com");
      assert.ok(out.startsWith("/"), `cp=${cp.toString(16)} -> ${out}`);
      assert.ok(!out.startsWith("//"), `cp=${cp.toString(16)} -> ${out}`);
    }
  });
});
