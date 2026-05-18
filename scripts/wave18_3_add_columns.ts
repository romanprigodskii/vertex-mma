/**
 * Wave 18.3: add 13 decay-weighted radar aggregate columns to fighter.
 * Applied directly via SQL (drizzle-kit push needs TTY for the
 * rename-vs-add prompt under our setup). Idempotent.
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
      ADD COLUMN IF NOT EXISTS decayed_total_weight             DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_kd_per_fight              DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_control_per_fight         DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_td_landed_per_fight       DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_td_attempted_per_fight    DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_sub_attempts_per_fight    DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_ko_wins_weighted          DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_sub_wins_weighted         DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_wins_weighted             DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_late_reach_rate           DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_finish_losses_weighted    DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_slpm                      DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS decayed_sapm                      DOUBLE PRECISION
  `;
  console.log("Wave 18.3: 13 decayed columns added to fighter.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
