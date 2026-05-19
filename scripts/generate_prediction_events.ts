/**
 * Auto-generate `prediction_event` rows for upcoming UFC events that don't
 * have one yet. Idempotent — re-running only inserts what's missing.
 *
 * Usage:
 *   pnpm predictions:generate            # up to --limit=100 events
 *   pnpm predictions:generate --limit=5
 *
 * Defaults: status='upcoming', opens_at=NOW(), closes_at=event.date
 * (matches market closes_at semantics — first-bout prelim is when picks lock).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const pg = postgres(url, { prepare: false });

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg
    ? Math.max(1, parseInt(limitArg.split("=")[1], 10))
    : 100;

  const candidates = await pg<
    Array<{ event_id: string; event_date: string; event_name: string }>
  >`
    SELECT
      e.id::text AS event_id,
      e.date::text AS event_date,
      e.name AS event_name
    FROM event e
    WHERE e.status IN ('upcoming', 'in_progress')
      AND e.promotion = 'ufc'
      AND e.date > NOW()
      AND NOT EXISTS (
        SELECT 1 FROM prediction_event WHERE event_id = e.id
      )
    ORDER BY e.date ASC
    LIMIT ${limit}
  `;

  console.log(
    `Found ${candidates.length} UFC events without a prediction_event.`,
  );

  let created = 0;
  for (const c of candidates) {
    try {
      await pg`
        INSERT INTO prediction_event (event_id, status, opens_at, closes_at)
        VALUES (
          ${c.event_id}::uuid,
          'upcoming',
          NOW(),
          ${c.event_date}::timestamptz
        )
      `;
      created++;
    } catch (e) {
      console.error(`Failed for event ${c.event_id}:`, e);
    }
  }
  console.log(`Created ${created} prediction events.`);
  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
