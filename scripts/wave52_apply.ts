/**
 * Applies drizzle/migrations/0067_wave52_simulator.sql:
 *   - Replaces simulation_select_own RLS policy with one that allows
 *     public rows OR owner rows.
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
    "drizzle/migrations/0067_wave52_simulator.sql",
  );
  console.log(`Applying ${file} ...`);
  await sql.unsafe(readFileSync(file, "utf8"));

  const policies = await sql<{ polname: string }[]>`
    SELECT polname FROM pg_policy
    WHERE polrelid = 'simulation'::regclass
    ORDER BY polname
  `;
  console.log("\nsimulation policies:");
  for (const p of policies) console.log(`  ${p.polname}`);

  await sql.end();
  console.log("\nWave 52 migration applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
