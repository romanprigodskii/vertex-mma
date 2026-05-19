/**
 * Auto-generate markets for scheduled UFC bouts that don't already have
 * the full set. Idempotent — re-runs only insert what's missing.
 *
 * Five market types per bout (Wave 48):
 *
 *   type        question                       b   outcomes
 *   ----        --------                       --- ---------
 *   winner      Who wins?                      100 2  (A wins / B wins)
 *   method      How will it end?               200 6  (A/B × KO/Sub/Dec)
 *   round       Which round does it end?       150 N+1 (R1..RN + Decision)
 *   distance    Does it go the distance?       100 2  (Yes / No)
 *   prop        Any knockdown in the fight?    100 2  (Yes / No)
 *
 * Wave 44 — when a `bout_external_odds` row exists for the bout (winner
 * moneylines scraped from bestfightodds.com), seed the winner market
 * shares so the opening prices match sportsbook consensus (vig removed).
 * Method / round / distance / prop markets still open uniform because
 * those columns are NULL on the scraper side.
 *
 * Method-market outcome layout (order_index → label):
 *   0 A by KO/TKO     1 A by Submission     2 A by Decision
 *   3 B by KO/TKO     4 B by Submission     5 B by Decision
 *
 * Round-market outcome layout (idx → label):
 *   0..(N-1) Round 1..N, N Decision  (where N = bout.scheduled_rounds)
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

function sharesFromTargetProbs(probs: number[], b: number): number[] {
  if (!(b > 0)) throw new Error("b must be > 0");
  if (probs.length === 0) return [];
  const sum = probs.reduce((a, c) => a + c, 0);
  if (!(sum > 0)) throw new Error("Probs must sum to > 0");
  const normalised = probs.map((p) => p / sum);
  let minP = Infinity;
  for (const p of normalised) if (p < minP) minP = p;
  if (!(minP > 0)) throw new Error("All probs must be > 0");
  return normalised.map((p) => b * Math.log(p / minP));
}

function removeVig(probsWithVig: number[]): number[] {
  const sum = probsWithVig.reduce((a, c) => a + c, 0);
  if (!(sum > 0)) return probsWithVig;
  return probsWithVig.map((p) => p / sum);
}

type WinnerSeed = { shares: [number, number]; prices: [number, number] };

function seedWinnerFromOdds(
  decimalA: number | null,
  decimalB: number | null,
  b: number,
): WinnerSeed | null {
  if (!decimalA || !decimalB || decimalA <= 1 || decimalB <= 1) return null;
  const rawProbs = [1 / decimalA, 1 / decimalB];
  const fair = removeVig(rawProbs);
  const shares = sharesFromTargetProbs(fair, b);
  return {
    shares: [shares[0], shares[1]],
    prices: [fair[0], fair[1]],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg
    ? Math.max(1, parseInt(limitArg.split("=")[1], 10))
    : 100;

  const candidates = await pg<
    Array<{
      bout_id: string;
      event_date: string;
      fighter_a_name: string;
      fighter_b_name: string;
      scheduled_rounds: number;
      has_winner: boolean;
      has_method: boolean;
      has_round: boolean;
      has_distance: boolean;
      has_prop: boolean;
      odds_winner_a: number | null;
      odds_winner_b: number | null;
    }>
  >`
    SELECT
      b.id::text AS bout_id,
      e.date::text AS event_date,
      fa.name_en AS fighter_a_name,
      fb.name_en AS fighter_b_name,
      b.scheduled_rounds,
      EXISTS (SELECT 1 FROM market WHERE bout_id = b.id AND type = 'winner')   AS has_winner,
      EXISTS (SELECT 1 FROM market WHERE bout_id = b.id AND type = 'method')   AS has_method,
      EXISTS (SELECT 1 FROM market WHERE bout_id = b.id AND type = 'round')    AS has_round,
      EXISTS (SELECT 1 FROM market WHERE bout_id = b.id AND type = 'distance') AS has_distance,
      EXISTS (
        SELECT 1 FROM market
        WHERE bout_id = b.id
          AND type = 'prop'
          AND question ILIKE '%knockdown%'
      ) AS has_prop,
      o.winner_a_decimal AS odds_winner_a,
      o.winner_b_decimal AS odds_winner_b
    FROM bout b
    JOIN event e ON e.id = b.event_id
    JOIN fighter fa ON fa.id = b.fighter_a_id
    JOIN fighter fb ON fb.id = b.fighter_b_id
    LEFT JOIN bout_external_odds o
      ON o.bout_id = b.id AND o.source = 'bestfightodds'
    WHERE b.status = 'scheduled'
      AND e.status IN ('upcoming', 'in_progress')
      AND e.date > NOW()
      AND (
        NOT EXISTS (SELECT 1 FROM market WHERE bout_id = b.id AND type = 'winner')
        OR NOT EXISTS (SELECT 1 FROM market WHERE bout_id = b.id AND type = 'method')
        OR NOT EXISTS (SELECT 1 FROM market WHERE bout_id = b.id AND type = 'round')
        OR NOT EXISTS (SELECT 1 FROM market WHERE bout_id = b.id AND type = 'distance')
        OR NOT EXISTS (
          SELECT 1 FROM market
          WHERE bout_id = b.id
            AND type = 'prop'
            AND question ILIKE '%knockdown%'
        )
      )
    ORDER BY e.date ASC
    LIMIT ${limit}
  `;

  console.log(
    `Found ${candidates.length} scheduled bouts missing at least one market.`,
  );

  let createdWinner = 0;
  let createdWinnerSeeded = 0;
  let createdMethod = 0;
  let createdRound = 0;
  let createdDistance = 0;
  let createdProp = 0;

  for (const c of candidates) {
    const scheduledRounds =
      c.scheduled_rounds && c.scheduled_rounds > 0 ? c.scheduled_rounds : 3;
    try {
      await pg.begin(async (tx) => {
        // ----- winner -----
        if (!c.has_winner) {
          const winnerB = 100;
          const seed = seedWinnerFromOdds(
            c.odds_winner_a,
            c.odds_winner_b,
            winnerB,
          );

          const [m] = await tx<Array<{ id: string }>>`
            INSERT INTO market (
              bout_id, type, question, status, b_parameter, opens_at, closes_at
            )
            VALUES (
              ${c.bout_id}::uuid,
              'winner',
              'Who wins?',
              'open',
              ${winnerB},
              NOW(),
              ${c.event_date}::timestamptz
            )
            RETURNING id::text AS id
          `;

          const sharesA = seed ? seed.shares[0] : 0;
          const sharesB_ = seed ? seed.shares[1] : 0;
          const priceA = seed ? seed.prices[0] : 0.5;
          const priceB = seed ? seed.prices[1] : 0.5;

          await tx`
            INSERT INTO market_outcome (
              market_id, label, order_index, current_shares, current_price
            )
            VALUES
              (${m.id}::uuid, ${c.fighter_a_name + " wins"}, 0, ${sharesA}, ${priceA}),
              (${m.id}::uuid, ${c.fighter_b_name + " wins"}, 1, ${sharesB_}, ${priceB})
          `;
          createdWinner++;
          if (seed) createdWinnerSeeded++;
        }

        // ----- method -----
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

        // ----- round -----
        if (!c.has_round) {
          const nOutcomes = scheduledRounds + 1; // R1..RN + Decision
          const initialPrice = 1 / nOutcomes;
          const [m] = await tx<Array<{ id: string }>>`
            INSERT INTO market (
              bout_id, type, question, status, b_parameter, opens_at, closes_at
            )
            VALUES (
              ${c.bout_id}::uuid,
              'round',
              'Which round does it end?',
              'open',
              150,
              NOW(),
              ${c.event_date}::timestamptz
            )
            RETURNING id::text AS id
          `;
          for (let i = 0; i < scheduledRounds; i++) {
            const label = `Round ${i + 1}`;
            await tx`
              INSERT INTO market_outcome (
                market_id, label, order_index, current_shares, current_price
              )
              VALUES (${m.id}::uuid, ${label}, ${i}, 0, ${initialPrice})
            `;
          }
          await tx`
            INSERT INTO market_outcome (
              market_id, label, order_index, current_shares, current_price
            )
            VALUES (${m.id}::uuid, 'Decision', ${scheduledRounds}, 0, ${initialPrice})
          `;
          createdRound++;
        }

        // ----- distance -----
        if (!c.has_distance) {
          const [m] = await tx<Array<{ id: string }>>`
            INSERT INTO market (
              bout_id, type, question, status, b_parameter, opens_at, closes_at
            )
            VALUES (
              ${c.bout_id}::uuid,
              'distance',
              'Does it go the distance?',
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
              (${m.id}::uuid, 'Yes, goes to decision', 0, 0, 0.5),
              (${m.id}::uuid, 'No, finishes early',    1, 0, 0.5)
          `;
          createdDistance++;
        }

        // ----- prop (knockdown) -----
        if (!c.has_prop) {
          const [m] = await tx<Array<{ id: string }>>`
            INSERT INTO market (
              bout_id, type, question, status, b_parameter, opens_at, closes_at
            )
            VALUES (
              ${c.bout_id}::uuid,
              'prop',
              'Any knockdown in the fight?',
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
              (${m.id}::uuid, 'Yes', 0, 0, 0.5),
              (${m.id}::uuid, 'No',  1, 0, 0.5)
          `;
          createdProp++;
        }
      });
    } catch (e) {
      console.error(`Failed for bout ${c.bout_id}:`, e);
    }
  }

  console.log(
    `Created ${createdWinner} winner (${createdWinnerSeeded} seeded) + ${createdMethod} method + ${createdRound} round + ${createdDistance} distance + ${createdProp} prop.`,
  );
  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
