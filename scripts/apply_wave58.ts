/**
 * Wave 58 — apply the pre-launch data-integrity hardening.
 *
 * Runs drizzle/migrations/0087_wave58_money_bigint_and_fks.sql:
 *   - coin accumulators int4 -> bigint (balance_coins, total_coins_earned,
 *     total_coins_lost, bet_count, transaction.amount/balance_after,
 *     market.total_volume)
 *   - LMSR shares real -> double precision (bet.shares_bought,
 *     market_outcome.current_shares)
 *   - deferred FKs (transaction.related_bet_id / related_achievement_id,
 *     news_comment.parent_id) + a hard FK user_profile.auth_user_id ->
 *     auth.users, plus re-asserting the on_auth_user_deleted trigger.
 *
 * The whole .sql runs as one implicit transaction (atomic). Idempotent /
 * re-runnable. After applying, prints the resulting column types + FK list so
 * you can eyeball the result.
 *
 * Usage: npx tsx scripts/apply_wave58.ts
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
  "0087_wave58_money_bigint_and_fks.sql",
);

async function main() {
  const ddl = readFileSync(migrationPath, "utf8");
  // Single simple-protocol batch (prepare:false) — runs the ALTERs, guarded FK
  // adds, and the dollar-quoted trigger function together as one transaction.
  await sql.unsafe(ddl);

  const types = await sql.unsafe(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE (table_name, column_name) IN (
      ('user_profile','balance_coins'), ('user_profile','total_coins_earned'),
      ('user_profile','total_coins_lost'), ('user_profile','bet_count'),
      ('transaction','amount'), ('transaction','balance_after'),
      ('market','total_volume'),
      ('bet','shares_bought'), ('market_outcome','current_shares')
    )
    ORDER BY table_name, column_name
  `);

  const fks = await sql.unsafe(`
    SELECT conname
    FROM pg_constraint
    WHERE conname IN (
      'transaction_related_bet_id_bet_id_fk',
      'transaction_related_achievement_id_achievement_id_fk',
      'news_comment_parent_id_news_comment_id_fk',
      'user_profile_auth_user_id_users_id_fk'
    )
    ORDER BY conname
  `);

  const trig = await sql.unsafe(`
    SELECT tgname FROM pg_trigger WHERE tgname = 'on_auth_user_deleted'
  `);

  console.log("Applied 0087_wave58_money_bigint_and_fks.\n\nColumn types:");
  for (const r of types) {
    console.log(`  ${r.table_name}.${r.column_name} -> ${r.data_type}`);
  }
  console.log("\nForeign keys present:");
  for (const r of fks) console.log(`  ${r.conname}`);
  if (!fks.some((r) => r.conname === "user_profile_auth_user_id_users_id_fk")) {
    console.log(
      "  (auth.users FK absent — see migration WARNING; trigger is the guard)",
    );
  }
  console.log(
    `\non_auth_user_deleted trigger: ${trig.length ? "present" : "MISSING"}`,
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
