/**
 * Wave 53: apply migration 0074 — all-time formula gets a career-peak
 * input + opp-tier-weighted loss penalty. Idempotent — views are
 * DROP+CREATE'd.
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
    "drizzle/migrations/0074_wave53_alltime_peak_and_weighted_losses.sql",
  );
  const ddl = readFileSync(path, "utf8");
  await sql.unsafe(ddl);
  console.log("Wave 53: views recreated (all-time peak + weighted losses).");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
