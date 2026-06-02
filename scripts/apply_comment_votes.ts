/**
 * Creates the news_comment_vote table (one up/down vote per user per comment).
 *
 * Targeted idempotent DDL (not `drizzle-kit push`, which can drop drift/RLS).
 * Re-runnable. Usage: npx tsx scripts/apply_comment_votes.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false, max: 1 });

async function main() {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS news_comment_vote (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      comment_id uuid NOT NULL REFERENCES news_comment(id) ON DELETE CASCADE,
      user_profile_id uuid NOT NULL REFERENCES user_profile(id) ON DELETE CASCADE,
      dir integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT news_comment_vote_unique UNIQUE (comment_id, user_profile_id)
    );
  `);
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS news_comment_vote_comment_idx ON news_comment_vote (comment_id);`,
  );
  console.log("news_comment_vote table + index ready.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
