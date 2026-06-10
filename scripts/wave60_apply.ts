/**
 * Wave 60: apply migration 0088 — era_dominance_current rescaled to
 * 0-100 parity (×10 influence at the unchanged 0.06 weight).
 * Idempotent — both views are DROP+CREATE'd.
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
    "drizzle/migrations/0088_wave60_era_current_rescale.sql",
  );
  const ddl = readFileSync(path, "utf8");
  await sql.unsafe(ddl);
  console.log("Wave 60: views recreated (era_dominance_current 0-100).");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
