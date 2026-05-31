/**
 * Adds the `user_profile_balance_non_negative` CHECK constraint
 * (balance_coins >= 0) as a DB-level backstop for the bet-debit money path.
 *
 * Apply this WITHOUT a full `drizzle-kit push` (push could drop migration-only
 * columns — see the current_division note). Re-runnable: it aborts cleanly if
 * any existing row already violates the invariant, and is a no-op if the
 * constraint already exists.
 *
 *   pnpm tsx scripts/add_balance_check_constraint.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

async function main() {
  const offenders = await sql<{ id: string; balance_coins: number }[]>`
    SELECT id::text AS id, balance_coins
    FROM user_profile
    WHERE balance_coins < 0
  `;
  if (offenders.length > 0) {
    console.error(
      `Refusing to add constraint: ${offenders.length} profile(s) already have a negative balance.`,
    );
    for (const o of offenders) console.error(`  ${o.id}: ${o.balance_coins}`);
    console.error("Reconcile these (likely victims of the pre-fix double-spend race) before applying.");
    await sql.end();
    process.exit(1);
  }

  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_profile_balance_non_negative'
      ) THEN
        ALTER TABLE user_profile
          ADD CONSTRAINT user_profile_balance_non_negative CHECK (balance_coins >= 0);
      END IF;
    END $$;
  `);

  const [{ exists }] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'user_profile_balance_non_negative'
    ) AS exists
  `;
  console.log(
    exists
      ? "OK: user_profile_balance_non_negative CHECK constraint is present."
      : "WARNING: constraint still missing after apply.",
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
