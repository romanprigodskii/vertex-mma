/**
 * Applies drizzle/migrations/0004_vertex_score.sql to the configured DB.
 *
 * Drizzle Kit's `push` doesn't manage views, and Supabase's SQL editor is
 * fine but un-scriptable, so this lightweight runner just reads the migration
 * file and executes it as one statement via postgres-js. Safe to re-run —
 * the migration is itself idempotent (IF NOT EXISTS on columns/index,
 * DROP VIEW IF EXISTS on the view).
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
  const file = path.resolve("drizzle/migrations/0004_vertex_score.sql");
  const ddl = readFileSync(file, "utf8");
  console.log(`Applying ${file} ...`);
  await sql.unsafe(ddl);
  console.log("Migration applied.");

  // Sanity: view should exist and return rows.
  const sample = await sql`
    SELECT slug, ufc_bouts, vertex_score
    FROM fighter_vertex_score
    WHERE ufc_bouts >= 3
    ORDER BY vertex_score DESC NULLS LAST
    LIMIT 5
  `;
  console.log("\nSample top-5 rows (pre-pedigree-backfill):");
  for (const r of sample) console.log(`  ${String(r.slug).padEnd(40)} ${r.ufc_bouts} bouts → score ${r.vertex_score}`);

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
