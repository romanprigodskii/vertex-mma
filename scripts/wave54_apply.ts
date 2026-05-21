/**
 * Wave 54: apply migration 0075 — sample-size credibility factor on the
 * global view (current + all-time). Idempotent — views are DROP+CREATE'd.
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
    "drizzle/migrations/0075_wave54_credibility_factor.sql",
  );
  const ddl = readFileSync(path, "utf8");
  await sql.unsafe(ddl);
  console.log("Wave 54: views recreated (sample-size credibility factor).");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
