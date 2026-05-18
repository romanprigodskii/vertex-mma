/**
 * Applies drizzle/migrations/0058_wave38_bookmaker_rls.sql:
 *   - RLS on market / market_outcome / bet (public SELECT)
 *
 * Schemas themselves already exist via the drizzle schema; this migration
 * only flips on RLS + adds public-read policies. Re-runnable.
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
    "drizzle/migrations/0058_wave38_bookmaker_rls.sql",
  );
  const ddl = readFileSync(file, "utf8");
  console.log(`Applying ${file} ...`);
  await sql.unsafe(ddl);

  const rls = await sql<{ tablename: string; rowsecurity: boolean }[]>`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('market','market_outcome','bet')
    ORDER BY tablename
  `;
  console.log("\nRLS:");
  for (const r of rls) console.log(`  ${r.tablename.padEnd(18)} ${r.rowsecurity ? "ON" : "OFF"}`);

  const policies = await sql<{ tablename: string; polname: string }[]>`
    SELECT c.relname AS tablename, p.polname
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname IN ('market','market_outcome','bet')
    ORDER BY c.relname, p.polname
  `;
  console.log("\nPolicies:");
  for (const p of policies) console.log(`  ${p.tablename.padEnd(18)} ${p.polname}`);

  await sql.end();
  console.log("\nWave 38 RLS migration applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
