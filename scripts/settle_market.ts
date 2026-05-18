/**
 * Settle a single market by hand. Wave 39 will automate this against the
 * scrape pipeline; for now it's the manual escape hatch.
 *
 * Usage: npx tsx scripts/settle_market.ts <market_id> <winning_order_index>
 *
 * winning_order_index = 0 → fighter A wins, 1 → fighter B wins.
 * Each share of the winning outcome pays out 1 coin. Losing bets are
 * marked resolved with payout 0 so the UI can render "Lost".
 *
 * Re-running on an already-settled market is a no-op (resolved_at IS NULL
 * filter on payout step + idempotent flag updates).
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
  if (winIdx !== 0 && winIdx !== 1) {
    console.error("winning_order_index must be 0 or 1");
    process.exit(1);
  }

  let paidOutCount = 0;
  let totalPaidOut = 0;

  await pg.begin(async (tx) => {
    const outcomes = await tx<
      Array<{ id: string; order_index: number }>
    >`
      SELECT id::text AS id, order_index
      FROM market_outcome
      WHERE market_id = ${marketId}::uuid
      ORDER BY order_index
    `;
    const winning = outcomes.find((o) => o.order_index === winIdx);
    const losing = outcomes.find((o) => o.order_index !== winIdx);
    if (!winning || !losing) throw new Error("Could not find outcomes.");

    await tx`
      UPDATE market_outcome SET is_winning = TRUE WHERE id = ${winning.id}::uuid
    `;
    await tx`
      UPDATE market_outcome SET is_winning = FALSE WHERE id = ${losing.id}::uuid
    `;

    await tx`
      UPDATE market
      SET status = 'resolved',
          resolved_outcome_id = ${winning.id}::uuid,
          resolved_at = NOW()
      WHERE id = ${marketId}::uuid
    `;

    const winningBets = await tx<
      Array<{ id: string; user_id: string; shares: number; coins_spent: number }>
    >`
      SELECT id::text AS id,
             user_id::text AS user_id,
             shares_bought::float AS shares,
             coins_spent
      FROM bet
      WHERE market_id = ${marketId}::uuid
        AND outcome_id = ${winning.id}::uuid
        AND resolved_at IS NULL
    `;

    for (const b of winningBets) {
      const payout = Math.round(b.shares);
      await tx`
        UPDATE bet
        SET payout = ${payout}, resolved_at = NOW()
        WHERE id = ${b.id}::uuid
      `;
      await tx`
        UPDATE user_profile
        SET balance_coins = balance_coins + ${payout},
            total_coins_earned = total_coins_earned + ${payout}
        WHERE id = ${b.user_id}::uuid
      `;
      await tx`
        INSERT INTO transaction (
          user_id, type, amount, balance_after, description, related_bet_id
        )
        VALUES (
          ${b.user_id}::uuid,
          'bet_won',
          ${payout},
          (SELECT balance_coins FROM user_profile WHERE id = ${b.user_id}::uuid),
          ${`Won bet ${b.id}: ${payout} coins from ${b.shares.toFixed(2)} shares`},
          ${b.id}::uuid
        )
      `;
      paidOutCount++;
      totalPaidOut += payout;
    }

    await tx`
      UPDATE bet
      SET payout = 0, resolved_at = NOW()
      WHERE market_id = ${marketId}::uuid
        AND outcome_id = ${losing.id}::uuid
        AND resolved_at IS NULL
    `;
  });

  console.log(
    `Settled market ${marketId} on outcome #${winIdx}: paid out ${paidOutCount} winning bet${paidOutCount === 1 ? "" : "s"}, total ${totalPaidOut} coins.`,
  );
  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
