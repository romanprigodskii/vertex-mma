/**
 * Wave 23: apply migration 0051 (smooth piecewise-linear multiplier
 * curve replacing the Wave 15.1 step function). Reads the .sql
 * verbatim and executes against the DB. Idempotent — view is
 * DROP+CREATE'd.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { prepare: false });

async function main() {
  const path = resolve(
    "drizzle/migrations/0051_wave23_smooth_multiplier_curve.sql",
  );
  const ddl = readFileSync(path, "utf8");
  await sql.unsafe(ddl);
  console.log("Wave 23: fighter_vertex_score recreated.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
