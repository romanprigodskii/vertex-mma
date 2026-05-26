/**
 * Applies drizzle/migrations/0068_remove_simulator.sql:
 *   - Drops the `simulation` table.
 *   - Drops `user_profile.simulation_count`.
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
  const file = path.resolve("drizzle/migrations/0068_remove_simulator.sql");
  console.log(`Applying ${file} ...`);
  await sql.unsafe(readFileSync(file, "utf8"));

  const remaining = await sql<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'simulation'
  `;
  console.log(
    `\nsimulation table ${remaining[0].count > 0 ? "still present" : "dropped"}.`,
  );

  const col = await sql<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_profile'
      AND column_name = 'simulation_count'
  `;
  console.log(
    `simulation_count column ${col[0].count > 0 ? "still present" : "dropped"}.`,
  );

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
