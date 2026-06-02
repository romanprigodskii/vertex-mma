/**
 * Creates the news_comment_flag table (reader abuse reports on comments).
 *
 * Applied as a targeted idempotent DDL rather than `drizzle-kit push` on
 * purpose: a full push can drop known schema drift (e.g. fighter
 * .current_division) and RLS policies. This only ever CREATEs IF NOT EXISTS.
 *
 * Re-runnable. Usage: npx tsx scripts/apply_comment_flags.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false, max: 1 });

async function main() {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS news_comment_flag (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      comment_id uuid NOT NULL REFERENCES news_comment(id) ON DELETE CASCADE,
      user_profile_id uuid NOT NULL REFERENCES user_profile(id) ON DELETE CASCADE,
      reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      CONSTRAINT news_comment_flag_unique UNIQUE (comment_id, user_profile_id)
    );
  `);
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS news_comment_flag_comment_idx ON news_comment_flag (comment_id);`,
  );
  console.log("news_comment_flag table + index ready.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
