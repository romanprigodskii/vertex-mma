/**
 * Wave 55: apply migration 0076 — scorecard-dominance win-quality
 * modifier on recent_form. Idempotent — both views are DROP+CREATE'd.
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
    "drizzle/migrations/0076_wave55_scorecard_dominance.sql",
  );
  const ddl = readFileSync(path, "utf8");
  await sql.unsafe(ddl);
  console.log("Wave 55: views recreated (scorecard-dominance modifier).");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
