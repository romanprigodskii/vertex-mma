"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { checkAndUnlockAchievements } from "@/lib/achievements";
import { getBoutSimulation } from "@/lib/bout-simulation";
import { db } from "@/lib/db";
import { userProfile } from "@/lib/db/schema/users";
import { lmsrBuyCost, lmsrPrices, lmsrSharesForCoins } from "@/lib/lmsr";
import { getBoutExternalOdds } from "@/lib/markets";
import {
  MAX_PARLAY_LEGS,
  MIN_PARLAY_LEGS,
  type SportsbookSelectionCode,
  combineParlayOdds,
  computeSportsbookOutcomes,
  isBoutBettable,
  isSelectionCode,
  marketProbFromOdds,
  potentialPayout,
  selectionSide,
} from "@/lib/sportsbook";
import { createClient } from "@/lib/supabase/server";

const MIN_COINS_PER_BET = 1;
// 1M is already 100× the 10k signup grant — generous. Lifetime tallies
// (total_volume / balance_coins / total_coins_*) are bigint, so multi-year
// accumulation can't overflow. The CHECK(balance_coins >= 0) constraint +
// FOR UPDATE lock cap the rest.
const MAX_COINS_PER_BET = 1_000_000;

/**
 * Unlock achievements as a POST-COMMIT, best-effort side effect. The bet (or
 * parlay) is already durably committed by the time we get here, so a failure
 * unlocking achievements must NEVER bubble up as a bet error: the user would
 * see {error} on a bet that actually went through, assume it failed, and re-bet
 * — an accidental double bet. We swallow and let the next user action catch up.
 */
async function unlockAchievementsBestEffort(profileId: string): Promise<string[]> {
  try {
    return await checkAndUnlockAchievements(profileId);
  } catch {
    return [];
  }
}

export async function placeBetAction(
  marketId: string,
  outcomeId: string,
  coinsToSpend: number,
): Promise<{
  error?: string;
  sharesBought?: number;
  coinsSpent?: number;
  newlyUnlocked?: string[];
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

  let result: { sharesBought: number; coinsSpent: number };
  try {
    result = await db.transaction(async (tx) => {
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

      // Lock the profile row and re-read the AUTHORITATIVE balance inside the
      // tx. The outer read (above) is only a cheap early-reject; trusting it
      // for the debit was a lost-update race — two concurrent bets by the same
      // user on DIFFERENT markets lock different market rows, so they never
      // serialised, and each wrote `startingBalance - ownCost` (absolute),
      // letting the user overspend / mint coins. Locking user_profile here
      // also serialises the same user's concurrent bets across all markets.
      // ::float8 — balance_coins is bigint; postgres.js returns int8 as a
      // string, so cast to a JS number for the typeof check + arithmetic below.
      const balanceRows = await tx.execute<{ balance_coins: number }>(sql`
        SELECT balance_coins::float8 AS balance_coins
        FROM user_profile
        WHERE id = ${profile.id}::uuid
        FOR UPDATE
      `);
      const lockedBalance = (
        balanceRows as unknown as Array<{ balance_coins: number }>
      )[0]?.balance_coins;
      if (typeof lockedBalance !== "number") throw new Error("Profile not found.");
      if (actualCost > lockedBalance) throw new Error("Not enough coins.");

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

      // Relative debit (not an absolute overwrite) so it composes safely with
      // any concurrent balance mutation; the FOR UPDATE lock above plus the
      // balance_coins >= 0 CHECK constraint guarantee it can never go negative.
      const newBalance = lockedBalance - actualCost;
      await tx.execute(sql`
        UPDATE user_profile
        SET balance_coins = balance_coins - ${actualCost},
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Bet failed.";
    return { error: msg };
  }

  // Post-commit, best-effort: the bet is already committed. first_bet /
  // balance thresholds may unlock here, but a failure must NOT surface as a
  // bet error (the user would assume it failed and re-bet → accidental double
  // bet). Settlement-time achievements (bet_10_wins, big_win) fire on payout,
  // not at placement — those need a separate hook in Wave 41+.
  const newlyUnlocked = await unlockAchievementsBestEffort(profile.id);
  revalidatePath(`/markets/${marketId}`);
  revalidatePath("/markets");
  revalidatePath("/me/bets");
  return { ...result, newlyUnlocked };
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

/* -------------------------------------------------------------------------- */
/*                  Vertex Sportsbook — fixed-odds bet placement              */
/* -------------------------------------------------------------------------- */

/**
 * Place a FIXED-ODDS bet on a bout outcome at our model-derived "Vertex
 * odds". Unlike the LMSR market, odds don't move with volume: the decimal
 * odds are recomputed from the latest simulation server-side (never trust
 * the client) and LOCKED onto the bet row. Payout = floor(stake × odds),
 * paid at settlement (src/lib/sportsbook-data.ts).
 */
export async function placeFixedOddsBetAction(
  boutId: string,
  selectionCode: string,
  stake: number,
): Promise<{
  error?: string;
  decimalOdds?: number;
  potentialPayout?: number;
  newlyUnlocked?: string[];
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  if (!isSelectionCode(selectionCode)) return { error: "Unknown selection." };
  const code = selectionCode as SportsbookSelectionCode;

  if (
    !Number.isFinite(stake) ||
    stake < MIN_COINS_PER_BET ||
    stake > MAX_COINS_PER_BET
  ) {
    return {
      error: `Stake must be between ${MIN_COINS_PER_BET} and ${MAX_COINS_PER_BET} coins.`,
    };
  }
  const stakeInt = Math.floor(stake);

  const profileRows = await db
    .select({ id: userProfile.id, balance: userProfile.balanceCoins })
    .from(userProfile)
    .where(eq(userProfile.authUserId, user.id))
    .limit(1);
  const profile = profileRows[0];
  if (!profile) return { error: "Profile not found." };
  if (profile.balance < stakeInt) return { error: "Not enough coins." };

  // Bout context + bettability gate (status scheduled + event in the future).
  const boutRows = (await db.execute<{
    status: string;
    fighter_a_id: string;
    fighter_b_id: string;
    event_date: string;
  }>(sql`
    SELECT b.status::text AS status,
           b.fighter_a_id::text AS fighter_a_id,
           b.fighter_b_id::text AS fighter_b_id,
           e.date::text AS event_date
    FROM bout b JOIN event e ON e.id = b.event_id
    WHERE b.id = ${boutId}::uuid
    LIMIT 1
  `)) as unknown as Array<{
    status: string;
    fighter_a_id: string;
    fighter_b_id: string;
    event_date: string;
  }>;
  const boutRow = boutRows[0];
  if (!boutRow) return { error: "Bout not found." };
  if (!isBoutBettable(boutRow.status, boutRow.event_date)) {
    return { error: "Betting is closed for this bout." };
  }

  // Recompute the odds from the latest model — the authoritative price.
  // Fetch the consensus odds too so the edge-guard here matches the bout
  // page exactly (the locked odds must equal what the user was shown).
  const [sim, externalOdds] = await Promise.all([
    getBoutSimulation(boutId),
    getBoutExternalOdds(boutId),
  ]);
  if (!sim) return { error: "No model odds available for this bout yet." };
  const outcomes = computeSportsbookOutcomes({
    probA: sim.probA,
    probB: sim.probB,
    marketProbA: marketProbFromOdds(
      externalOdds?.winner_a_decimal ?? null,
      externalOdds?.winner_b_decimal ?? null,
    ),
    rounds: sim.rounds
      ? {
          probKoA: sim.rounds.probKoA,
          probKoB: sim.rounds.probKoB,
          probSubA: sim.rounds.probSubA,
          probSubB: sim.rounds.probSubB,
          probDecisionA: sim.rounds.probDecisionA,
          probDecisionB: sim.rounds.probDecisionB,
          finishByRound: sim.rounds.finishByRound,
        }
      : null,
  });
  const offered = outcomes.find((o) => o.code === code);
  if (!offered) return { error: "That market isn't offered for this bout." };

  const decimalOdds = offered.decimalOdds;
  const payout = potentialPayout(stakeInt, decimalOdds);
  const side = selectionSide(code);
  const selectedFighterId =
    side === "a"
      ? boutRow.fighter_a_id
      : side === "b"
        ? boutRow.fighter_b_id
        : null;

  try {
    await db.transaction(async (tx) => {
      // Authoritative balance under lock (mirrors placeBetAction — guards the
      // lost-update race for the same user betting concurrently).
      const balanceRows = (await tx.execute<{ balance_coins: number }>(sql`
        SELECT balance_coins::float8 AS balance_coins FROM user_profile WHERE id = ${profile.id}::uuid FOR UPDATE
      `)) as unknown as Array<{ balance_coins: number }>;
      const locked = balanceRows[0]?.balance_coins;
      if (typeof locked !== "number") throw new Error("Profile not found.");
      if (stakeInt > locked) throw new Error("Not enough coins.");

      await tx.execute(sql`
        INSERT INTO fixed_odds_bet
          (user_id, bout_id, market_kind, selection_code, selected_fighter_id,
           stake_coins, decimal_odds, potential_payout, model_version, model_prob)
        VALUES (
          ${profile.id}::uuid, ${boutId}::uuid, ${offered.marketKind}, ${code},
          ${selectedFighterId ? sql`${selectedFighterId}::uuid` : sql`NULL`},
          ${stakeInt}, ${decimalOdds}, ${payout}, ${sim.modelVersion}, ${offered.prob}
        )
      `);

      const newBalance = locked - stakeInt;
      await tx.execute(sql`
        UPDATE user_profile
        SET balance_coins = balance_coins - ${stakeInt},
            total_coins_lost = total_coins_lost + ${stakeInt},
            bet_count = bet_count + 1
        WHERE id = ${profile.id}::uuid
      `);

      await tx.execute(sql`
        INSERT INTO transaction (user_id, type, amount, balance_after, description)
        VALUES (${profile.id}::uuid, 'bet_placed', ${-stakeInt}, ${newBalance},
                ${`Sportsbook bet on bout ${boutId}`})
      `);
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Bet failed." };
  }

  // Post-commit, best-effort (see unlockAchievementsBestEffort): the bet is
  // committed; an achievement failure must not throw and read as a failed bet.
  const newlyUnlocked = await unlockAchievementsBestEffort(profile.id);
  revalidatePath(`/bouts/${boutId}`);
  revalidatePath("/me/bets");
  return { decimalOdds, potentialPayout: payout, newlyUnlocked };
}

/* -------------------------------------------------------------------------- */
/*                      Vertex Sportsbook — parlay placement                  */
/* -------------------------------------------------------------------------- */

type PricedLeg = {
  boutId: string;
  code: SportsbookSelectionCode;
  marketKind: string;
  decimalOdds: number;
  modelProb: number;
  selectedFighterId: string | null;
};

/** Re-price one leg server-side (same odds + edge-guard as a single bet).
 *  Returns the priced leg or an error string the caller surfaces. */
async function priceParlayLeg(
  boutId: string,
  rawCode: string,
): Promise<PricedLeg | { error: string }> {
  if (!isSelectionCode(rawCode)) return { error: "Unknown selection in slip." };
  const code = rawCode as SportsbookSelectionCode;

  const boutRows = (await db.execute<{
    status: string;
    fighter_a_id: string;
    fighter_b_id: string;
    event_date: string;
  }>(sql`
    SELECT b.status::text AS status,
           b.fighter_a_id::text AS fighter_a_id,
           b.fighter_b_id::text AS fighter_b_id,
           e.date::text AS event_date
    FROM bout b JOIN event e ON e.id = b.event_id
    WHERE b.id = ${boutId}::uuid
    LIMIT 1
  `)) as unknown as Array<{
    status: string;
    fighter_a_id: string;
    fighter_b_id: string;
    event_date: string;
  }>;
  const boutRow = boutRows[0];
  if (!boutRow) return { error: "A pick's bout was not found." };
  if (!isBoutBettable(boutRow.status, boutRow.event_date)) {
    return { error: "A pick is no longer open for betting." };
  }

  const [sim, externalOdds] = await Promise.all([
    getBoutSimulation(boutId),
    getBoutExternalOdds(boutId),
  ]);
  if (!sim) return { error: "No model odds for one of your picks yet." };

  const outcomes = computeSportsbookOutcomes({
    probA: sim.probA,
    probB: sim.probB,
    marketProbA: marketProbFromOdds(
      externalOdds?.winner_a_decimal ?? null,
      externalOdds?.winner_b_decimal ?? null,
    ),
    rounds: sim.rounds
      ? {
          probKoA: sim.rounds.probKoA,
          probKoB: sim.rounds.probKoB,
          probSubA: sim.rounds.probSubA,
          probSubB: sim.rounds.probSubB,
          probDecisionA: sim.rounds.probDecisionA,
          probDecisionB: sim.rounds.probDecisionB,
          finishByRound: sim.rounds.finishByRound,
        }
      : null,
  });
  const offered = outcomes.find((o) => o.code === code);
  if (!offered) return { error: "A pick isn't offered for its bout." };

  const side = selectionSide(code);
  const selectedFighterId =
    side === "a"
      ? boutRow.fighter_a_id
      : side === "b"
        ? boutRow.fighter_b_id
        : null;
  return {
    boutId,
    code,
    marketKind: offered.marketKind,
    decimalOdds: offered.decimalOdds,
    modelProb: offered.prob,
    selectedFighterId,
  };
}

/**
 * Place a PARLAY: one stake across 2–MAX_PARLAY_LEGS legs (distinct bouts).
 * Each leg is re-priced server-side; combined odds = product; payout =
 * floor(stake × combined). Wins only if every leg wins (void legs drop out at
 * settlement). Settled by the same trigger/backstop as single bets.
 */
export async function placeParlayAction(
  legs: Array<{ boutId: string; code: string }>,
  stake: number,
): Promise<{
  error?: string;
  parlayId?: string;
  combinedOdds?: number;
  potentialPayout?: number;
  newlyUnlocked?: string[];
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  if (
    !Array.isArray(legs) ||
    legs.length < MIN_PARLAY_LEGS ||
    legs.length > MAX_PARLAY_LEGS
  ) {
    return {
      error: `A parlay needs ${MIN_PARLAY_LEGS}–${MAX_PARLAY_LEGS} picks.`,
    };
  }
  const boutIds = legs.map((l) => l.boutId);
  if (new Set(boutIds).size !== boutIds.length) {
    return { error: "Only one pick per fight in a parlay." };
  }
  if (
    !Number.isFinite(stake) ||
    stake < MIN_COINS_PER_BET ||
    stake > MAX_COINS_PER_BET
  ) {
    return {
      error: `Stake must be between ${MIN_COINS_PER_BET} and ${MAX_COINS_PER_BET} coins.`,
    };
  }
  const stakeInt = Math.floor(stake);

  const profileRows = await db
    .select({ id: userProfile.id, balance: userProfile.balanceCoins })
    .from(userProfile)
    .where(eq(userProfile.authUserId, user.id))
    .limit(1);
  const profile = profileRows[0];
  if (!profile) return { error: "Profile not found." };
  if (profile.balance < stakeInt) return { error: "Not enough coins." };

  // Price every leg server-side (authoritative odds + edge-guard).
  const priced = await Promise.all(
    legs.map((l) => priceParlayLeg(l.boutId, l.code)),
  );
  const bad = priced.find((p): p is { error: string } => "error" in p);
  if (bad) return { error: bad.error };
  const pricedLegs = priced as PricedLeg[];

  const combinedOdds = combineParlayOdds(pricedLegs.map((p) => p.decimalOdds));
  const payout = potentialPayout(stakeInt, combinedOdds);

  let createdParlayId: string | null = null;
  try {
    await db.transaction(async (tx) => {
      const balanceRows = (await tx.execute<{ balance_coins: number }>(sql`
        SELECT balance_coins::float8 AS balance_coins FROM user_profile WHERE id = ${profile.id}::uuid FOR UPDATE
      `)) as unknown as Array<{ balance_coins: number }>;
      const locked = balanceRows[0]?.balance_coins;
      if (typeof locked !== "number") throw new Error("Profile not found.");
      if (stakeInt > locked) throw new Error("Not enough coins.");

      const parlayRows = (await tx.execute<{ id: string }>(sql`
        INSERT INTO parlay (user_id, stake_coins, combined_odds, potential_payout, num_legs)
        VALUES (${profile.id}::uuid, ${stakeInt}, ${combinedOdds}, ${payout}, ${pricedLegs.length})
        RETURNING id::text AS id
      `)) as unknown as Array<{ id: string }>;
      const parlayId = parlayRows[0]?.id;
      if (!parlayId) throw new Error("Could not create parlay.");
      createdParlayId = parlayId;

      for (const leg of pricedLegs) {
        await tx.execute(sql`
          INSERT INTO parlay_leg
            (parlay_id, bout_id, market_kind, selection_code, selected_fighter_id, decimal_odds, model_prob)
          VALUES (
            ${parlayId}::uuid, ${leg.boutId}::uuid, ${leg.marketKind}, ${leg.code},
            ${leg.selectedFighterId ? sql`${leg.selectedFighterId}::uuid` : sql`NULL`},
            ${leg.decimalOdds}, ${leg.modelProb}
          )
        `);
      }

      const newBalance = locked - stakeInt;
      await tx.execute(sql`
        UPDATE user_profile
        SET balance_coins = balance_coins - ${stakeInt},
            total_coins_lost = total_coins_lost + ${stakeInt},
            bet_count = bet_count + 1
        WHERE id = ${profile.id}::uuid
      `);
      await tx.execute(sql`
        INSERT INTO transaction (user_id, type, amount, balance_after, description)
        VALUES (${profile.id}::uuid, 'bet_placed', ${-stakeInt}, ${newBalance},
                ${`Parlay (${pricedLegs.length} legs)`})
      `);
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Parlay failed." };
  }

  // Post-commit, best-effort (see unlockAchievementsBestEffort): the parlay is
  // committed; an achievement failure must not throw and read as a failed bet.
  const newlyUnlocked = await unlockAchievementsBestEffort(profile.id);
  revalidatePath("/me/bets");
  return {
    parlayId: createdParlayId ?? undefined,
    combinedOdds,
    potentialPayout: payout,
    newlyUnlocked,
  };
}
