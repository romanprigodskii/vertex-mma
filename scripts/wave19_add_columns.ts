/**
 * Wave 19: add 3 position-broken strike-diff columns to fighter via
 * raw SQL (drizzle-kit push needs TTY for the rename-vs-add prompt).
 * Idempotent.
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
      ADD COLUMN IF NOT EXISTS decayed_stand_diff_per_min  DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_clinch_diff_per_min DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_ground_diff_per_min DOUBLE PRECISION
  `;
  console.log("Wave 19: 3 position-diff columns added to fighter.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
