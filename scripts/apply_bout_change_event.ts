/**
 * Applies drizzle/migrations/0092_bout_change_event.sql — the append-only
 * bout_change_event log. Idempotent (IF NOT EXISTS throughout); safe to
 * re-run. Standard apply-script pattern: dotenv → DNS fallback → postgres →
 * sql.unsafe(file) → verification query.
 *
 * The verification asserts the table has NO foreign keys: it has to survive
 * the `DELETE FROM bout` it exists to document.
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
    "../drizzle/migrations/0092_bout_change_event.sql",
  );
  await sql.unsafe(readFileSync(file, "utf8"));

  const cols = await sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'bout_change_event' ORDER BY ordinal_position
  `;
  console.log(
    `bout_change_event columns: ${cols.map((c) => c.column_name).join(", ")}`,
  );
  const idx = await sql`
    SELECT indexname FROM pg_indexes WHERE tablename = 'bout_change_event'
    ORDER BY indexname
  `;
  console.log(`indexes: ${idx.map((i) => i.indexname).join(", ")}`);

  const fks = await sql`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'bout_change_event'::regclass AND contype = 'f'
  `;
  if (fks.length > 0) {
    throw new Error(
      `bout_change_event must have NO foreign keys (it has to survive ` +
        `DELETE FROM bout), found: ${fks.map((f) => f.conname).join(", ")}`,
    );
  }
  console.log("foreign keys: none (as intended)");

  const [rows] = await sql`SELECT count(*)::int AS n FROM bout_change_event`;
  console.log(`rows: ${rows.n}`);

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
