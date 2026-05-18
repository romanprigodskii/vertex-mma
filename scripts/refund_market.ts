/**
 * Manually refund a market — for cases where the trigger didn't fire
 * (e.g. a market was opened against a bout that later got cancelled
 * outside the normal status flow) or you need to override a settled
 * decision.
 *
 * Wraps the `refund_market` PL/pgSQL helper (Wave 39). If the market is
 * already resolved or cancelled, the helper no-ops.
 *
 * Usage: npx tsx scripts/refund_market.ts <market_id> [reason text...]
 *        Default reason: "Manual refund".
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const pg = postgres(url, { prepare: false });

async function main() {
  const [marketId, ...reasonParts] = process.argv.slice(2);
  const reason = reasonParts.join(" ").trim() || "Manual refund";
  if (!marketId) {
    console.error("Usage: refund_market.ts <market_id> [reason...]");
    process.exit(1);
  }
  await pg`SELECT public.refund_market(${marketId}::uuid, ${reason})`;
  console.log(`Refunded market ${marketId} (${reason}).`);
  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
