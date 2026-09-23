/**
 * Applies drizzle/migrations/0100_bout_odds_quote.sql — the append-only
 * sportsbook quote table. Idempotent (IF NOT EXISTS throughout); safe to
 * re-run. Standard apply-script pattern: dotenv → DNS fallback → postgres →
 * sql.unsafe(file) → verification query.
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
    "../drizzle/migrations/0100_bout_odds_quote.sql",
  );
  await sql.unsafe(readFileSync(file, "utf8"));

  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'bout_odds_quote' ORDER BY ordinal_position
  `;
  console.log(
    `bout_odds_quote columns: ${cols.map((c) => c.column_name).join(", ")}`,
  );
  const cons = await sql`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'bout_odds_quote'::regclass ORDER BY conname
  `;
  console.log(`constraints: ${cons.map((c) => c.conname).join(", ")}`);
  const idx = await sql`
    SELECT indexname FROM pg_indexes WHERE tablename = 'bout_odds_quote'
    ORDER BY indexname
  `;
  console.log(`indexes: ${idx.map((i) => i.indexname).join(", ")}`);

  const [rows] = await sql`SELECT count(*)::int AS n FROM bout_odds_quote`;
  console.log(`rows: ${rows.n}`);

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
