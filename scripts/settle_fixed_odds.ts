/**
 * Vertex Sportsbook — settle fixed-odds bets for resolved bouts.
 *
 * Finds every bout with open fixed_odds_bet rows that has resolved (winner
 * recorded, or a terminal draw / no-contest) and grades each bet with the
 * SAME pure `settleSelection` the unit tests cover:
 *   • won  → credit potential_payout (transaction 'bet_won', +earned)
 *   • void → refund stake             (transaction 'bet_refunded')
 *   • lost → no balance change (stake was debited at placement)
 *
 * Idempotent (only status='open' rows are touched) and transactional per
 * bout, so a re-run after a crash can't double-pay.
 *
 * As of the instant-settlement pass, fixed-odds bets settle the moment the
 * scraper UPDATEs a bout's result, via the on_bout_settle_fixed_odds DB
 * trigger (scripts/apply_fixed_odds_settlement.ts) — same grading rules as
 * here. This script is now a BACKSTOP: the trigger is AFTER UPDATE, so a bout
 * INSERTed already completed (no UPDATE) won't fire it; a periodic cron run of
 * this catches those. Safe to run alongside the trigger (idempotent).
 *
 *   Usage: npx tsx scripts/settle_fixed_odds.ts [--dry]
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

import {
  type BoutResult,
  type SportsbookSelectionCode,
  isSelectionCode,
  settleSelection,
} from "../src/lib/sportsbook";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const DRY = process.argv.includes("--dry");
const sql = postgres(url, { prepare: false, max: 3 });

type BoutRow = {
  bout_id: string;
  status: string;
  winner_id: string | null;
  fighter_a_id: string;
  fighter_b_id: string;
  method: string | null;
  round_finished: number | null;
};

async function main() {
  // Bouts that (a) have at least one open fixed-odds bet and (b) have
  // resolved. The join to bout filters the work-list to just the bouts that
  // matter, so this stays cheap even with a large bet table.
  const bouts = (await sql`
    SELECT DISTINCT
      b.id::text AS bout_id,
      b.status::text AS status,
      b.winner_id::text AS winner_id,
      b.fighter_a_id::text AS fighter_a_id,
      b.fighter_b_id::text AS fighter_b_id,
      b.method::text AS method,
      b.round_finished
    FROM fixed_odds_bet fb
    JOIN bout b ON b.id = fb.bout_id
    WHERE fb.status = 'open'
      AND (
        b.status = 'completed'
        OR b.status = 'no_contest'
        OR b.winner_id IS NOT NULL
        OR b.method IN ('draw', 'no_contest')
      )
  `) as unknown as BoutRow[];

  console.log(`${bouts.length} resolved bout(s) with open fixed-odds bets.`);
  let totalGraded = 0;
  let totalWon = 0;
  let totalVoid = 0;
  let totalLost = 0;
  let coinsPaid = 0;

  for (const b of bouts) {
    const result: BoutResult = {
      status: b.status,
      winnerId: b.winner_id,
      fighterAId: b.fighter_a_id,
      fighterBId: b.fighter_b_id,
      method: b.method,
      roundFinished: b.round_finished,
    };

    await sql.begin(async (tx) => {
      const bets = (await tx`
        SELECT id::text AS id, user_id::text AS user_id, selection_code,
               stake_coins, potential_payout
        FROM fixed_odds_bet
        WHERE bout_id = ${b.bout_id}::uuid AND status = 'open'
        FOR UPDATE
      `) as unknown as Array<{
        id: string;
        user_id: string;
        selection_code: string;
        stake_coins: number;
        potential_payout: number;
      }>;

      for (const bet of bets) {
        const outcome = isSelectionCode(bet.selection_code)
          ? settleSelection(bet.selection_code as SportsbookSelectionCode, result)
          : "void";

        totalGraded++;
        if (DRY) {
          if (outcome === "won") { totalWon++; coinsPaid += bet.potential_payout; }
          else if (outcome === "void") { totalVoid++; coinsPaid += bet.stake_coins; }
          else totalLost++;
          continue;
        }

        if (outcome === "won") {
          await tx`UPDATE fixed_odds_bet SET status='won', payout=${bet.potential_payout}, settled_at=NOW() WHERE id=${bet.id}::uuid`;
          const bal = (await tx`
            UPDATE user_profile
            SET balance_coins = balance_coins + ${bet.potential_payout},
                total_coins_earned = total_coins_earned + ${bet.potential_payout}
            WHERE id = ${bet.user_id}::uuid
            RETURNING balance_coins
          `) as unknown as Array<{ balance_coins: number }>;
          await tx`
            INSERT INTO transaction (user_id, type, amount, balance_after, description)
            VALUES (${bet.user_id}::uuid, 'bet_won', ${bet.potential_payout},
                    ${bal[0]?.balance_coins ?? 0}, ${`Sportsbook win on bout ${b.bout_id}`})
          `;
          totalWon++;
          coinsPaid += bet.potential_payout;
        } else if (outcome === "void") {
          await tx`UPDATE fixed_odds_bet SET status='void', payout=${bet.stake_coins}, settled_at=NOW() WHERE id=${bet.id}::uuid`;
          const bal = (await tx`
            UPDATE user_profile
            SET balance_coins = balance_coins + ${bet.stake_coins},
                total_coins_lost = GREATEST(0, total_coins_lost - ${bet.stake_coins})
            WHERE id = ${bet.user_id}::uuid
            RETURNING balance_coins
          `) as unknown as Array<{ balance_coins: number }>;
          await tx`
            INSERT INTO transaction (user_id, type, amount, balance_after, description)
            VALUES (${bet.user_id}::uuid, 'bet_refunded', ${bet.stake_coins},
                    ${bal[0]?.balance_coins ?? 0}, ${`Sportsbook void refund on bout ${b.bout_id}`})
          `;
          totalVoid++;
          coinsPaid += bet.stake_coins;
        } else {
          await tx`UPDATE fixed_odds_bet SET status='lost', payout=0, settled_at=NOW() WHERE id=${bet.id}::uuid`;
          totalLost++;
        }
      }
    });
  }

  console.log(
    `${DRY ? "[DRY] " : ""}graded ${totalGraded} bet(s): ${totalWon} won, ${totalLost} lost, ${totalVoid} void; ${coinsPaid} coins paid out.`,
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
