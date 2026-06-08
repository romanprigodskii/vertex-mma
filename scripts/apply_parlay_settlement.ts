/**
 * Vertex Sportsbook — instant PARLAY settlement (+ DRY the grading truth).
 *
 * Extracts the per-selection grading into two IMMUTABLE SQL helpers so single
 * bets AND parlay legs grade through ONE source (no drift):
 *   fixed_odds_method_bucket(method)  → ko|sub|dec|dq|draw|nc|unknown
 *   fixed_odds_grade(code, winner, a, b, mb, went_distance, round) → won|lost|void
 * (port of settleSelection's switch; terminal void — cancel/NC — handled by
 * the callers, mirroring the TS structure. An 'unknown' bucket — completed bout,
 * method not yet scraped — grades winner-only and voids the rest, like the TS.)
 *
 * settle_fixed_odds_bets_for_bout is refactored onto these helpers (same
 * behaviour, re-verified). settle_parlay_legs_for_bout grades a bout's open
 * legs then finalizes each affected parlay: any leg lost → parlay lost now
 * (even with legs still open — it's dead); else once all legs resolve, all
 * void → refund stake, otherwise won — paying the slip's stored potential_payout
 * when no leg voided, or floor(stake × Π surviving odds) re-priced when a void
 * leg dropped out. The trigger calls both settle fns.
 *
 * MONEY-PATH TYPES: balance / payout locals are bigint — user_profile.balance_
 * coins and transaction.balance_after are bigint (Wave 58), so an int4 local
 * would overflow / `integer out of range` once a balance crosses ~2.1e9 (a
 * 1M-stake parlay can pay 1e9). unlock_betting_achievements likewise takes
 * bigint. KEEP IN SYNC with drizzle/migrations/0086_wave59_settlement_bigint.sql.
 *
 * NOTIFICATIONS: every settlement notification dual-writes a structured `params`
 * jsonb ({key,coins}) so the client localizes title/body (the stored English is
 * only the fallback). Mirrors scripts/apply_notification_params.ts — KEEP THE
 * params IN SYNC so re-running either script can't regress RU localization.
 *
 * Idempotent / re-runnable. Usage: npx tsx scripts/apply_parlay_settlement.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false, max: 1 });

const METHOD_BUCKET_FN = `
CREATE OR REPLACE FUNCTION public.fixed_odds_method_bucket(p_method text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_method IN ('ko','tko')   THEN 'ko'
    WHEN p_method = 'submission'    THEN 'sub'
    WHEN p_method LIKE 'decision%'  THEN 'dec'
    WHEN p_method = 'dq'            THEN 'dq'
    WHEN p_method = 'draw'          THEN 'draw'
    WHEN p_method = 'no_contest'    THEN 'nc'
    ELSE 'unknown'
  END
$$;
`;

const GRADE_FN = `
CREATE OR REPLACE FUNCTION public.fixed_odds_grade(
  p_code text, p_winner uuid, p_a uuid, p_b uuid,
  p_mb text, p_went_distance boolean, p_round int
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  -- Mirror settleSelection (src/lib/sportsbook.ts): when the method bucket is
  -- 'unknown' (a completed bout whose method has not been scraped yet — common,
  -- the result often lands before the method) only the winner market can be
  -- graded (win_a/win_b, off winner_id); every method/totals/distance selection
  -- is VOID (refunded) until the method arrives. Without this guard, method
  -- codes fell through to 'lost' and totals/distance graded off a false
  -- went_distance / raw round, paying or busting real-coin props the reference
  -- grader refunds.
  SELECT CASE
    WHEN p_mb = 'unknown' AND p_code NOT IN ('win_a','win_b') THEN 'void'
    ELSE (CASE p_code
      WHEN 'win_a' THEN CASE WHEN p_winner IS NULL THEN 'void' WHEN p_winner = p_a THEN 'won' ELSE 'lost' END
      WHEN 'win_b' THEN CASE WHEN p_winner IS NULL THEN 'void' WHEN p_winner = p_b THEN 'won' ELSE 'lost' END
      WHEN 'a_ko'  THEN CASE WHEN p_winner IS NULL OR p_mb='dq' THEN 'void' WHEN p_winner=p_a AND p_mb='ko'  THEN 'won' ELSE 'lost' END
      WHEN 'a_sub' THEN CASE WHEN p_winner IS NULL OR p_mb='dq' THEN 'void' WHEN p_winner=p_a AND p_mb='sub' THEN 'won' ELSE 'lost' END
      WHEN 'a_dec' THEN CASE WHEN p_winner IS NULL OR p_mb='dq' THEN 'void' WHEN p_winner=p_a AND p_mb='dec' THEN 'won' ELSE 'lost' END
      WHEN 'b_ko'  THEN CASE WHEN p_winner IS NULL OR p_mb='dq' THEN 'void' WHEN p_winner=p_b AND p_mb='ko'  THEN 'won' ELSE 'lost' END
      WHEN 'b_sub' THEN CASE WHEN p_winner IS NULL OR p_mb='dq' THEN 'void' WHEN p_winner=p_b AND p_mb='sub' THEN 'won' ELSE 'lost' END
      WHEN 'b_dec' THEN CASE WHEN p_winner IS NULL OR p_mb='dq' THEN 'void' WHEN p_winner=p_b AND p_mb='dec' THEN 'won' ELSE 'lost' END
      WHEN 'o2_5'  THEN CASE WHEN p_went_distance THEN 'won' WHEN p_round IS NULL THEN 'void' WHEN p_round <= 2 THEN 'lost' ELSE 'won' END
      WHEN 'u2_5'  THEN CASE WHEN p_went_distance THEN 'lost' WHEN p_round IS NULL THEN 'void' WHEN p_round <= 2 THEN 'won' ELSE 'lost' END
      WHEN 'dist_yes' THEN CASE WHEN p_went_distance THEN 'won' ELSE 'lost' END
      WHEN 'dist_no'  THEN CASE WHEN p_went_distance THEN 'lost' ELSE 'won' END
      ELSE 'void'
    END)
  END
$$;
`;

// Settle-time achievement unlock for the sportsbook. The LMSR settle helpers
// already fire tier promotion + a win notification per winning bet; the
// fixed-odds / parlay path never did, so sportsbook wins only unlocked
// achievements (and promoted tiers) on the user's NEXT page action. This helper
// mirrors the win/balance conditions in src/lib/achievements.ts
// (checkAndUnlockAchievements) so the unlock happens at settlement. KEEP IN
// SYNC with that TS function. unlock_achievement is idempotent (no-op if the
// user already holds it, or the slug doesn't exist), and itself awards the
// reward, posts a notification, and re-checks tier.
//
// p_payout / p_new_balance are BIGINT: balances are bigint (Wave 58) and the
// balance_*k thresholds compare against them, so an int4 param would overflow.
// The old int4 signature is DROPped in main() before this runs (CREATE OR
// REPLACE can't change a parameter's type — it would create a second overload).
const UNLOCK_ACHIEVEMENTS_FN = `
CREATE OR REPLACE FUNCTION public.unlock_betting_achievements(
  p_user_id uuid, p_payout bigint, p_odds real, p_is_parlay boolean, p_new_balance bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_total_wins int;
BEGIN
  IF p_payout >= 5000 THEN PERFORM public.unlock_achievement(p_user_id, 'big_win'); END IF;
  IF p_is_parlay   THEN PERFORM public.unlock_achievement(p_user_id, 'parlay_win'); END IF;
  IF p_odds >= 3.0 THEN PERFORM public.unlock_achievement(p_user_id, 'underdog_win'); END IF;
  IF p_new_balance >= 100000 THEN PERFORM public.unlock_achievement(p_user_id, 'balance_100k'); END IF;
  IF p_new_balance >= 50000  THEN PERFORM public.unlock_achievement(p_user_id, 'balance_50k'); END IF;
  -- bet_10_wins: total settled wins across the LMSR market, fixed-odds and parlays.
  SELECT (SELECT count(*) FROM bet WHERE user_id = p_user_id AND payout > 0 AND resolved_at IS NOT NULL)
       + (SELECT count(*) FROM fixed_odds_bet WHERE user_id = p_user_id AND status = 'won')
       + (SELECT count(*) FROM parlay WHERE user_id = p_user_id AND status = 'won')
    INTO v_total_wins;
  IF v_total_wins >= 10 THEN PERFORM public.unlock_achievement(p_user_id, 'bet_10_wins'); END IF;
END;
$$;
`;

const SETTLE_BETS_FN = `
CREATE OR REPLACE FUNCTION public.settle_fixed_odds_bets_for_bout(p_bout_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bout record; v_mb text; v_wd boolean; v_terminal_void boolean;
  v_bet record; v_outcome text; v_new_balance bigint;
BEGIN
  SELECT status::text AS status, winner_id, fighter_a_id, fighter_b_id,
         method::text AS method, round_finished
    INTO v_bout FROM bout WHERE id = p_bout_id;
  IF NOT FOUND THEN RETURN; END IF;
  v_mb := fixed_odds_method_bucket(v_bout.method);
  v_wd := v_mb IN ('dec','draw');
  IF v_bout.status NOT IN ('completed','no_contest','cancelled')
     AND v_bout.winner_id IS NULL AND v_mb NOT IN ('draw','nc') THEN RETURN; END IF;
  v_terminal_void := (v_bout.status='cancelled' OR v_bout.status='no_contest' OR v_mb='nc');

  FOR v_bet IN
    SELECT id, user_id, selection_code, stake_coins, potential_payout, decimal_odds
    FROM fixed_odds_bet WHERE bout_id = p_bout_id AND status='open' FOR UPDATE
  LOOP
    IF v_terminal_void THEN v_outcome := 'void';
    ELSE v_outcome := fixed_odds_grade(v_bet.selection_code, v_bout.winner_id,
                        v_bout.fighter_a_id, v_bout.fighter_b_id, v_mb, v_wd, v_bout.round_finished);
    END IF;

    IF v_outcome = 'won' THEN
      UPDATE fixed_odds_bet SET status='won', payout=v_bet.potential_payout, settled_at=NOW() WHERE id=v_bet.id;
      UPDATE user_profile SET balance_coins=balance_coins+v_bet.potential_payout,
             total_coins_earned=total_coins_earned+v_bet.potential_payout
        WHERE id=v_bet.user_id RETURNING balance_coins INTO v_new_balance;
      INSERT INTO transaction (user_id,type,amount,balance_after,description)
        VALUES (v_bet.user_id,'bet_won',v_bet.potential_payout,v_new_balance,'Sportsbook win on bout '||p_bout_id);
      -- Mirror the LMSR settle side-effects the fixed-odds path was missing:
      -- a win notification (with localizable params), tier promotion, unlock.
      INSERT INTO notification (user_id,type,title,body,link,params)
        VALUES (v_bet.user_id,'bet_settled',
                'Bet won · +'||v_bet.potential_payout||' coins',
                'Your sportsbook pick hit — '||v_bet.potential_payout||' coins paid out.',
                '/me/bets',
                jsonb_build_object('key','sportsbook_won','coins',v_bet.potential_payout));
      PERFORM public.check_and_promote_tier(v_bet.user_id);
      PERFORM public.unlock_betting_achievements(
        v_bet.user_id, v_bet.potential_payout, v_bet.decimal_odds, false, v_new_balance);
    ELSIF v_outcome = 'void' THEN
      UPDATE fixed_odds_bet SET status='void', payout=v_bet.stake_coins, settled_at=NOW() WHERE id=v_bet.id;
      UPDATE user_profile SET balance_coins=balance_coins+v_bet.stake_coins,
             total_coins_lost=GREATEST(0,total_coins_lost-v_bet.stake_coins)
        WHERE id=v_bet.user_id RETURNING balance_coins INTO v_new_balance;
      INSERT INTO transaction (user_id,type,amount,balance_after,description)
        VALUES (v_bet.user_id,'bet_refunded',v_bet.stake_coins,v_new_balance,'Sportsbook void refund on bout '||p_bout_id);
      INSERT INTO notification (user_id,type,title,body,link,params)
        VALUES (v_bet.user_id,'bet_settled',
                'Bet voided · '||v_bet.stake_coins||' coins refunded',
                'Your sportsbook bet was voided and your stake was returned.',
                '/me/bets',
                jsonb_build_object('key','sportsbook_void','coins',v_bet.stake_coins));
    ELSE
      UPDATE fixed_odds_bet SET status='lost', payout=0, settled_at=NOW() WHERE id=v_bet.id;
    END IF;
  END LOOP;
END;
$$;
`;

const SETTLE_PARLAY_FN = `
CREATE OR REPLACE FUNCTION public.settle_parlay_legs_for_bout(p_bout_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bout record; v_mb text; v_wd boolean; v_terminal_void boolean;
  v_leg record; v_outcome text;
  v_p record; v_open int; v_lost int; v_won int; v_void int;
  v_combined numeric; v_payout bigint; v_new_balance bigint;
BEGIN
  SELECT status::text AS status, winner_id, fighter_a_id, fighter_b_id,
         method::text AS method, round_finished
    INTO v_bout FROM bout WHERE id = p_bout_id;
  IF NOT FOUND THEN RETURN; END IF;
  v_mb := fixed_odds_method_bucket(v_bout.method);
  v_wd := v_mb IN ('dec','draw');
  IF v_bout.status NOT IN ('completed','no_contest','cancelled')
     AND v_bout.winner_id IS NULL AND v_mb NOT IN ('draw','nc') THEN RETURN; END IF;
  v_terminal_void := (v_bout.status='cancelled' OR v_bout.status='no_contest' OR v_mb='nc');

  -- 1) grade this bout's open legs
  FOR v_leg IN
    SELECT id, selection_code FROM parlay_leg WHERE bout_id = p_bout_id AND status='open' FOR UPDATE
  LOOP
    IF v_terminal_void THEN v_outcome := 'void';
    ELSE v_outcome := fixed_odds_grade(v_leg.selection_code, v_bout.winner_id,
                        v_bout.fighter_a_id, v_bout.fighter_b_id, v_mb, v_wd, v_bout.round_finished);
    END IF;
    UPDATE parlay_leg SET status = v_outcome::fixed_odds_bet_status, settled_at=NOW() WHERE id=v_leg.id;
  END LOOP;

  -- 2) finalize each still-open parlay touching this bout
  FOR v_p IN
    SELECT p.id, p.stake_coins, p.user_id, p.potential_payout, p.combined_odds
    FROM parlay p
    WHERE p.status='open'
      AND EXISTS (SELECT 1 FROM parlay_leg pl WHERE pl.parlay_id=p.id AND pl.bout_id=p_bout_id)
    FOR UPDATE
  LOOP
    SELECT count(*) FILTER (WHERE status='open'),
           count(*) FILTER (WHERE status='lost'),
           count(*) FILTER (WHERE status='won'),
           count(*) FILTER (WHERE status='void')
      INTO v_open, v_lost, v_won, v_void
    FROM parlay_leg WHERE parlay_id = v_p.id;

    IF v_lost > 0 THEN
      -- dead parlay → settle lost now (even if legs remain open)
      UPDATE parlay SET status='lost', payout=0, settled_at=NOW() WHERE id=v_p.id;
    ELSIF v_open = 0 THEN
      IF v_won = 0 THEN
        UPDATE parlay SET status='void', payout=v_p.stake_coins, settled_at=NOW() WHERE id=v_p.id;
        UPDATE user_profile SET balance_coins=balance_coins+v_p.stake_coins,
               total_coins_lost=GREATEST(0,total_coins_lost-v_p.stake_coins)
          WHERE id=v_p.user_id RETURNING balance_coins INTO v_new_balance;
        INSERT INTO transaction (user_id,type,amount,balance_after,description)
          VALUES (v_p.user_id,'bet_refunded',v_p.stake_coins,v_new_balance,'Parlay void refund');
        INSERT INTO notification (user_id,type,title,body,link,params)
          VALUES (v_p.user_id,'bet_settled',
                  'Parlay voided · '||v_p.stake_coins||' coins refunded',
                  'Your parlay was voided and your stake was returned.',
                  '/me/bets',
                  jsonb_build_object('key','parlay_void','coins',v_p.stake_coins));
      ELSE
        -- Every surviving leg won. With NO void leg, pay the EXACT amount the
        -- slip quoted at placement (potential_payout) — recomputing it here via
        -- exp(sum(ln(decimal_odds))) over the float4 leg odds drifts a coin or
        -- two at the rounding boundary and underpays vs. what the user was shown.
        -- Only when a leg voided & dropped out do we re-price over the won legs.
        IF v_void = 0 THEN
          v_payout := v_p.potential_payout;
          v_combined := v_p.combined_odds;
        ELSE
          SELECT LEAST(1000, round(exp(sum(ln(decimal_odds)))::numeric, 2))
            INTO v_combined FROM parlay_leg WHERE parlay_id=v_p.id AND status='won';
          v_payout := floor(v_p.stake_coins * v_combined)::bigint;
        END IF;
        UPDATE parlay SET status='won', payout=v_payout, settled_at=NOW() WHERE id=v_p.id;
        UPDATE user_profile SET balance_coins=balance_coins+v_payout,
               total_coins_earned=total_coins_earned+v_payout
          WHERE id=v_p.user_id RETURNING balance_coins INTO v_new_balance;
        INSERT INTO transaction (user_id,type,amount,balance_after,description)
          VALUES (v_p.user_id,'bet_won',v_payout,v_new_balance,'Parlay win');
        -- Mirror the LMSR settle side-effects: win notification (localizable
        -- params), tier promotion, achievement unlock (parlay_win / etc.).
        INSERT INTO notification (user_id,type,title,body,link,params)
          VALUES (v_p.user_id,'bet_settled',
                  'Parlay won · +'||v_payout||' coins',
                  'Every leg of your parlay hit — '||v_payout||' coins paid out.',
                  '/me/bets',
                  jsonb_build_object('key','parlay_won','coins',v_payout));
        PERFORM public.check_and_promote_tier(v_p.user_id);
        PERFORM public.unlock_betting_achievements(
          v_p.user_id, v_payout, v_combined::real, true, v_new_balance);
      END IF;
    END IF;
  END LOOP;
END;
$$;
`;

const TRIGGER_FN = `
CREATE OR REPLACE FUNCTION public.on_bout_settle_fixed_odds()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('completed','no_contest','cancelled')
     AND (OLD.status IS DISTINCT FROM NEW.status
          OR OLD.winner_id IS DISTINCT FROM NEW.winner_id
          OR OLD.method IS DISTINCT FROM NEW.method)
  THEN
    PERFORM public.settle_fixed_odds_bets_for_bout(NEW.id);
    PERFORM public.settle_parlay_legs_for_bout(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
`;

async function main() {
  await sql.unsafe(METHOD_BUCKET_FN);
  await sql.unsafe(GRADE_FN);
  // CREATE OR REPLACE can't change a parameter's type, so the old int4
  // signature would linger as a second overload (ambiguous resolution). Drop
  // it first; the callers below resolve to the bigint version (int upcasts).
  await sql.unsafe(
    `DROP FUNCTION IF EXISTS public.unlock_betting_achievements(uuid, int, real, boolean, int);`,
  );
  await sql.unsafe(UNLOCK_ACHIEVEMENTS_FN);
  await sql.unsafe(SETTLE_BETS_FN);
  await sql.unsafe(SETTLE_PARLAY_FN);
  await sql.unsafe(TRIGGER_FN);
  await sql.unsafe(`DROP TRIGGER IF EXISTS on_bout_settle_fixed_odds ON bout;`);
  await sql.unsafe(`
    CREATE TRIGGER on_bout_settle_fixed_odds
      AFTER UPDATE OF status, winner_id, method ON bout
      FOR EACH ROW EXECUTE FUNCTION public.on_bout_settle_fixed_odds();
  `);
  console.log(
    "Installed grading helpers + unlock_betting_achievements (bigint) + settle_fixed_odds_bets_for_bout + settle_parlay_legs_for_bout + trigger.",
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
