/**
 * Applies drizzle/migrations/0055_wave34_auth_rls_triggers.sql:
 *   - RLS on user_profile / transaction / fight_card / fight_card_like
 *   - on_auth_user_created trigger (auth.users → user_profile)
 *   - on_auth_user_deleted trigger (auth.users delete cascade)
 *
 * Re-runnable: the SQL drops + recreates policies/triggers idempotently.
 * Verifies row-level-security flags and trigger registration before
 * exiting.
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
  const file = path.resolve("drizzle/migrations/0055_wave34_auth_rls_triggers.sql");
  const ddl = readFileSync(file, "utf8");
  console.log(`Applying ${file} ...`);
  await sql.unsafe(ddl);

  const rls = await sql<{ tablename: string; rowsecurity: boolean }[]>`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('user_profile','transaction','fight_card','fight_card_like')
    ORDER BY tablename
  `;
  console.log("\nRLS status:");
  for (const r of rls) console.log(`  ${r.tablename.padEnd(20)} ${r.rowsecurity ? "ON" : "OFF"}`);

  const triggers = await sql<{ trigger_name: string; event_object_table: string }[]>`
    SELECT trigger_name, event_object_table
    FROM information_schema.triggers
    WHERE trigger_schema = 'auth'
      AND trigger_name IN ('on_auth_user_created','on_auth_user_deleted')
    ORDER BY trigger_name
  `;
  console.log("\nauth.users triggers:");
  for (const t of triggers) console.log(`  ${t.trigger_name} on ${t.event_object_table}`);

  await sql.end();
  console.log("\nWave 34 migration applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
