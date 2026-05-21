/**
 * Wave 33: apply migration 0073 — raise the recent_loss_penalty severity
 * floor 0.3 → 0.6 so losses to top opponents register. Idempotent —
 * both views are DROP+CREATE'd.
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
    "drizzle/migrations/0073_wave33_loss_to_top_severity.sql",
  );
  const ddl = readFileSync(path, "utf8");
  await sql.unsafe(ddl);
  console.log(
    "Wave 33: fighter_vertex_score + fighter_divisional_vertex_score recreated.",
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
