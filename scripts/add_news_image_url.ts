/**
 * Adds news_item.image_url (lead image for the news feed). Apply WITHOUT a full
 * `drizzle-kit push` (push could drop migration-only columns / RLS). Idempotent.
 *
 *   pnpm tsx scripts/add_news_image_url.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

async function main() {
  await sql.unsafe(`ALTER TABLE news_item ADD COLUMN IF NOT EXISTS image_url text`);
  const [{ exists }] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'news_item' AND column_name = 'image_url'
    ) AS exists
  `;
  console.log(
    exists ? "OK: news_item.image_url present." : "WARNING: column still missing.",
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
