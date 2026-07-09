/**
 * Applies drizzle/migrations/0091_sherdog_fight_history.sql — the Sherdog
 * full-career fight history table + fighter sync bookkeeping columns
 * (pre-UFC record pipeline). Idempotent (IF NOT EXISTS throughout); safe
 * to re-run. Standard apply-script pattern: dotenv → DNS fallback →
 * postgres → sql.unsafe(file) → verification query.
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
const sql = postgres(url, { prepare: false, max: 1 });

async function main() {
  const file = resolve(
    __dirname,
    "../drizzle/migrations/0091_sherdog_fight_history.sql",
  );
  await sql.unsafe(readFileSync(file, "utf8"));
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'fighter_sherdog_bout' ORDER BY ordinal_position
  `;
  console.log(
    `fighter_sherdog_bout columns: ${cols.map((c) => c.column_name).join(", ")}`,
  );
  const fighterCols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'fighter' AND column_name LIKE 'sherdog%'
    ORDER BY column_name
  `;
  console.log(
    `fighter sherdog columns: ${fighterCols.map((c) => c.column_name).join(", ")}`,
  );
  const idx = await sql`
    SELECT indexname FROM pg_indexes WHERE tablename = 'fighter_sherdog_bout'
  `;
  console.log(`indexes: ${idx.map((i) => i.indexname).join(", ")}`);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
