/**
 * Wave 31.5: apply migration 0069 (divisional view parity with Wave 31 —
 * age curve signal, layoff penalty, recency-weighted recent_form,
 * most_recent_is_loss flag). Reads the .sql verbatim and executes against
 * the DB. Idempotent — view is DROP+CREATE'd.
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
    "drizzle/migrations/0069_wave31_5_divisional_parity.sql",
  );
  const ddl = readFileSync(path, "utf8");
  await sql.unsafe(ddl);
  console.log("Wave 31.5: fighter_divisional_vertex_score recreated.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
