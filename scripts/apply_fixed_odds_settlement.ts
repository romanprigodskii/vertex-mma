/**
 * Vertex Sportsbook — INSTANT settlement via DB trigger.
 *
 * Mirrors the LMSR on_bout_auto_settle pattern (drizzle 0059): an AFTER-UPDATE
 * trigger on `bout` grades every open fixed_odds_bet the moment the scraper
 * writes the result. The grading logic is a faithful port of the unit-tested
 * `settleSelection` in src/lib/sportsbook.ts — KEEP THE TWO IN SYNC.
 *
 *   won  → credit potential_payout (bet_won, +earned)
 *   void → refund stake             (bet_refunded, −lost)   [draw voids winner/
 *          method but settles distance/totals; NC/cancel void everything; DQ
 *          voids method only]
 *   lost → payout 0
 *
 * Idempotent (only status='open' rows). scripts/settle_fixed_odds.ts stays as
 * a cron backstop — the trigger is AFTER UPDATE, so a bout INSERTed already
 * completed (no UPDATE) is caught by the backstop, not the trigger.
 *
 * Re-runnable. Usage: npx tsx scripts/apply_fixed_odds_settlement.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false, max: 1 });

const GRADE_FN = `
CREATE OR REPLACE FUNCTION public.settle_fixed_odds_bets_for_bout(p_bout_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bout record;
  v_bet record;
  v_mb text;
  v_went_distance boolean;
  v_terminal_void boolean;
  v_outcome text;
  v_new_balance int;
BEGIN
  SELECT status::text AS status, winner_id, fighter_a_id, fighter_b_id,
         method::text AS method, round_finished
    INTO v_bout
  FROM bout WHERE id = p_bout_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_mb := CASE
    WHEN v_bout.method IN ('ko','tko')      THEN 'ko'
    WHEN v_bout.method = 'submission'        THEN 'sub'
    WHEN v_bout.method LIKE 'decision%'      THEN 'dec'
    WHEN v_bout.method = 'dq'                THEN 'dq'
    WHEN v_bout.method = 'draw'              THEN 'draw'
    WHEN v_bout.method = 'no_contest'        THEN 'nc'
    ELSE 'unknown'
  END;
  v_went_distance := v_mb IN ('dec','draw');

  -- Not resolved yet → nothing to do (mirrors the TS resolved-gate).
  IF v_bout.status NOT IN ('completed','no_contest','cancelled')
     AND v_bout.winner_id IS NULL
     AND v_mb NOT IN ('draw','nc') THEN
    RETURN;
  END IF;

  v_terminal_void := (v_bout.status = 'cancelled' OR v_bout.status = 'no_contest' OR v_mb = 'nc');

  FOR v_bet IN
    SELECT id, user_id, selection_code, stake_coins, potential_payout
    FROM fixed_odds_bet
    WHERE bout_id = p_bout_id AND status = 'open'
    FOR UPDATE
  LOOP
    IF v_terminal_void THEN
      v_outcome := 'void';
    ELSE
      v_outcome := CASE v_bet.selection_code
        WHEN 'win_a' THEN CASE WHEN v_bout.winner_id IS NULL THEN 'void' WHEN v_bout.winner_id = v_bout.fighter_a_id THEN 'won' ELSE 'lost' END
        WHEN 'win_b' THEN CASE WHEN v_bout.winner_id IS NULL THEN 'void' WHEN v_bout.winner_id = v_bout.fighter_b_id THEN 'won' ELSE 'lost' END
        WHEN 'a_ko'  THEN CASE WHEN v_bout.winner_id IS NULL OR v_mb='dq' THEN 'void' WHEN v_bout.winner_id = v_bout.fighter_a_id AND v_mb='ko'  THEN 'won' ELSE 'lost' END
        WHEN 'a_sub' THEN CASE WHEN v_bout.winner_id IS NULL OR v_mb='dq' THEN 'void' WHEN v_bout.winner_id = v_bout.fighter_a_id AND v_mb='sub' THEN 'won' ELSE 'lost' END
        WHEN 'a_dec' THEN CASE WHEN v_bout.winner_id IS NULL OR v_mb='dq' THEN 'void' WHEN v_bout.winner_id = v_bout.fighter_a_id AND v_mb='dec' THEN 'won' ELSE 'lost' END
        WHEN 'b_ko'  THEN CASE WHEN v_bout.winner_id IS NULL OR v_mb='dq' THEN 'void' WHEN v_bout.winner_id = v_bout.fighter_b_id AND v_mb='ko'  THEN 'won' ELSE 'lost' END
        WHEN 'b_sub' THEN CASE WHEN v_bout.winner_id IS NULL OR v_mb='dq' THEN 'void' WHEN v_bout.winner_id = v_bout.fighter_b_id AND v_mb='sub' THEN 'won' ELSE 'lost' END
        WHEN 'b_dec' THEN CASE WHEN v_bout.winner_id IS NULL OR v_mb='dq' THEN 'void' WHEN v_bout.winner_id = v_bout.fighter_b_id AND v_mb='dec' THEN 'won' ELSE 'lost' END
        WHEN 'o2_5'  THEN CASE WHEN v_went_distance THEN 'won' WHEN v_bout.round_finished IS NULL THEN 'void' WHEN v_bout.round_finished <= 2 THEN 'lost' ELSE 'won' END
        WHEN 'u2_5'  THEN CASE WHEN v_went_distance THEN 'lost' WHEN v_bout.round_finished IS NULL THEN 'void' WHEN v_bout.round_finished <= 2 THEN 'won' ELSE 'lost' END
        WHEN 'dist_yes' THEN CASE WHEN v_went_distance THEN 'won' ELSE 'lost' END
        WHEN 'dist_no'  THEN CASE WHEN v_went_distance THEN 'lost' ELSE 'won' END
        ELSE 'void'
      END;
    END IF;

    IF v_outcome = 'won' THEN
      UPDATE fixed_odds_bet SET status='won', payout=v_bet.potential_payout, settled_at=NOW() WHERE id=v_bet.id;
      UPDATE user_profile
        SET balance_coins = balance_coins + v_bet.potential_payout,
            total_coins_earned = total_coins_earned + v_bet.potential_payout
        WHERE id = v_bet.user_id
        RETURNING balance_coins INTO v_new_balance;
      INSERT INTO transaction (user_id, type, amount, balance_after, description)
      VALUES (v_bet.user_id, 'bet_won', v_bet.potential_payout, v_new_balance,
              'Sportsbook win on bout ' || p_bout_id);
    ELSIF v_outcome = 'void' THEN
      UPDATE fixed_odds_bet SET status='void', payout=v_bet.stake_coins, settled_at=NOW() WHERE id=v_bet.id;
      UPDATE user_profile
        SET balance_coins = balance_coins + v_bet.stake_coins,
            total_coins_lost = GREATEST(0, total_coins_lost - v_bet.stake_coins)
        WHERE id = v_bet.user_id
        RETURNING balance_coins INTO v_new_balance;
      INSERT INTO transaction (user_id, type, amount, balance_after, description)
      VALUES (v_bet.user_id, 'bet_refunded', v_bet.stake_coins, v_new_balance,
              'Sportsbook void refund on bout ' || p_bout_id);
    ELSE
      UPDATE fixed_odds_bet SET status='lost', payout=0, settled_at=NOW() WHERE id=v_bet.id;
    END IF;
  END LOOP;
END;
$$;
`;

const TRIGGER_FN = `
CREATE OR REPLACE FUNCTION public.on_bout_settle_fixed_odds()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('completed','no_contest','cancelled')
     AND (
       OLD.status IS DISTINCT FROM NEW.status
       OR OLD.winner_id IS DISTINCT FROM NEW.winner_id
       OR OLD.method IS DISTINCT FROM NEW.method
     )
  THEN
    PERFORM public.settle_fixed_odds_bets_for_bout(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
`;

async function main() {
  await sql.unsafe(GRADE_FN);
  await sql.unsafe(TRIGGER_FN);
  await sql.unsafe(`DROP TRIGGER IF EXISTS on_bout_settle_fixed_odds ON bout;`);
  await sql.unsafe(`
    CREATE TRIGGER on_bout_settle_fixed_odds
      AFTER UPDATE OF status, winner_id, method ON bout
      FOR EACH ROW EXECUTE FUNCTION public.on_bout_settle_fixed_odds();
  `);
  console.log(
    "Installed settle_fixed_odds_bets_for_bout() + on_bout_settle_fixed_odds trigger.",
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
