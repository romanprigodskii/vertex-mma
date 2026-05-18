/**
 * Auto-generate markets for scheduled UFC bouts that don't already have
 * the full set. Idempotent — re-runs only insert what's missing.
 *
 * Two market types per bout (Wave 42):
 *
 *   type        = 'winner'          | 'method'
 *   question    = 'Who wins?'       | 'How will it end?'
 *   b_parameter = 100               | 200  (higher liquidity for 6 outcomes)
 *   outcomes    = 2 @ 0.5 each      | 6 @ 1/6 each
 *
 * Method-market outcome layout (order_index → label):
 *   0 A by KO/TKO     1 A by Submission     2 A by Decision
 *   3 B by KO/TKO     4 B by Submission     5 B by Decision
 *
 * Usage:
 *   pnpm markets:generate            # up to --limit=100 bouts
 *   pnpm markets:generate --limit=5
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const pg = postgres(url, { prepare: false });

const METHOD_INITIAL_PRICE = 1 / 6;

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg
    ? Math.max(1, parseInt(limitArg.split("=")[1], 10))
    : 100;

  // A bout is a candidate if it's missing AT LEAST ONE of (winner, method).
  // This lets a backfill run pick up bouts that already have a winner
  // market from a pre-Wave-42 generation pass.
  const candidates = await pg<
    Array<{
      bout_id: string;
      event_date: string;
      fighter_a_name: string;
      fighter_b_name: string;
      has_winner: boolean;
      has_method: boolean;
    }>
  >`
    SELECT
      b.id::text AS bout_id,
      e.date::text AS event_date,
      fa.name_en AS fighter_a_name,
      fb.name_en AS fighter_b_name,
      EXISTS (
        SELECT 1 FROM market WHERE bout_id = b.id AND type = 'winner'
      ) AS has_winner,
      EXISTS (
        SELECT 1 FROM market WHERE bout_id = b.id AND type = 'method'
      ) AS has_method
    FROM bout b
    JOIN event e ON e.id = b.event_id
    JOIN fighter fa ON fa.id = b.fighter_a_id
    JOIN fighter fb ON fb.id = b.fighter_b_id
    WHERE b.status = 'scheduled'
      AND e.status IN ('upcoming', 'in_progress')
      AND e.date > NOW()
      AND (
        NOT EXISTS (SELECT 1 FROM market WHERE bout_id = b.id AND type = 'winner')
        OR NOT EXISTS (SELECT 1 FROM market WHERE bout_id = b.id AND type = 'method')
      )
    ORDER BY e.date ASC
    LIMIT ${limit}
  `;

  console.log(
    `Found ${candidates.length} scheduled bouts missing at least one market type.`,
  );

  let createdWinner = 0;
  let createdMethod = 0;

  for (const c of candidates) {
    try {
      await pg.begin(async (tx) => {
        if (!c.has_winner) {
          const [m] = await tx<Array<{ id: string }>>`
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
          await tx`
            INSERT INTO market_outcome (
              market_id, label, order_index, current_shares, current_price
            )
            VALUES
              (${m.id}::uuid, ${c.fighter_a_name + " wins"}, 0, 0, 0.5),
              (${m.id}::uuid, ${c.fighter_b_name + " wins"}, 1, 0, 0.5)
          `;
          createdWinner++;
        }

        if (!c.has_method) {
          const [m] = await tx<Array<{ id: string }>>`
            INSERT INTO market (
              bout_id, type, question, status, b_parameter, opens_at, closes_at
            )
            VALUES (
              ${c.bout_id}::uuid,
              'method',
              'How will it end?',
              'open',
              200,
              NOW(),
              ${c.event_date}::timestamptz
            )
            RETURNING id::text AS id
          `;
          await tx`
            INSERT INTO market_outcome (
              market_id, label, order_index, current_shares, current_price
            )
            VALUES
              (${m.id}::uuid, ${c.fighter_a_name + " by KO/TKO"},     0, 0, ${METHOD_INITIAL_PRICE}),
              (${m.id}::uuid, ${c.fighter_a_name + " by Submission"}, 1, 0, ${METHOD_INITIAL_PRICE}),
              (${m.id}::uuid, ${c.fighter_a_name + " by Decision"},   2, 0, ${METHOD_INITIAL_PRICE}),
              (${m.id}::uuid, ${c.fighter_b_name + " by KO/TKO"},     3, 0, ${METHOD_INITIAL_PRICE}),
              (${m.id}::uuid, ${c.fighter_b_name + " by Submission"}, 4, 0, ${METHOD_INITIAL_PRICE}),
              (${m.id}::uuid, ${c.fighter_b_name + " by Decision"},   5, 0, ${METHOD_INITIAL_PRICE})
          `;
          createdMethod++;
        }
      });
    } catch (e) {
      console.error(`Failed for bout ${c.bout_id}:`, e);
    }
  }

  console.log(
    `Created ${createdWinner} winner + ${createdMethod} method markets.`,
  );
  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
