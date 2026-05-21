/**
 * Wave 31.8: apply migration 0071 — divisional view full parity with
 * the global formula (Wave 22 perf_diff max+balance, Wave 26/30
 * defensive_vulnerability). Idempotent — view is DROP+CREATE'd.
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
    "drizzle/migrations/0071_wave31_8_divisional_full_parity.sql",
  );
  const ddl = readFileSync(path, "utf8");
  await sql.unsafe(ddl);
  console.log("Wave 31.8: fighter_divisional_vertex_score recreated.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
