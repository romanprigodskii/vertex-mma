/**
 * Sync ALL open winner + method market odds to the latest scraped
 * BestFightOdds (`bout_external_odds`).
 *
 * Unlike reseed_market_prices.ts — which only touches zero-activity
 * markets — this re-pins every open market to the fresh real odds, so the
 * displayed price keeps tracking the real sportsbook line even after users
 * have bet. Intended to run hourly after `pnpm odds:scrape`; `pnpm
 * odds:sync` does both in sequence.
 *
 * Method markets are skipped unless bestfightodds supplied all six method
 * decimals (it usually doesn't) — winner markets are the ones that move.
 *
 * Usage:
 *   pnpm odds:sync                   # scrape fresh odds, then sync
 *   tsx scripts/sync_market_odds.ts  # sync against the current odds only
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const pg = postgres(url, { prepare: false });

// Inlined from src/lib/lmsr.ts — keeps the standalone script free of the
// Next.js path-alias setup. Same math as the in-app helper.
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

async function syncWinner(
  marketId: string,
  b: number,
  oddsA: number,
  oddsB: number,
): Promise<void> {
  if (oddsA <= 1 || oddsB <= 1) throw new Error("decimal odds must be > 1");
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
}

async function syncMethod(
  marketId: string,
  b: number,
  decimals: number[],
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
  `;

  console.log(`Syncing ${candidates.length} market(s) from external odds…`);

  let winner = 0;
  let method = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of candidates) {
    try {
      if (c.type === "winner") {
        if (c.winner_a_decimal == null || c.winner_b_decimal == null) {
          skipped++;
          continue;
        }
        await syncWinner(
          c.market_id,
          c.b_parameter,
          c.winner_a_decimal,
          c.winner_b_decimal,
        );
        winner++;
      } else {
        const decimals = [
          c.method_a_kotko_decimal,
          c.method_a_sub_decimal,
          c.method_a_dec_decimal,
          c.method_b_kotko_decimal,
          c.method_b_sub_decimal,
          c.method_b_dec_decimal,
        ];
        if (decimals.some((d) => d == null)) {
          skipped++;
          continue;
        }
        await syncMethod(c.market_id, c.b_parameter, decimals as number[]);
        method++;
      }
    } catch (e) {
      failed++;
      console.error(`sync failed for market ${c.market_id}:`, e);
    }
  }

  console.log(
    `Synced ${winner} winner + ${method} method. ` +
      `Skipped ${skipped} (no odds).` +
      (failed > 0 ? ` Failed ${failed}.` : ""),
  );
  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
