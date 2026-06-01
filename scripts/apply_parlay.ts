/**
 * Vertex Sportsbook — create the parlay + parlay_leg tables.
 *
 * Idempotent raw DDL (CREATE … IF NOT EXISTS), no interactive drizzle-kit
 * push, RLS-safe. Reuses the fixed_odds_market + fixed_odds_bet_status enums
 * from scripts/apply_fixed_odds.ts (run that first). Mirrors the schema in
 * src/lib/db/schema/markets.ts → keep in sync.
 *
 * Usage: npx tsx scripts/apply_parlay.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false, max: 1 });

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS parlay (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES user_profile(id) ON DELETE CASCADE,
      stake_coins integer NOT NULL,
      combined_odds real NOT NULL,
      potential_payout integer NOT NULL,
      num_legs integer NOT NULL,
      status fixed_odds_bet_status NOT NULL DEFAULT 'open',
      payout integer,
      settled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT parlay_stake_positive CHECK (stake_coins > 0),
      CONSTRAINT parlay_odds_valid CHECK (combined_odds > 1),
      CONSTRAINT parlay_min_legs CHECK (num_legs >= 2)
    );
  `;
  await sql`CREATE INDEX IF NOT EXISTS parlay_user_idx ON parlay (user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS parlay_status_idx ON parlay (status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS parlay_leg (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      parlay_id uuid NOT NULL REFERENCES parlay(id) ON DELETE CASCADE,
      bout_id uuid NOT NULL REFERENCES bout(id) ON DELETE CASCADE,
      market_kind fixed_odds_market NOT NULL,
      selection_code text NOT NULL,
      selected_fighter_id uuid REFERENCES fighter(id) ON DELETE SET NULL,
      decimal_odds real NOT NULL,
      model_prob real NOT NULL,
      status fixed_odds_bet_status NOT NULL DEFAULT 'open',
      settled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT parlay_leg_unique_bout UNIQUE (parlay_id, bout_id)
    );
  `;
  await sql`CREATE INDEX IF NOT EXISTS parlay_leg_parlay_idx ON parlay_leg (parlay_id)`;
  await sql`CREATE INDEX IF NOT EXISTS parlay_leg_bout_idx ON parlay_leg (bout_id)`;
  await sql`CREATE INDEX IF NOT EXISTS parlay_leg_status_idx ON parlay_leg (status)`;

  const cols = await sql<{ table_name: string; n: number }[]>`
    SELECT table_name, count(*)::int AS n
    FROM information_schema.columns
    WHERE table_name IN ('parlay','parlay_leg')
    GROUP BY table_name ORDER BY table_name
  `;
  console.log("parlay tables ready:", cols.map((c) => `${c.table_name}(${c.n} cols)`).join(", "));
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
