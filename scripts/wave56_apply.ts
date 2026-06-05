/**
 * Applies drizzle/migrations/0084_wave56_avatar_server_upload.sql:
 *   - drops the per-user write policies on storage.objects for the avatars
 *     bucket (insert / update / delete) added in Wave 35.
 *
 * Avatars are now written server-side via the service-role client
 * (uploadAvatarAction) with a session-derived path, so the client write
 * grant is dead. Public read (avatars_select_all) stays.
 *
 * Re-runnable. Prints the remaining avatars_* policies before exiting.
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
    "drizzle/migrations/0084_wave56_avatar_server_upload.sql",
  );
  const ddl = readFileSync(file, "utf8");
  console.log(`Applying ${file} ...`);
  await sql.unsafe(ddl);

  const policies = await sql<{ polname: string }[]>`
    SELECT polname
    FROM pg_policy
    WHERE polrelid = 'storage.objects'::regclass
      AND polname LIKE 'avatars_%'
    ORDER BY polname
  `;
  console.log("\nRemaining storage.objects avatars policies:");
  for (const p of policies) console.log(`  ${p.polname}`);
  if (policies.length === 1 && policies[0]?.polname === "avatars_select_all") {
    console.log("  ✓ only public-read remains; client write path removed");
  }

  await sql.end();
  console.log("\nWave 56 migration applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
