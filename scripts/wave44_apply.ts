/**
 * Applies drizzle/migrations/0062_wave44_external_odds.sql:
 *   - bout_external_odds table + unique (bout, source) + RLS (public read)
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
    "drizzle/migrations/0062_wave44_external_odds.sql",
  );
  const ddl = readFileSync(file, "utf8");
  console.log(`Applying ${file} ...`);
  await sql.unsafe(ddl);

  const tables = await sql<{ tablename: string; rowsecurity: boolean }[]>`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'bout_external_odds'
  `;
  console.log("\nTable:");
  for (const t of tables)
    console.log(`  ${t.tablename}  RLS=${t.rowsecurity ? "on" : "off"}`);

  const policies = await sql<{ polname: string }[]>`
    SELECT polname FROM pg_policy
    WHERE polrelid = 'bout_external_odds'::regclass
  `;
  console.log("\nPolicies:");
  for (const p of policies) console.log(`  ${p.polname}`);

  await sql.end();
  console.log("\nWave 44 migration applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
