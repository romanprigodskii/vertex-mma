/**
 * Applies drizzle/migrations/0094_fighter_sherdog_nationality.sql —
 * fighter.sherdog_flag_code / fighter.sherdog_nationality.
 *
 * Idempotent (IF NOT EXISTS); safe to re-run. Standard apply-script pattern:
 * dotenv → DNS fallback → postgres → sql.unsafe(file) → verification query.
 *
 * The verification asserts both columns are nullable with NO default, and
 * reports how many rows are populated. Right after the migration that is 0;
 * scripts/scraper/scripts/18_backfill_country_sherdog.py fills them. It also
 * prints how many fighters COULD be filled (sherdog_id IS NOT NULL) next to
 * the current country_code coverage, because the whole point of the column
 * is that the second number is much larger than the first.
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
    "../drizzle/migrations/0094_fighter_sherdog_nationality.sql",
  );
  await sql.unsafe(readFileSync(file, "utf8"));

  for (const column of ["sherdog_flag_code", "sherdog_nationality"] as const) {
    const [col] = await sql`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'fighter' AND column_name = ${column}
    `;
    if (!col) throw new Error(`fighter.${column} was not created`);
    if (col.is_nullable !== "YES" || col.column_default !== null) {
      throw new Error(
        `fighter.${column} must be nullable with NO default, got ` +
          `nullable=${col.is_nullable} default=${col.column_default}`,
      );
    }
    console.log(`fighter.${column}: nullable, no default (as intended)`);
  }

  const [counts] = await sql`
    SELECT count(*)::int                        AS total,
           count(country_code)::int             AS country_code,
           count(sherdog_id)::int               AS has_sherdog_id,
           count(sherdog_flag_code)::int        AS flag_filled
    FROM fighter
  `;
  console.log(
    `fighter: ${counts.total} rows · country_code ${counts.country_code} ` +
      `(${((100 * counts.country_code) / counts.total).toFixed(1)}%) · ` +
      `sherdog_id ${counts.has_sherdog_id} ` +
      `(${((100 * counts.has_sherdog_id) / counts.total).toFixed(1)}% — the ` +
      `ceiling for the new column) · flag filled ${counts.flag_filled}`,
  );

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
