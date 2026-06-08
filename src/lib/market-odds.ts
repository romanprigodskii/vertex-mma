/**
 * Whether a market has a REAL price yet, vs. sitting at the LMSR cold-start.
 *
 * A freshly generated market opens at the uniform 1/N default (a 2-way winner
 * shows exactly 50/50, a 6-way method shows ~16.7% each, etc.). That template
 * must never be rendered as if it were a real line — it makes the whole board
 * look dead/demo-like. A market becomes "priced" once it's either:
 *   - seeded from sportsbook consensus (prices become non-uniform), or
 *   - traded at least once (total_volume > 0, which also moves the prices).
 *
 * Pure + dependency-free so it's usable in both server and client components
 * (and unit-testable without booting the DB layer).
 */

// A real consensus is virtually never EXACTLY uniform, while the cold-start is.
// A small epsilon keeps a genuine ~even synced line (e.g. 0.52/0.48) visible
// while hiding the 0.5000 / 0.2500 / 0.1667 defaults. The spread comparison is
// INCLUSIVE (>=) so a real line that happens to land exactly on the epsilon
// boundary (a barely-split 0.505/0.495) is still treated as priced.
const UNIFORM_EPSILON = 0.01;

export function marketHasOdds(
  outcomes: ReadonlyArray<{ current_price: number }>,
  totalVolume = 0,
): boolean {
  if (totalVolume > 0) return true;
  if (outcomes.length < 2) return false;
  let min = Infinity;
  let max = -Infinity;
  for (const o of outcomes) {
    if (o.current_price < min) min = o.current_price;
    if (o.current_price > max) max = o.current_price;
  }
  return max - min >= UNIFORM_EPSILON;
}
