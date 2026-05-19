/**
 * Applies drizzle/migrations/0065_wave47_username_and_tier.sql:
 *   - user_profile.username_last_changed_at column
 *   - check_and_promote_tier helper
 *   - Updated unlock_achievement / settle_market_winner / settle_market_method
 *     so each coin-earning site triggers the tier check.
 *
 * Re-runnable.
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
    "drizzle/migrations/0065_wave47_username_and_tier.sql",
  );
  const ddl = readFileSync(file, "utf8");
  console.log(`Applying ${file} ...`);
  await sql.unsafe(ddl);

  const col = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'user_profile'
      AND column_name = 'username_last_changed_at'
  `;
  console.log("\nuser_profile column:");
  for (const c of col) console.log(`  ${c.column_name}`);

  const fns = await sql<{ routine_name: string }[]>`
    SELECT routine_name FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name IN (
        'check_and_promote_tier',
        'unlock_achievement',
        'settle_market_winner',
        'settle_market_method'
      )
    ORDER BY routine_name
  `;
  console.log("\nFunctions:");
  for (const r of fns) console.log(`  ${r.routine_name}`);

  await sql.end();
  console.log("\nWave 47 migration applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
