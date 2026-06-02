/**
 * Settle a market manually. Pass market id + winning outcome order_index.
 *
 * **DEPRECATED for the normal flow** — Wave 39 added the
 * `on_bout_auto_settle` trigger which auto-settles markets the moment a
 * scraper writes `winner_id` + `status = 'completed'` to the underlying
 * bout. This script is kept for:
 *
 *   1. Fallback if the trigger is disabled or the scraper writes via a
 *      path that bypasses it.
 *   2. Manual override for legacy markets / one-off corrections.
 *   3. Tests where you need to drive settlement without touching `bout`.
 *
 * Wraps the generic `settle_market_outcome` PL/pgSQL helper, so it settles ANY
 * market type — winner (idx 0/1), method (0–5), round, distance (0/1) and prop
 * — by the winning outcome's order_index. Re-running on an already-resolved
 * market is a no-op.
 *
 * Usage: npx tsx scripts/settle_market.ts <market_id> <winning_order_index>
 *        winning_order_index is the market_outcome.order_index that won
 *        (winner: 0 → fighter A, 1 → fighter B).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const pg = postgres(url, { prepare: false });

async function main() {
  const [marketId, winIdxStr] = process.argv.slice(2);
  if (!marketId || winIdxStr == null) {
    console.error("Usage: settle_market.ts <market_id> <winning_order_index>");
    process.exit(1);
  }
  const winIdx = parseInt(winIdxStr, 10);
  if (!Number.isInteger(winIdx) || winIdx < 0) {
    console.error("winning_order_index must be a non-negative integer");
    process.exit(1);
  }

  await pg`SELECT public.settle_market_outcome(${marketId}::uuid, ${winIdx})`;
  console.log(
    `Settled market ${marketId} (outcome idx ${winIdx}) via settle_market_outcome.`,
  );
  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
