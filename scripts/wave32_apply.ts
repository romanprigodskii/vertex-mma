/**
 * Wave 32: apply migration 0072 — win-streak bonus in both the global
 * and divisional score views. Idempotent — both views are DROP+CREATE'd.
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
  const path = resolve("drizzle/migrations/0072_wave32_streak_bonus.sql");
  const ddl = readFileSync(path, "utf8");
  await sql.unsafe(ddl);
  console.log(
    "Wave 32: fighter_vertex_score + fighter_divisional_vertex_score recreated.",
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
