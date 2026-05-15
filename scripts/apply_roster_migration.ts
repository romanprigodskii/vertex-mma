/**
 * Applies drizzle/migrations/0024_roster_status.sql to the configured DB.
 *
 * `pnpm db:push` can't run in non-interactive shells, and the migration is
 * pure additive DDL (new enum, new columns, two indexes), so we execute the
 * SQL directly. Re-running is unsafe because the migration is not idempotent;
 * if you need to re-run, drop the enum/columns first.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

async function main() {
  const file = path.resolve(
    process.argv[2] ?? "drizzle/migrations/0024_roster_status.sql",
  );
  const ddl = readFileSync(file, "utf8");
  console.log(`Applying ${file} ...`);
  await sql.unsafe(ddl);
  console.log("Migration applied.\n");

  const [{ count: total }] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM fighter
  `;
  const [{ count: unknown_count }] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM fighter WHERE roster_status = 'unknown'
  `;
  console.log(`Total fighters: ${total}`);
  console.log(`Default roster_status='unknown': ${unknown_count}`);
  console.log(`(Run \`pnpm roster:import\` next to populate.)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => sql.end());
