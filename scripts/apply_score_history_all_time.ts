/**
 * Applies drizzle/migrations/0078_score_history_all_time.sql:
 *   - Adds the vertex_score_all_time column to fighter_score_history.
 *
 * Re-runnable (uses IF NOT EXISTS).
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
    "drizzle/migrations/0078_score_history_all_time.sql",
  );
  console.log(`Applying ${file} ...`);
  await sql.unsafe(readFileSync(file, "utf8"));

  const cols = await sql<{ column_name: string; data_type: string }[]>`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'fighter_score_history'
    ORDER BY ordinal_position
  `;
  console.log("\nfighter_score_history columns:");
  for (const c of cols) console.log(`  ${c.column_name.padEnd(24)} ${c.data_type}`);

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
