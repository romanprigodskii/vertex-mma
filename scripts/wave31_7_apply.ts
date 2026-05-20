/**
 * Wave 31.7: apply migration 0070 — create fighter_score_history table.
 * Idempotent (CREATE TABLE IF NOT EXISTS).
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
    "drizzle/migrations/0070_wave31_7_score_history.sql",
  );
  const ddl = readFileSync(path, "utf8");
  await sql.unsafe(ddl);
  console.log("Wave 31.7: fighter_score_history table created.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
