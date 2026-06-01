/**
 * Vertex Sportsbook — settlement BACKSTOP (single bets + parlays).
 *
 * Fixed-odds bets and parlay legs settle INSTANTLY via the
 * on_bout_settle_fixed_odds AFTER-UPDATE trigger (scripts/apply_fixed_odds_
 * settlement.ts + scripts/apply_parlay_settlement.ts). The trigger is AFTER
 * UPDATE, so a bout INSERTed already-completed (no UPDATE) won't fire it — this
 * cron sweep catches those. It just re-invokes the same PL/pgSQL settle
 * functions (single source of grading truth), so it's fully consistent with
 * the trigger and idempotent (the functions only touch status='open' rows).
 *
 *   Usage: npx tsx scripts/settle_fixed_odds.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false, max: 3 });

async function main() {
  // Resolved bouts that still have an open single bet OR open parlay leg.
  const bouts = (await sql`
    SELECT b.id::text AS id
    FROM bout b
    WHERE (
        b.status = 'completed' OR b.status = 'no_contest'
        OR b.winner_id IS NOT NULL OR b.method IN ('draw','no_contest')
      )
      AND (
        EXISTS (SELECT 1 FROM fixed_odds_bet f WHERE f.bout_id = b.id AND f.status = 'open')
        OR EXISTS (SELECT 1 FROM parlay_leg pl WHERE pl.bout_id = b.id AND pl.status = 'open')
      )
  `) as unknown as Array<{ id: string }>;

  console.log(`${bouts.length} resolved bout(s) with unsettled bets/legs.`);
  for (const b of bouts) {
    await sql`SELECT settle_fixed_odds_bets_for_bout(${b.id}::uuid)`;
    await sql`SELECT settle_parlay_legs_for_bout(${b.id}::uuid)`;
  }
  console.log(`Backstop settlement run complete (${bouts.length} bouts).`);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
