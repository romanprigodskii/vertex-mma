/**
 * Applies drizzle/migrations/0063_wave45_predictions.sql:
 *   - RLS on prediction_event / prediction_pick / prediction_event_result
 *   - score_predictions_for_bout / refresh_prediction_event_results helpers
 *   - on_bout_score_predictions trigger
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
    "drizzle/migrations/0063_wave45_predictions.sql",
  );
  const ddl = readFileSync(file, "utf8");
  console.log(`Applying ${file} ...`);
  await sql.unsafe(ddl);

  const rls = await sql<{ tablename: string; rowsecurity: boolean }[]>`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('prediction_event','prediction_pick','prediction_event_result')
    ORDER BY tablename
  `;
  console.log("\nRLS:");
  for (const r of rls)
    console.log(`  ${r.tablename.padEnd(26)} ${r.rowsecurity ? "ON" : "OFF"}`);

  const fns = await sql<{ routine_name: string }[]>`
    SELECT routine_name FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name IN (
        'score_predictions_for_bout',
        'refresh_prediction_event_results',
        'on_bout_score_predictions'
      )
    ORDER BY routine_name
  `;
  console.log("\nFunctions:");
  for (const r of fns) console.log(`  ${r.routine_name}`);

  const triggers = await sql<{ trigger_name: string }[]>`
    SELECT trigger_name FROM information_schema.triggers
    WHERE trigger_schema = 'public'
      AND event_object_table = 'bout'
      AND trigger_name = 'on_bout_score_predictions'
  `;
  console.log("\nTriggers on bout:");
  for (const t of triggers) console.log(`  ${t.trigger_name}`);

  await sql.end();
  console.log("\nWave 45 migration applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
