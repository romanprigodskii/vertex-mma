/**
 * LMSR helpers — Hanson's Logarithmic Market Scoring Rule.
 *
 * State for an N-outcome market: shares q = [q_0, ... q_{N-1}], liquidity b > 0.
 *   Cost function: C(q) = b * ln(Σ exp(q_i / b))
 *   Price (= probability): p_i = exp(q_i/b) / Σ exp(q_j/b)
 *   Buying Δ shares of outcome i costs C(q + Δ·e_i) − C(q).
 *
 * Numerical stability: log-sum-exp is computed with the standard
 * "subtract max" trick so q_i / b values up to a few hundred don't overflow.
 *
 * Wave 38 uses 2-outcome winner markets with b = 100; the cost of a 1-coin
 * trade is roughly proportional to 1/b, and the worst-case slippage to push
 * a price from 0.5 → 0.99 is around 4·b coins.
 */

export function logSumExp(values: number[]): number {
  if (values.length === 0) return -Infinity;
  let m = -Infinity;
  for (const v of values) if (v > m) m = v;
  if (!isFinite(m)) return m;
  let acc = 0;
  for (const v of values) acc += Math.exp(v - m);
  return m + Math.log(acc);
}

export function lmsrCost(shares: number[], b: number): number {
  if (!(b > 0)) throw new Error("b must be > 0");
  return b * logSumExp(shares.map((q) => q / b));
}

export function lmsrPrices(shares: number[], b: number): number[] {
  if (!(b > 0)) throw new Error("b must be > 0");
  const xs = shares.map((q) => q / b);
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  const exps = xs.map((x) => Math.exp(x - m));
  const sum = exps.reduce((a, c) => a + c, 0);
  return exps.map((e) => e / sum);
}

/**
 * Coin cost (positive) to buy `delta` (> 0) shares of outcome `idx`.
 */
export function lmsrBuyCost(
  shares: number[],
  b: number,
  idx: number,
  delta: number,
): number {
  if (!(delta > 0)) throw new Error("delta must be > 0");
  if (idx < 0 || idx >= shares.length) throw new Error("idx out of range");
  const before = lmsrCost(shares, b);
  const next = shares.slice();
  next[idx] += delta;
  const after = lmsrCost(next, b);
  return after - before;
}

/**
 * Inverse: how many shares of outcome `idx` does `coins` (> 0) buy?
 *
 * Cost is monotonic in delta so bisection converges quickly. Upper bound
 * doubles until cost exceeds the budget; 60 iterations gives < 1e-15
 * precision on any realistic input.
 */
/**
 * Inverse of `lmsrPrices` — return shares that would produce the given
 * target probabilities. Used to seed initial market shares from external
 * sportsbook odds so a brand-new market opens at consensus instead of
 * uniform 1/N.
 *
 * Math: prices p_i = exp(q_i/b) / Σ exp(q_j/b). Setting q_i = b·log(p_i/p_min)
 * exactly reproduces the input probs (any additive constant in q cancels
 * in the normalisation). Anchoring on min(p) keeps every share ≥ 0 so the
 * stored values are clean.
 *
 * Throws if input is empty, sums to ≤ 0, or contains a non-positive prob —
 * a zero-probability outcome can't be expressed as a finite share state in
 * LMSR.
 */
export function sharesFromTargetProbs(probs: number[], b: number): number[] {
  if (!(b > 0)) throw new Error("b must be > 0");
  if (probs.length === 0) return [];
  const sum = probs.reduce((a, c) => a + c, 0);
  if (!(sum > 0)) throw new Error("Probs must sum to > 0");
  const normalised = probs.map((p) => p / sum);
  let minP = Infinity;
  for (const p of normalised) if (p < minP) minP = p;
  if (!(minP > 0)) throw new Error("All probs must be > 0");
  return normalised.map((p) => b * Math.log(p / minP));
}

/**
 * Convert an LMSR price (implied probability, 0..1) to decimal odds for
 * display. Decimal odds = total payout per 1 coin staked (stake + profit),
 * which is just `1 / price`.
 *
 *   price 0.50 → 2.00   (1 coin → 2 coins back)
 *   price 0.20 → 5.00   (1 coin → 5 coins back)
 *   price 0.80 → 1.25
 *
 * Returns "—" for invalid / degenerate inputs so the UI doesn't show
 * `Infinity` or `NaN` on a bad row.
 */
export function priceToDecimalOdds(price: number): string {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return "—";
  return (1 / price).toFixed(2);
}

export function lmsrSharesForCoins(
  shares: number[],
  b: number,
  idx: number,
  coins: number,
  iterations = 60,
): number {
  if (!(coins > 0)) return 0;
  let lo = 0;
  let hi = Math.max(100, coins * 100);
  // Grow hi until it bounds the answer. In a 2-outcome b=100 market this
  // is essentially the first guess for any coins ≤ 10^6.
  while (lmsrBuyCost(shares, b, idx, hi) < coins) hi *= 2;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (lmsrBuyCost(shares, b, idx, mid) > coins) hi = mid;
    else lo = mid;
  }
  return lo;
}
