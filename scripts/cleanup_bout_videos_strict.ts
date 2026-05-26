/**
 * Tighten bout_video to genuine full-fight uploads only.
 *
 * - Drops rows whose YouTube title doesn't contain "full fight" /
 *   "free fight" / "полный бой" (UFC's canonical labels for real fight
 *   uploads; siblings like "Finish Fight", "Highlights", "Fight Motion"
 *   are excluded).
 * - Drops rows longer than 35 minutes — UFC's "Full Fight Marathon"
 *   broadcasts share the FULL FIGHT label but are multi-hour compilation
 *   streams, not individual fights.
 * - Collapses the kind enum to free_fight for survivors so the UI can
 *   stop branching.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { install as installDnsFallback } from "../src/lib/dns-fallback";
installDnsFallback();
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

async function main() {
  const sql = postgres(url!, { prepare: false });

  const before = (await sql`SELECT count(*)::int AS n FROM bout_video`)[0].n;

  const deleted = await sql`
    DELETE FROM bout_video
    WHERE NOT (
      lower(title) LIKE '%full fight%'
      OR lower(title) LIKE '%free fight%'
      OR lower(title) LIKE '%полный бой%'
    )
    RETURNING id
  `;

  const deletedTooLong = await sql`
    DELETE FROM bout_video
    WHERE duration_seconds > ${35 * 60}
    RETURNING id
  `;

  const reclassified = await sql`
    UPDATE bout_video
    SET kind = 'free_fight'
    WHERE kind <> 'free_fight'
    RETURNING id
  `;

  const after = (await sql`SELECT count(*)::int AS n FROM bout_video`)[0].n;

  console.log(
    `bout_video: ${before} -> ${after} ` +
      `(label-deleted ${deleted.length}, too-long-deleted ${deletedTooLong.length}, ` +
      `reclassified ${reclassified.length})`,
  );
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
