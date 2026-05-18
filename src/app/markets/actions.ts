"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { userProfile } from "@/lib/db/schema/users";
import { lmsrBuyCost, lmsrPrices, lmsrSharesForCoins } from "@/lib/lmsr";
import { createClient } from "@/lib/supabase/server";

const MIN_COINS_PER_BET = 1;
const MAX_COINS_PER_BET = 100_000_000;

export async function placeBetAction(
  marketId: string,
  outcomeId: string,
  coinsToSpend: number,
): Promise<{
  error?: string;
  sharesBought?: number;
  coinsSpent?: number;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  if (
    !Number.isFinite(coinsToSpend) ||
    coinsToSpend < MIN_COINS_PER_BET ||
    coinsToSpend > MAX_COINS_PER_BET
  ) {
    return { error: `Bet must be between ${MIN_COINS_PER_BET} and ${MAX_COINS_PER_BET} coins.` };
  }
  const coinsInt = Math.floor(coinsToSpend);

  const profileRows = await db
    .select({ id: userProfile.id, balance: userProfile.balanceCoins })
    .from(userProfile)
    .where(eq(userProfile.authUserId, user.id))
    .limit(1);
  const profile = profileRows[0];
  if (!profile) return { error: "Profile not found." };
  if (profile.balance < coinsInt) return { error: "Not enough coins." };

  try {
    const result = await db.transaction(async (tx) => {
      // Lock the market row first so concurrent bets on the same market
      // serialise behind us.
      const marketLockRows = await tx.execute<{
        id: string;
        status: string;
        b_parameter: number;
        closes_at: string;
      }>(sql`
        SELECT id::text AS id, status::text AS status, b_parameter, closes_at::text AS closes_at
        FROM market
        WHERE id = ${marketId}::uuid
        FOR UPDATE
      `);
      const marketArr = marketLockRows as unknown as Array<{
        id: string;
        status: string;
        b_parameter: number;
        closes_at: string;
      }>;
      if (marketArr.length === 0) throw new Error("Market not found.");
      const mRow = marketArr[0];
      if (mRow.status !== "open") throw new Error("Market is closed.");
      if (new Date(mRow.closes_at).getTime() <= Date.now()) {
        throw new Error("Market has closed.");
      }

      const outcomeRows = await tx.execute<{
        id: string;
        order_index: number;
        current_shares: number;
      }>(sql`
        SELECT id::text AS id, order_index, current_shares::float AS current_shares
        FROM market_outcome
        WHERE market_id = ${marketId}::uuid
        ORDER BY order_index ASC
        FOR UPDATE
      `);
      const outcomes = outcomeRows as unknown as Array<{
        id: string;
        order_index: number;
        current_shares: number;
      }>;
      if (outcomes.length === 0) throw new Error("No outcomes.");

      const targetIdx = outcomes.findIndex((o) => o.id === outcomeId);
      if (targetIdx < 0) throw new Error("Outcome not found.");

      const shares = outcomes.map((o) => o.current_shares);
      const b = mRow.b_parameter;

      // Re-solve under the lock — preview-cost can have drifted since the
      // client last computed it. Round actual cost up so the bookmaker
      // never accidentally hands out fractional-coin freebies.
      const sharesBought = lmsrSharesForCoins(shares, b, targetIdx, coinsInt);
      if (!(sharesBought > 0)) throw new Error("Could not compute shares.");
      const actualCost = Math.ceil(lmsrBuyCost(shares, b, targetIdx, sharesBought));
      if (actualCost > profile.balance) throw new Error("Not enough coins.");

      const newShares = shares.slice();
      newShares[targetIdx] += sharesBought;
      const newPrices = lmsrPrices(newShares, b);
      const priceAtPurchase = newPrices[targetIdx];

      for (let i = 0; i < outcomes.length; i++) {
        await tx.execute(sql`
          UPDATE market_outcome
          SET current_shares = ${newShares[i]},
              current_price = ${newPrices[i]}
          WHERE id = ${outcomes[i].id}::uuid
        `);
      }

      // First bet on this market by this user? unique_traders++.
      const existingBetRows = await tx.execute<{ has_prior: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM bet
          WHERE user_id = ${profile.id}::uuid AND market_id = ${marketId}::uuid
        ) AS has_prior
      `);
      const isNewTrader = !((existingBetRows as unknown as Array<{ has_prior: boolean }>)[0]?.has_prior);

      await tx.execute(sql`
        UPDATE market
        SET total_volume = total_volume + ${actualCost},
            unique_traders = unique_traders + ${isNewTrader ? 1 : 0}
        WHERE id = ${marketId}::uuid
      `);

      await tx.execute(sql`
        INSERT INTO bet (user_id, market_id, outcome_id, shares_bought, coins_spent, price_at_purchase)
        VALUES (
          ${profile.id}::uuid,
          ${marketId}::uuid,
          ${outcomeId}::uuid,
          ${sharesBought},
          ${actualCost},
          ${priceAtPurchase}
        )
      `);

      const newBalance = profile.balance - actualCost;
      await tx.execute(sql`
        UPDATE user_profile
        SET balance_coins = ${newBalance},
            total_coins_lost = total_coins_lost + ${actualCost},
            bet_count = bet_count + 1
        WHERE id = ${profile.id}::uuid
      `);

      await tx.execute(sql`
        INSERT INTO transaction (user_id, type, amount, balance_after, description)
        VALUES (
          ${profile.id}::uuid,
          'bet_placed',
          ${-actualCost},
          ${newBalance},
          ${`Bet placed on market ${marketId}`}
        )
      `);

      return { sharesBought, coinsSpent: actualCost };
    });

    revalidatePath(`/markets/${marketId}`);
    revalidatePath("/markets");
    revalidatePath("/me/bets");
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Bet failed.";
    return { error: msg };
  }
}

/**
 * Read-only cost preview for the bet form. Doesn't lock rows — the real
 * placeBetAction re-solves under FOR UPDATE so a stale preview can't lead
 * to over-spending.
 */
export async function previewBetCost(
  marketId: string,
  outcomeId: string,
  coins: number,
): Promise<
  | { shares: number; cost: number; newPrice: number }
  | { error: string }
> {
  if (!Number.isFinite(coins) || coins <= 0) {
    return { error: "Coins must be > 0." };
  }

  const marketRows = await db.execute<{ b_parameter: number }>(sql`
    SELECT b_parameter FROM market WHERE id = ${marketId}::uuid LIMIT 1
  `);
  const mArr = marketRows as unknown as Array<{ b_parameter: number }>;
  if (mArr.length === 0) return { error: "Market not found." };
  const b = mArr[0].b_parameter;

  const outcomeRows = await db.execute<{
    id: string;
    order_index: number;
    current_shares: number;
  }>(sql`
    SELECT id::text AS id, order_index, current_shares::float AS current_shares
    FROM market_outcome
    WHERE market_id = ${marketId}::uuid
    ORDER BY order_index ASC
  `);
  const outcomes = outcomeRows as unknown as Array<{
    id: string;
    order_index: number;
    current_shares: number;
  }>;
  const idx = outcomes.findIndex((o) => o.id === outcomeId);
  if (idx < 0) return { error: "Outcome not found." };

  const sharesArr = outcomes.map((o) => o.current_shares);
  const shares = lmsrSharesForCoins(sharesArr, b, idx, Math.floor(coins));
  if (!(shares > 0)) return { error: "Coins too small." };
  const cost = Math.ceil(lmsrBuyCost(sharesArr, b, idx, shares));
  const newSharesArr = sharesArr.slice();
  newSharesArr[idx] += shares;
  const newPrice = lmsrPrices(newSharesArr, b)[idx];
  return { shares, cost, newPrice };
}
