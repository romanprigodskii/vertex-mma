/**
 * Applies drizzle/migrations/0079_score_history_monthly.sql:
 *   - Makes fighter_score_history.as_of_bout_id nullable.
 *   - Adds the kind column ('bout' | 'monthly').
 *   - Rotates the primary key to (fighter_id, as_of_date, kind).
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
  const file = path.resolve("drizzle/migrations/0079_score_history_monthly.sql");
  console.log(`Applying ${file} ...`);
  await sql.unsafe(readFileSync(file, "utf8"));

  const cols = await sql<{ column_name: string; is_nullable: string }[]>`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'fighter_score_history'
    ORDER BY ordinal_position
  `;
  console.log("\nfighter_score_history columns:");
  for (const c of cols) {
    console.log(`  ${c.column_name.padEnd(24)} nullable=${c.is_nullable}`);
  }

  const counts = await sql<{ kind: string; n: number }[]>`
    SELECT kind, COUNT(*)::int AS n
    FROM fighter_score_history
    GROUP BY kind
    ORDER BY kind
  `;
  console.log("\nrow counts by kind:");
  for (const c of counts) console.log(`  ${c.kind.padEnd(12)} ${c.n}`);

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
