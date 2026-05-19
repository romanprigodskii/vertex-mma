/**
 * Re-seed initial shares + prices on zero-activity markets from
 * bout_external_odds. Used to fix markets created before the scraper
 * (Wave 44) shipped — they were inserted at uniform 50/50 (winner) or
 * 1/6 (method) and stayed that way because the seed-on-creation flow
 * only fires at INSERT time.
 *
 * SAFETY: only touches markets where every outcome row has
 * `current_shares = 0`. The moment a user places a bet, current_shares
 * becomes non-zero (LMSR shares grow) and this script will skip the
 * market — so a re-run never overwrites user-driven state.
 *
 * Only winner + method get reseeded. round / distance / prop have no
 * external decimals in `bout_external_odds` (the bestfightodds parser
 * doesn't extract those), so leaving them uniform is correct.
 *
 * Usage:
 *   pnpm markets:reseed
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const pg = postgres(url, { prepare: false });

// Inlined from src/lib/lmsr.ts — keeps the standalone script free of
// the Next.js path-alias setup. Same math as the in-app helper.
function sharesFromTargetProbs(probs: number[], b: number): number[] {
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

function removeVig(probs: number[]): number[] {
  const sum = probs.reduce((a, c) => a + c, 0);
  if (!(sum > 0)) return probs;
  return probs.map((p) => p / sum);
}

async function reseedWinnerMarket(
  marketId: string,
  b: number,
  oddsA: number,
  oddsB: number,
): Promise<{ priceA: number; priceB: number }> {
  if (oddsA <= 1 || oddsB <= 1) {
    throw new Error("decimal odds must be > 1");
  }
  const fair = removeVig([1 / oddsA, 1 / oddsB]);
  const shares = sharesFromTargetProbs(fair, b);
  await pg.begin(async (tx) => {
    await tx`
      UPDATE market_outcome
      SET current_shares = ${shares[0]}, current_price = ${fair[0]}
      WHERE market_id = ${marketId}::uuid AND order_index = 0
    `;
    await tx`
      UPDATE market_outcome
      SET current_shares = ${shares[1]}, current_price = ${fair[1]}
      WHERE market_id = ${marketId}::uuid AND order_index = 1
    `;
  });
  return { priceA: fair[0], priceB: fair[1] };
}

async function reseedMethodMarket(
  marketId: string,
  b: number,
  decimals: [number, number, number, number, number, number],
): Promise<void> {
  if (decimals.some((d) => !(d > 1))) {
    throw new Error("all method decimals must be > 1");
  }
  const fair = removeVig(decimals.map((d) => 1 / d));
  const shares = sharesFromTargetProbs(fair, b);
  await pg.begin(async (tx) => {
    for (let i = 0; i < 6; i++) {
      await tx`
        UPDATE market_outcome
        SET current_shares = ${shares[i]}, current_price = ${fair[i]}
        WHERE market_id = ${marketId}::uuid AND order_index = ${i}
      `;
    }
  });
}

async function main() {
  const candidates = await pg<
    Array<{
      market_id: string;
      type: string;
      b_parameter: number;
      winner_a_decimal: number | null;
      winner_b_decimal: number | null;
      method_a_kotko_decimal: number | null;
      method_a_sub_decimal: number | null;
      method_a_dec_decimal: number | null;
      method_b_kotko_decimal: number | null;
      method_b_sub_decimal: number | null;
      method_b_dec_decimal: number | null;
    }>
  >`
    SELECT
      m.id::text AS market_id,
      m.type::text AS type,
      m.b_parameter,
      o.winner_a_decimal,
      o.winner_b_decimal,
      o.method_a_kotko_decimal,
      o.method_a_sub_decimal,
      o.method_a_dec_decimal,
      o.method_b_kotko_decimal,
      o.method_b_sub_decimal,
      o.method_b_dec_decimal
    FROM market m
    JOIN bout_external_odds o ON o.bout_id = m.bout_id
    WHERE m.status = 'open'
      AND m.type IN ('winner', 'method')
      AND NOT EXISTS (
        SELECT 1 FROM market_outcome mo
        WHERE mo.market_id = m.id AND mo.current_shares <> 0
      )
  `;

  console.log(`Found ${candidates.length} eligible markets to reseed.`);

  let reseededWinner = 0;
  let reseededMethod = 0;
  let skippedNoOdds = 0;
  let failed = 0;

  for (const c of candidates) {
    try {
      if (c.type === "winner") {
        if (
          c.winner_a_decimal == null ||
          c.winner_b_decimal == null
        ) {
          skippedNoOdds++;
          continue;
        }
        await reseedWinnerMarket(
          c.market_id,
          c.b_parameter,
          c.winner_a_decimal,
          c.winner_b_decimal,
        );
        reseededWinner++;
      } else if (c.type === "method") {
        const decimals = [
          c.method_a_kotko_decimal,
          c.method_a_sub_decimal,
          c.method_a_dec_decimal,
          c.method_b_kotko_decimal,
          c.method_b_sub_decimal,
          c.method_b_dec_decimal,
        ];
        if (decimals.some((d) => d == null)) {
          skippedNoOdds++;
          continue;
        }
        await reseedMethodMarket(
          c.market_id,
          c.b_parameter,
          decimals as [number, number, number, number, number, number],
        );
        reseededMethod++;
      }
    } catch (e) {
      failed++;
      console.error(`reseed failed for market ${c.market_id}:`, e);
    }
  }

  console.log(
    `Reseeded ${reseededWinner} winner + ${reseededMethod} method.` +
      ` Skipped ${skippedNoOdds} (incomplete odds).` +
      (failed > 0 ? ` Failed ${failed}.` : ""),
  );
  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
