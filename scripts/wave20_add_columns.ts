/**
 * Wave 20: add 13 opp-quality + layered-activity columns to fighter.
 * Idempotent. drizzle-kit push needs TTY so we apply directly.
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
      ADD COLUMN IF NOT EXISTS decayed_ko_quality                       DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_avg_ko_finish_seconds             DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_kd_quality                        DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_stand_landed_quality_per_min      DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_td_landed_quality                 DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_control_quality                   DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_late_reach_quality                DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_damage_quality                    DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS fights_last_12mo                          SMALLINT,
      ADD COLUMN IF NOT EXISTS avg_opp_tier_last_12mo                    DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS avg_opp_tier_last_24mo                    DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS fights_last_36mo                          SMALLINT,
      ADD COLUMN IF NOT EXISTS avg_opp_tier_last_36mo                    DOUBLE PRECISION
  `;
  console.log("Wave 20: 13 columns added.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
