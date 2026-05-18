/**
 * Wave 26: apply migration 0053 (defensive vulnerability penalty —
 * style-weighted, subtracted from raw_current at weight 0.10). Reads
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
    "drizzle/migrations/0053_wave26_defensive_vulnerability.sql",
  );
  const ddl = readFileSync(path, "utf8");
  await sql.unsafe(ddl);
  console.log("Wave 26: fighter_vertex_score recreated.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
