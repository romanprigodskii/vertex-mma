/**
 * Applies drizzle/migrations/0060_wave40_engagement.sql:
 *   - RLS on achievement / user_achievement (public read).
 *   - 8 seed achievements.
 *   - unlock_achievement PL/pgSQL helper.
 *
 * Re-runnable.
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
    "drizzle/migrations/0060_wave40_engagement.sql",
  );
  const ddl = readFileSync(file, "utf8");
  console.log(`Applying ${file} ...`);
  await sql.unsafe(ddl);

  const rls = await sql<{ tablename: string; rowsecurity: boolean }[]>`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('achievement','user_achievement')
    ORDER BY tablename
  `;
  console.log("\nRLS:");
  for (const r of rls) console.log(`  ${r.tablename.padEnd(20)} ${r.rowsecurity ? "ON" : "OFF"}`);

  const seeded = await sql<{ slug: string; name: string }[]>`
    SELECT slug, name FROM achievement ORDER BY slug
  `;
  console.log("\nAchievements seeded:");
  for (const a of seeded) console.log(`  ${a.slug.padEnd(20)} ${a.name}`);

  const fns = await sql<{ routine_name: string }[]>`
    SELECT routine_name FROM information_schema.routines
    WHERE routine_schema = 'public' AND routine_name = 'unlock_achievement'
  `;
  console.log("\nFunctions:");
  for (const r of fns) console.log(`  ${r.routine_name}`);

  await sql.end();
  console.log("\nWave 40 migration applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
