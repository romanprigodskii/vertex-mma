/**
 * Auto-generate "winner" markets for scheduled UFC bouts that don't already
 * have one. Idempotent — re-runs skip bouts whose market already exists.
 *
 * Usage:
 *   pnpm markets:generate            # up to --limit=100 markets
 *   pnpm markets:generate --limit=5  # cap at 5
 *
 * Each market is created with:
 *   type        = 'winner'
 *   question    = 'Who wins?'
 *   b_parameter = 100  (LMSR liquidity)
 *   closes_at   = event.date (approximates fight start)
 *   2 outcomes  — "{Fighter A} wins" / "{Fighter B} wins", q=0, price=0.5
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
  const limit = limitArg ? Math.max(1, parseInt(limitArg.split("=")[1], 10)) : 100;

  const candidates = await pg<
    Array<{
      bout_id: string;
      event_date: string;
      fighter_a_name: string;
      fighter_b_name: string;
    }>
  >`
    SELECT
      b.id::text AS bout_id,
      e.date::text AS event_date,
      fa.name_en AS fighter_a_name,
      fb.name_en AS fighter_b_name
    FROM bout b
    JOIN event e ON e.id = b.event_id
    JOIN fighter fa ON fa.id = b.fighter_a_id
    JOIN fighter fb ON fb.id = b.fighter_b_id
    WHERE b.status = 'scheduled'
      AND e.status IN ('upcoming', 'in_progress')
      AND e.date > NOW()
      AND NOT EXISTS (
        SELECT 1 FROM market m WHERE m.bout_id = b.id
      )
    ORDER BY e.date ASC
    LIMIT ${limit}
  `;

  console.log(`Found ${candidates.length} scheduled bouts without markets.`);

  let created = 0;
  for (const c of candidates) {
    try {
      await pg.begin(async (tx) => {
        const [marketRow] = await tx<Array<{ id: string }>>`
          INSERT INTO market (
            bout_id, type, question, status, b_parameter, opens_at, closes_at
          )
          VALUES (
            ${c.bout_id}::uuid,
            'winner',
            'Who wins?',
            'open',
            100,
            NOW(),
            ${c.event_date}::timestamptz
          )
          RETURNING id::text AS id
        `;
        const marketId = marketRow.id;
        await tx`
          INSERT INTO market_outcome (
            market_id, label, order_index, current_shares, current_price
          )
          VALUES
            (${marketId}::uuid, ${c.fighter_a_name + " wins"}, 0, 0, 0.5),
            (${marketId}::uuid, ${c.fighter_b_name + " wins"}, 1, 0, 0.5)
        `;
      });
      created++;
    } catch (e) {
      console.error(`Failed for bout ${c.bout_id}:`, e);
    }
  }

  console.log(`Created ${created} markets.`);
  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
