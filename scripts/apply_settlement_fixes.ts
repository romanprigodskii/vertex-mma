/**
 * Wave 57 — apply the two settlement correctness fixes.
 *
 * Runs drizzle/migrations/0085_wave57_settlement_fixes.sql, which CREATE OR
 * REPLACEs on_bout_auto_settle (DRAW → distance "Yes") and
 * settle_parlay_legs_for_bout (fully-won parlay pays the stored
 * potential_payout). Both are idempotent / re-runnable; the trigger bindings are
 * left untouched (the replaced bodies are picked up in place).
 *
 * Usage: npx tsx scripts/apply_settlement_fixes.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { prepare: false, max: 1 });

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(
  here,
  "..",
  "drizzle",
  "migrations",
  "0085_wave57_settlement_fixes.sql",
);

async function main() {
  const ddl = readFileSync(migrationPath, "utf8");
  // Single simple-protocol batch (prepare:false) — handles the dollar-quoted
  // function bodies and runs both CREATE OR REPLACE statements together.
  await sql.unsafe(ddl);

  const fns = await sql.unsafe(`
    SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND proname IN ('on_bout_auto_settle', 'settle_parlay_legs_for_bout')
    ORDER BY proname
  `);
  console.log(
    `Applied 0085_wave57_settlement_fixes. Present: ${fns
      .map((r) => r.proname)
      .join(", ")}`,
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
