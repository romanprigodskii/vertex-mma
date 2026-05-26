/**
 * Tighten bout_video to "full fight" / "полный бой" only.
 *
 * Drops every row whose YouTube title doesn't contain either canonical
 * label, then collapses the kind enum to a single value (free_fight) for
 * the survivors so the UI can stop branching on highlights.
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
      OR lower(title) LIKE '%полный бой%'
    )
    RETURNING id
  `;

  const reclassified = await sql`
    UPDATE bout_video
    SET kind = 'free_fight'
    WHERE kind <> 'free_fight'
    RETURNING id
  `;

  const after = (await sql`SELECT count(*)::int AS n FROM bout_video`)[0].n;

  console.log(`bout_video: ${before} -> ${after} (deleted ${deleted.length}, reclassified ${reclassified.length})`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
