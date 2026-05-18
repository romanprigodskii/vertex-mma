/**
 * Wave 18: add 4 aggregate columns to fighter. Applied directly via SQL
 * because drizzle-kit push triggers an interactive rename-vs-add prompt
 * that doesn't work non-interactively. Idempotent — IF NOT EXISTS guards.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { prepare: false });

async function main() {
  await sql`
    ALTER TABLE fighter
      ADD COLUMN IF NOT EXISTS control_seconds_avg DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS knockdowns_per_fight DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS late_round_reach_rate DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS fights_last_24mo SMALLINT
  `;
  console.log("Wave 18: 4 columns added to fighter.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
