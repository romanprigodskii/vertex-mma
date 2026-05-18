/**
 * Applies drizzle/migrations/0059_wave39_auto_settlement.sql:
 *   - settle_market_winner / refund_market PL/pgSQL helpers
 *   - on_bout_auto_settle trigger on bout (AFTER UPDATE OF status,
 *     winner_id, method)
 *
 * Re-runnable. Verifies functions + trigger registration.
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
    "drizzle/migrations/0059_wave39_auto_settlement.sql",
  );
  const ddl = readFileSync(file, "utf8");
  console.log(`Applying ${file} ...`);
  await sql.unsafe(ddl);

  const fns = await sql<{ routine_name: string }[]>`
    SELECT routine_name
    FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name IN ('settle_market_winner','refund_market','on_bout_auto_settle')
    ORDER BY routine_name
  `;
  console.log("\nFunctions:");
  for (const r of fns) console.log(`  ${r.routine_name}`);

  const triggers = await sql<{ trigger_name: string }[]>`
    SELECT trigger_name
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
      AND event_object_table = 'bout'
      AND trigger_name = 'on_bout_auto_settle'
  `;
  console.log("\nTriggers on bout:");
  for (const t of triggers) console.log(`  ${t.trigger_name}`);

  await sql.end();
  console.log("\nWave 39 migration applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
