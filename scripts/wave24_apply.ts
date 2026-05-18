/**
 * Wave 24: apply migration 0052 (recent_form_score 1.5× stretch —
 * per-bout multiplier 0.20 → 0.30 inside the recent_form CTE). Reads
 * the .sql verbatim and executes against the DB. Idempotent — view
 * is DROP+CREATE'd.
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
    "drizzle/migrations/0052_wave24_recent_form_stretch.sql",
  );
  const ddl = readFileSync(path, "utf8");
  await sql.unsafe(ddl);
  console.log("Wave 24: fighter_vertex_score recreated.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
