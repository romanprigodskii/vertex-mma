/**
 * Wave 61: apply migration 0089 — months_since_last / layoff_penalty
 * display columns on fighter_divisional_score. Idempotent
 * (ADD COLUMN IF NOT EXISTS). Re-run
 * scripts/materialize_divisional_score.ts afterwards to populate them.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { install as installDnsFallback } from "../src/lib/dns-fallback";
installDnsFallback();
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { prepare: false });

async function main() {
  const path = resolve(
    "drizzle/migrations/0089_wave61_divisional_layoff_columns.sql",
  );
  const ddl = readFileSync(path, "utf8");
  await sql.unsafe(ddl);
  console.log("Wave 61: fighter_divisional_score layoff columns added.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
