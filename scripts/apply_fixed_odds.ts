/**
 * Vertex Sportsbook — create the fixed_odds_bet table + its enums.
 *
 * Idempotent raw DDL (CREATE … IF NOT EXISTS + DO-block enum guards) so it
 * can run on every deploy without an interactive `drizzle-kit push` and
 * without touching RLS on existing tables (RLS lands in the Wave 3 auth
 * pass — see project memory). Mirrors the schema in
 * src/lib/db/schema/markets.ts → keep the two in sync.
 *
 * Usage: npx tsx scripts/apply_fixed_odds.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false, max: 1 });

async function main() {
  await sql`
    DO $$ BEGIN
      CREATE TYPE fixed_odds_market AS ENUM ('winner','method','total_rounds','distance');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `;
  await sql`
    DO $$ BEGIN
      CREATE TYPE fixed_odds_bet_status AS ENUM ('open','won','lost','void');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS fixed_odds_bet (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES user_profile(id) ON DELETE CASCADE,
      bout_id uuid NOT NULL REFERENCES bout(id) ON DELETE CASCADE,
      market_kind fixed_odds_market NOT NULL,
      selection_code text NOT NULL,
      selected_fighter_id uuid REFERENCES fighter(id) ON DELETE SET NULL,
      stake_coins integer NOT NULL,
      decimal_odds real NOT NULL,
      potential_payout integer NOT NULL,
      model_version text NOT NULL,
      model_prob real NOT NULL,
      status fixed_odds_bet_status NOT NULL DEFAULT 'open',
      payout integer,
      settled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT fixed_odds_bet_stake_positive CHECK (stake_coins > 0),
      CONSTRAINT fixed_odds_bet_odds_valid CHECK (decimal_odds > 1)
    );
  `;

  await sql`CREATE INDEX IF NOT EXISTS fixed_odds_bet_user_idx ON fixed_odds_bet (user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS fixed_odds_bet_bout_idx ON fixed_odds_bet (bout_id)`;
  await sql`CREATE INDEX IF NOT EXISTS fixed_odds_bet_status_idx ON fixed_odds_bet (status)`;

  const cols = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'fixed_odds_bet' ORDER BY ordinal_position
  `;
  console.log(
    `fixed_odds_bet ready — ${cols.length} columns:`,
    cols.map((c) => c.column_name).join(", "),
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
