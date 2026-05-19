/**
 * Applies drizzle/migrations/0064_wave46_notifications.sql:
 *   - notification table + indexes + RLS (owner SELECT/UPDATE only)
 *   - Updated PL/pgSQL helpers (unlock_achievement, settle_market_winner,
 *     settle_market_method, refund_market) and the
 *     on_bout_score_predictions trigger so each user-relevant event
 *     pushes a notification row.
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
    "drizzle/migrations/0064_wave46_notifications.sql",
  );
  const ddl = readFileSync(file, "utf8");
  console.log(`Applying ${file} ...`);
  await sql.unsafe(ddl);

  const rls = await sql<{ tablename: string; rowsecurity: boolean }[]>`
    SELECT tablename, rowsecurity FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'notification'
  `;
  console.log("\nTable:");
  for (const r of rls)
    console.log(`  ${r.tablename}  RLS=${r.rowsecurity ? "on" : "off"}`);

  const policies = await sql<{ polname: string }[]>`
    SELECT polname FROM pg_policy
    WHERE polrelid = 'notification'::regclass
    ORDER BY polname
  `;
  console.log("\nPolicies:");
  for (const p of policies) console.log(`  ${p.polname}`);

  const fns = await sql<{ routine_name: string }[]>`
    SELECT routine_name FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name IN (
        'unlock_achievement',
        'settle_market_winner',
        'settle_market_method',
        'refund_market',
        'on_bout_score_predictions'
      )
    ORDER BY routine_name
  `;
  console.log("\nFunctions:");
  for (const r of fns) console.log(`  ${r.routine_name}`);

  await sql.end();
  console.log("\nWave 46 migration applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
