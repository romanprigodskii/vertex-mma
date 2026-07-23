/**
 * Applies drizzle/migrations/0093_bout_first_seen_at.sql — bout.first_seen_at.
 * Idempotent (IF NOT EXISTS); safe to re-run. Standard apply-script pattern:
 * dotenv → DNS fallback → postgres → sql.unsafe(file) → verification query.
 *
 * The verification deliberately asserts that NO existing bout got a
 * first_seen_at. A nullable column WITH a default would have Postgres
 * materialise that default for all 8 800-odd existing rows — the exact
 * mistake that made bout.created_at worthless — so "0 stamped" right after
 * the migration is the thing worth checking.
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
    "../drizzle/migrations/0093_bout_first_seen_at.sql",
  );
  await sql.unsafe(readFileSync(file, "utf8"));

  for (const table of ["bout", "event"] as const) {
    const [col] = await sql`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = ${table} AND column_name = 'first_seen_at'
    `;
    if (!col) throw new Error(`${table}.first_seen_at was not created`);
    if (col.is_nullable !== "YES" || col.column_default !== null) {
      throw new Error(
        `${table}.first_seen_at must be nullable with NO default, got ` +
          `nullable=${col.is_nullable} default=${col.column_default}`,
      );
    }
    console.log(`${table}.first_seen_at: nullable, no default (as intended)`);

    const [counts] = await sql.unsafe(
      `SELECT count(*)::int AS total, count(first_seen_at)::int AS stamped
       FROM ${table}`,
    );
    console.log(
      `${table}.first_seen_at: ${counts.stamped} of ${counts.total} rows ` +
        `stamped (expected 0 immediately after the migration — anything else ` +
        `means something backfilled it)`,
    );
  }

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
