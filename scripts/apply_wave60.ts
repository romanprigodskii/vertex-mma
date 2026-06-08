/**
 * Applies drizzle/migrations/0088_wave60_settlement_bigint_lock_stats.sql:
 *   - LMSR settle helpers (settle_market_winner / settle_market_method /
 *     settle_market_outcome / refund_market): widen money locals + payout casts
 *     to bigint (the LMSR analogue of Wave 59), take an explicit per-market
 *     FOR UPDATE lock first, and reverse total_coins_lost on a win.
 *   - Fixed-odds / parlay settle helpers (settle_fixed_odds_bets_for_bout /
 *     settle_parlay_legs_for_bout): add the same win-branch total_coins_lost
 *     reversal (already bigint since Wave 59).
 *   - Coin-earning helpers reached during settlement (check_and_promote_tier /
 *     unlock_achievement): widen their int4 money locals (v_total_earned /
 *     v_new_balance) to bigint, else an `integer out of range` from the helper
 *     rolls back the whole settlement past the int4 ceiling.
 *
 * Reads the migration verbatim and runs it as one transaction-free batch (each
 * statement is CREATE OR REPLACE, so it's idempotent / re-runnable). NOT
 * `drizzle-kit push` — that can drop RLS/drift. Usage:
 *   npx tsx scripts/apply_wave60.ts
 *
 * The in-script source-of-truth copies of these functions live in
 * scripts/apply_notification_params.ts (the 4 LMSR fns) and
 * scripts/apply_parlay_settlement.ts (the 2 fixed-odds/parlay fns) — both were
 * updated in the same change; re-running either is safe (same definitions).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

async function main() {
  const file = path.resolve(
    "drizzle/migrations/0088_wave60_settlement_bigint_lock_stats.sql",
  );
  const ddl = readFileSync(file, "utf8");
  console.log(`Applying ${file} ...`);
  await sql.unsafe(ddl);

  // Read back: pg_get_functiondef exposes the DECLARE block, so assert each
  // function's money local was widened int4 -> bigint. The five settle helpers
  // with a v_new_balance plus unlock_achievement check that local; the four
  // LMSR settle helpers also widen v_payout; check_and_promote_tier widens
  // v_total_earned. Reject any int4 money local that survived.
  const fns = await sql<{ proname: string; def: string }[]>`
    SELECT p.proname, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'settle_market_winner','settle_market_method','settle_market_outcome',
        'refund_market','settle_fixed_odds_bets_for_bout','settle_parlay_legs_for_bout',
        'check_and_promote_tier','unlock_achievement'
      )
    ORDER BY p.proname
  `;
  // local name -> regex that flags the int4 (not bigint) declaration
  const BAD = [/v_payout\s+int(eger)?\s*;/i, /v_new_balance\s+int(eger)?\s*;/i, /v_total_earned\s+int(eger)?\s*;/i];
  console.log("\nFunctions (int4 money local should be false everywhere):");
  const stragglers: string[] = [];
  for (const r of fns) {
    const bad = BAD.some((re) => re.test(r.def));
    console.log(`  ${r.proname}: int4 money local = ${bad}`);
    if (bad) stragglers.push(r.proname);
  }
  if (fns.length !== 8 || stragglers.length > 0) {
    throw new Error(
      `expected 8 functions all with bigint money locals; int4 survives in: ${
        stragglers.join(", ") || "(some functions not found)"
      }`,
    );
  }

  await sql.end();
  console.log("\nWave 60 migration applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
