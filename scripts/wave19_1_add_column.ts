/**
 * Wave 19.1: add decayed_stand_landed_per_min column. Powers the
 * volume-style striking branch in computeAttributes. Idempotent.
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
      ADD COLUMN IF NOT EXISTS decayed_stand_landed_per_min DOUBLE PRECISION
  `;
  console.log("Wave 19.1: decayed_stand_landed_per_min added.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
