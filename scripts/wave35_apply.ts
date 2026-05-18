/**
 * Applies drizzle/migrations/0056_wave35_avatar_storage.sql:
 *   - storage.buckets row for "avatars" (public, 2 MB, PNG/JPEG/WebP)
 *   - storage.objects RLS policies (avatars_select_all + per-user write)
 *
 * Re-runnable. Verifies bucket + policy registration before exiting.
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
  const file = path.resolve("drizzle/migrations/0056_wave35_avatar_storage.sql");
  const ddl = readFileSync(file, "utf8");
  console.log(`Applying ${file} ...`);
  await sql.unsafe(ddl);

  const buckets = await sql<
    { id: string; public: boolean; file_size_limit: number | null }[]
  >`
    SELECT id, public, file_size_limit
    FROM storage.buckets
    WHERE id = 'avatars'
  `;
  console.log("\nBuckets:");
  for (const b of buckets) {
    console.log(
      `  ${b.id}  public=${b.public}  limit=${b.file_size_limit ?? "—"}`,
    );
  }

  const policies = await sql<{ polname: string }[]>`
    SELECT polname
    FROM pg_policy
    WHERE polrelid = 'storage.objects'::regclass
      AND polname LIKE 'avatars_%'
    ORDER BY polname
  `;
  console.log("\nstorage.objects policies:");
  for (const p of policies) console.log(`  ${p.polname}`);

  await sql.end();
  console.log("\nWave 35 migration applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
