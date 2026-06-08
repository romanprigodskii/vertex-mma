/**
 * Wave 49 — notification body localization.
 *
 * Adds notification.params (jsonb) and DUAL-WRITES a structured {key, …}
 * payload alongside the existing English title/body in every PL/pgSQL function
 * that emits a notification. The client renders the localized string from
 * (type, params); the stored title/body remain as the fallback for old rows
 * and any unmapped variant, so nothing breaks if the i18n key is missing.
 *
 * The money-path logic in each function is COPIED VERBATIM from the live prod
 * definition (pg_get_functiondef) — the `INSERT INTO notification` gains a
 * `params` column. Two settlement-correctness changes are folded in to keep this
 * script consistent with the canonical Wave-60 definitions (otherwise re-running
 * it would regress them): (1) the balance/payout/earned locals are bigint, not
 * int4 — balances are bigint since Wave 58, so an int4 local overflows / raises
 * `integer out of range` once a balance crosses ~2.1e9 and rolls back the whole
 * settlement; (2) a fully-won parlay (no voided leg) pays the stored
 * potential_payout rather than recomputing it from the float4 leg odds.
 * KEEP IN SYNC with drizzle/migrations/0089_wave60_settlement_canonical.sql.
 *
 * Targeted idempotent DDL (not `drizzle-kit push`, which can drop drift/RLS).
 * Re-runnable. Usage: npx tsx scripts/apply_notification_params.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { prepare: false, max: 1 });

const STATEMENTS: string[] = [
  // 0) additive column — safe, keeps RLS/policies intact.
  `ALTER TABLE notification ADD COLUMN IF NOT EXISTS params jsonb;`,

  // 1) tier promotion (type 'system')
  `CREATE OR REPLACE FUNCTION public.check_and_promote_tier(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total_earned bigint;
  v_current_tier text;
  v_new_tier text;
  v_username text;
BEGIN
  SELECT total_coins_earned, tier::text, username
    INTO v_total_earned, v_current_tier, v_username
  FROM user_profile WHERE id = p_user_id;
  IF v_total_earned IS NULL THEN RETURN; END IF;

  v_new_tier := CASE
    WHEN v_total_earned >= 1000000 THEN 'champion'
    WHEN v_total_earned >= 500000  THEN 'diamond'
    WHEN v_total_earned >= 200000  THEN 'gold'
    WHEN v_total_earned >= 50000   THEN 'silver'
    ELSE                                 'bronze'
  END;

  IF v_new_tier <> v_current_tier THEN
    UPDATE user_profile
      SET tier = v_new_tier::user_tier
      WHERE id = p_user_id;

    INSERT INTO notification (user_id, type, title, body, link, params)
    VALUES (
      p_user_id,
      'system',
      'Tier upgrade · ' || UPPER(v_new_tier),
      'You crossed ' || v_total_earned ||
        ' lifetime coins earned. Daily bonus boosted!',
      CASE WHEN v_username IS NOT NULL
        THEN '/profile/' || v_username
        ELSE NULL
      END,
      jsonb_build_object('key', 'tier_upgrade', 'tier', v_new_tier, 'total', v_total_earned)
    );
  END IF;
END;
$function$`,

  // 2) refund_market (type 'bet_settled')
  `CREATE OR REPLACE FUNCTION public.refund_market(p_market_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bet record;
  v_new_balance bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM market
    WHERE id = p_market_id AND status IN ('resolved', 'cancelled')
  ) THEN
    RETURN;
  END IF;

  UPDATE market
    SET status = 'cancelled',
        resolved_at = NOW()
    WHERE id = p_market_id;

  FOR v_bet IN
    SELECT id, user_id, coins_spent
    FROM bet
    WHERE market_id = p_market_id AND resolved_at IS NULL
  LOOP
    UPDATE bet
      SET payout = v_bet.coins_spent,
          resolved_at = NOW()
      WHERE id = v_bet.id;

    UPDATE user_profile
      SET balance_coins = balance_coins + v_bet.coins_spent,
          total_coins_lost = GREATEST(0, total_coins_lost - v_bet.coins_spent)
      WHERE id = v_bet.user_id
      RETURNING balance_coins INTO v_new_balance;

    INSERT INTO transaction (
      user_id, type, amount, balance_after, description, related_bet_id
    )
    VALUES (
      v_bet.user_id,
      'bet_refunded',
      v_bet.coins_spent,
      v_new_balance,
      'Bet refunded (' || p_reason || ')',
      v_bet.id
    );

    INSERT INTO notification (user_id, type, title, body, link, params)
    VALUES (
      v_bet.user_id,
      'bet_settled',
      'Bet refunded · +' || v_bet.coins_spent || ' coins returned',
      p_reason,
      '/me/bets',
      jsonb_build_object('key', 'bet_refunded', 'coins', v_bet.coins_spent, 'reason', p_reason)
    );
  END LOOP;
END;
$function$`,

  // 2b) unlock_betting_achievements (bigint). settle_fixed_odds_bets_for_bout
  // and settle_parlay_legs_for_bout below PERFORM this with bigint args (Wave 60),
  // which resolve ONLY to the bigint overload — int8→int4 is an assignment-only
  // cast, not implicit, so the call can't fall back to the old int4 signature.
  // Install it here FIRST (before the settle fns that call it) so this script is
  // self-contained and doesn't silently depend on 0089 / apply_parlay_settlement.ts
  // having run; otherwise re-running only this script against a pre-Wave-59 DB
  // would fail to create/resolve those settle fns. The old int4 overload is dropped
  // first (its arg types are part of its identity, so CREATE OR REPLACE alone would
  // leave a second, ambiguous overload). KEEP IN SYNC with 0089_wave60.
  `DROP FUNCTION IF EXISTS public.unlock_betting_achievements(uuid, int, real, boolean, int);`,
  `CREATE OR REPLACE FUNCTION public.unlock_betting_achievements(
  p_user_id uuid, p_payout bigint, p_odds real, p_is_parlay boolean, p_new_balance bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_total_wins int;
BEGIN
  IF p_payout >= 5000 THEN PERFORM public.unlock_achievement(p_user_id, 'big_win'); END IF;
  IF p_is_parlay   THEN PERFORM public.unlock_achievement(p_user_id, 'parlay_win'); END IF;
  IF p_odds >= 3.0 THEN PERFORM public.unlock_achievement(p_user_id, 'underdog_win'); END IF;
  IF p_new_balance >= 100000 THEN PERFORM public.unlock_achievement(p_user_id, 'balance_100k'); END IF;
  IF p_new_balance >= 50000  THEN PERFORM public.unlock_achievement(p_user_id, 'balance_50k'); END IF;
  SELECT (SELECT count(*) FROM bet WHERE user_id = p_user_id AND payout > 0 AND resolved_at IS NOT NULL)
       + (SELECT count(*) FROM fixed_odds_bet WHERE user_id = p_user_id AND status = 'won')
       + (SELECT count(*) FROM parlay WHERE user_id = p_user_id AND status = 'won')
    INTO v_total_wins;
  IF v_total_wins >= 10 THEN PERFORM public.unlock_achievement(p_user_id, 'bet_10_wins'); END IF;
END;
$$`,

  // 3) settle_fixed_odds_bets_for_bout (won + void notifications)
  `CREATE OR REPLACE FUNCTION public.settle_fixed_odds_bets_for_bout(p_bout_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$`,

  // 4) settle_market_method (won notification)
  `CREATE OR REPLACE FUNCTION public.settle_market_method(p_market_id uuid, p_winner_offset integer, p_method_offset integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_winning_idx int;
  v_winning_id uuid;
  v_winning_label text;
  v_bet record;
  v_payout int;
  v_new_balance bigint;
BEGIN
  IF p_winner_offset NOT IN (0, 3) THEN
    RAISE EXCEPTION 'winner_offset must be 0 or 3, got %', p_winner_offset;
  END IF;
  IF p_method_offset NOT IN (0, 1, 2) THEN
    RAISE EXCEPTION 'method_offset must be 0/1/2, got %', p_method_offset;
  END IF;

  IF EXISTS (
    SELECT 1 FROM market
    WHERE id = p_market_id AND status IN ('resolved', 'cancelled')
  ) THEN
    RETURN;
  END IF;

  v_winning_idx := p_winner_offset + p_method_offset;

  SELECT id, label INTO v_winning_id, v_winning_label
  FROM market_outcome
  WHERE market_id = p_market_id AND order_index = v_winning_idx;
  IF v_winning_id IS NULL THEN
    RAISE EXCEPTION 'Method outcome idx % not found for market %',
      v_winning_idx, p_market_id;
  END IF;

  UPDATE market_outcome
    SET is_winning = (id = v_winning_id)
    WHERE market_id = p_market_id;

  UPDATE market
    SET status = 'resolved',
        resolved_outcome_id = v_winning_id,
        resolved_at = NOW()
    WHERE id = p_market_id;

  FOR v_bet IN
    SELECT id, user_id, shares_bought
    FROM bet
    WHERE market_id = p_market_id
      AND outcome_id = v_winning_id
      AND resolved_at IS NULL
  LOOP
    v_payout := ROUND(v_bet.shares_bought)::int;

    UPDATE bet
      SET payout = v_payout, resolved_at = NOW()
      WHERE id = v_bet.id;

    UPDATE user_profile
      SET balance_coins = balance_coins + v_payout,
          total_coins_earned = total_coins_earned + v_payout
      WHERE id = v_bet.user_id
      RETURNING balance_coins INTO v_new_balance;

    INSERT INTO transaction (
      user_id, type, amount, balance_after, description, related_bet_id
    )
    VALUES (
      v_bet.user_id,
      'bet_won',
      v_payout,
      v_new_balance,
      'Method bet won: ' || v_payout || ' coins from ' ||
        ROUND(v_bet.shares_bought::numeric, 2)::text || ' shares',
      v_bet.id
    );

    INSERT INTO notification (user_id, type, title, body, link, params)
    VALUES (
      v_bet.user_id,
      'bet_settled',
      'Method bet won · +' || v_payout || ' coins',
      'Your pick on "' || v_winning_label || '" hit — ' ||
        ROUND(v_bet.shares_bought::numeric, 2)::text || ' shares paid out.',
      '/me/bets',
      jsonb_build_object('key','method_won','coins',v_payout,'label',v_winning_label,'shares',ROUND(v_bet.shares_bought::numeric, 2))
    );

    PERFORM public.check_and_promote_tier(v_bet.user_id);
  END LOOP;

  UPDATE bet
    SET payout = 0, resolved_at = NOW()
    WHERE market_id = p_market_id
      AND outcome_id <> v_winning_id
      AND resolved_at IS NULL;
END;
$function$`,

  // 5) settle_market_outcome (won notification)
  `CREATE OR REPLACE FUNCTION public.settle_market_outcome(p_market_id uuid, p_winning_idx integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_winning_id uuid;
  v_winning_label text;
  v_bet record;
  v_payout int;
  v_new_balance bigint;
BEGIN
  IF p_winning_idx < 0 THEN
    RAISE EXCEPTION 'winning_idx must be >= 0, got %', p_winning_idx;
  END IF;

  IF EXISTS (
    SELECT 1 FROM market
    WHERE id = p_market_id AND status IN ('resolved', 'cancelled')
  ) THEN
    RETURN;
  END IF;

  SELECT id, label INTO v_winning_id, v_winning_label
  FROM market_outcome
  WHERE market_id = p_market_id AND order_index = p_winning_idx;
  IF v_winning_id IS NULL THEN
    RAISE EXCEPTION 'Outcome idx % not found for market %',
      p_winning_idx, p_market_id;
  END IF;

  UPDATE market_outcome
    SET is_winning = (id = v_winning_id)
    WHERE market_id = p_market_id;

  UPDATE market
    SET status = 'resolved',
        resolved_outcome_id = v_winning_id,
        resolved_at = NOW()
    WHERE id = p_market_id;

  FOR v_bet IN
    SELECT id, user_id, shares_bought, coins_spent
    FROM bet
    WHERE market_id = p_market_id
      AND outcome_id = v_winning_id
      AND resolved_at IS NULL
  LOOP
    v_payout := ROUND(v_bet.shares_bought)::int;

    UPDATE bet
      SET payout = v_payout, resolved_at = NOW()
      WHERE id = v_bet.id;

    UPDATE user_profile
      SET balance_coins = balance_coins + v_payout,
          total_coins_earned = total_coins_earned + v_payout
      WHERE id = v_bet.user_id
      RETURNING balance_coins INTO v_new_balance;

    INSERT INTO transaction (
      user_id, type, amount, balance_after, description, related_bet_id
    )
    VALUES (
      v_bet.user_id,
      'bet_won',
      v_payout,
      v_new_balance,
      'Bet won: ' || v_payout || ' coins from ' ||
        ROUND(v_bet.shares_bought::numeric, 2)::text || ' shares',
      v_bet.id
    );

    INSERT INTO notification (user_id, type, title, body, link, params)
    VALUES (
      v_bet.user_id,
      'bet_settled',
      'Bet won · +' || v_payout || ' coins',
      'Your pick on "' || v_winning_label || '" hit — ' ||
        ROUND(v_bet.shares_bought::numeric, 2)::text || ' shares paid out.',
      '/me/bets',
      jsonb_build_object('key','market_won','coins',v_payout,'label',v_winning_label,'shares',ROUND(v_bet.shares_bought::numeric, 2))
    );

    PERFORM public.check_and_promote_tier(v_bet.user_id);
  END LOOP;

  UPDATE bet
    SET payout = 0, resolved_at = NOW()
    WHERE market_id = p_market_id
      AND outcome_id <> v_winning_id
      AND resolved_at IS NULL;
END;
$function$`,

  // 6) settle_market_winner (won notification)
  `CREATE OR REPLACE FUNCTION public.settle_market_winner(p_market_id uuid, p_winning_idx integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_winning_id uuid;
  v_losing_id uuid;
  v_winning_label text;
  v_bet record;
  v_payout int;
  v_new_balance bigint;
BEGIN
  IF p_winning_idx NOT IN (0, 1) THEN
    RAISE EXCEPTION 'winning_idx must be 0 or 1, got %', p_winning_idx;
  END IF;

  IF EXISTS (
    SELECT 1 FROM market
    WHERE id = p_market_id AND status IN ('resolved', 'cancelled')
  ) THEN
    RETURN;
  END IF;

  SELECT id, label INTO v_winning_id, v_winning_label
  FROM market_outcome
  WHERE market_id = p_market_id AND order_index = p_winning_idx;
  IF v_winning_id IS NULL THEN
    RAISE EXCEPTION 'Winning outcome not found for market % idx %',
      p_market_id, p_winning_idx;
  END IF;

  SELECT id INTO v_losing_id
  FROM market_outcome
  WHERE market_id = p_market_id AND order_index <> p_winning_idx;

  UPDATE market_outcome SET is_winning = TRUE  WHERE id = v_winning_id;
  UPDATE market_outcome SET is_winning = FALSE WHERE id = v_losing_id;

  UPDATE market
    SET status = 'resolved',
        resolved_outcome_id = v_winning_id,
        resolved_at = NOW()
    WHERE id = p_market_id;

  FOR v_bet IN
    SELECT id, user_id, shares_bought, coins_spent
    FROM bet
    WHERE market_id = p_market_id
      AND outcome_id = v_winning_id
      AND resolved_at IS NULL
  LOOP
    v_payout := ROUND(v_bet.shares_bought)::int;

    UPDATE bet
      SET payout = v_payout, resolved_at = NOW()
      WHERE id = v_bet.id;

    UPDATE user_profile
      SET balance_coins = balance_coins + v_payout,
          total_coins_earned = total_coins_earned + v_payout
      WHERE id = v_bet.user_id
      RETURNING balance_coins INTO v_new_balance;

    INSERT INTO transaction (
      user_id, type, amount, balance_after, description, related_bet_id
    )
    VALUES (
      v_bet.user_id,
      'bet_won',
      v_payout,
      v_new_balance,
      'Bet won: ' || v_payout || ' coins from ' ||
        ROUND(v_bet.shares_bought::numeric, 2)::text || ' shares',
      v_bet.id
    );

    INSERT INTO notification (user_id, type, title, body, link, params)
    VALUES (
      v_bet.user_id,
      'bet_settled',
      'Bet won · +' || v_payout || ' coins',
      'Your pick on "' || v_winning_label || '" hit — ' ||
        ROUND(v_bet.shares_bought::numeric, 2)::text || ' shares paid out.',
      '/me/bets',
      jsonb_build_object('key','market_won','coins',v_payout,'label',v_winning_label,'shares',ROUND(v_bet.shares_bought::numeric, 2))
    );

    PERFORM public.check_and_promote_tier(v_bet.user_id);
  END LOOP;

  UPDATE bet
    SET payout = 0, resolved_at = NOW()
    WHERE market_id = p_market_id
      AND outcome_id = v_losing_id
      AND resolved_at IS NULL;
END;
$function$`,

  // 7) settle_parlay_legs_for_bout (won + void notifications)
  `CREATE OR REPLACE FUNCTION public.settle_parlay_legs_for_bout(p_bout_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  FOR v_leg IN
    SELECT id, selection_code FROM parlay_leg WHERE bout_id = p_bout_id AND status='open' FOR UPDATE
  LOOP
    IF v_terminal_void THEN v_outcome := 'void';
    ELSE v_outcome := fixed_odds_grade(v_leg.selection_code, v_bout.winner_id,
                        v_bout.fighter_a_id, v_bout.fighter_b_id, v_mb, v_wd, v_bout.round_finished);
    END IF;
    UPDATE parlay_leg SET status = v_outcome::fixed_odds_bet_status, settled_at=NOW() WHERE id=v_leg.id;
  END LOOP;

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
        -- Every surviving leg won. If NO leg voided, pay the EXACT amount we
        -- quoted on the slip at placement (potential_payout = floor(stake ×
        -- combined_odds)). Recomputing it here from the float4 leg odds via
        -- exp(sum(ln())) drifts a coin or two at the rounding boundary and
        -- silently underpays vs. the betslip. Only when a leg voided & dropped
        -- out do we re-price the combined odds across the surviving won legs.
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
$function$`,

  // 8) unlock_achievement (type 'achievement_unlocked')
  `CREATE OR REPLACE FUNCTION public.unlock_achievement(p_user_id uuid, p_slug text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_achievement_id uuid;
  v_reward int;
  v_new_balance bigint;
  v_name text;
  v_description text;
  v_username text;
BEGIN
  SELECT id, reward_coins, name, description
    INTO v_achievement_id, v_reward, v_name, v_description
  FROM achievement WHERE slug = p_slug;
  IF v_achievement_id IS NULL THEN
    RETURN FALSE;
  END IF;

  BEGIN
    INSERT INTO user_achievement (user_id, achievement_id)
    VALUES (p_user_id, v_achievement_id);
  EXCEPTION WHEN unique_violation THEN
    RETURN FALSE;
  END;

  IF v_reward > 0 THEN
    UPDATE user_profile
      SET balance_coins = balance_coins + v_reward,
          total_coins_earned = total_coins_earned + v_reward
      WHERE id = p_user_id
      RETURNING balance_coins INTO v_new_balance;

    INSERT INTO transaction (
      user_id, type, amount, balance_after, description, related_achievement_id
    )
    VALUES (
      p_user_id,
      'achievement',
      v_reward,
      v_new_balance,
      'Achievement unlocked: ' || v_name,
      v_achievement_id
    );
  END IF;

  SELECT username INTO v_username FROM user_profile WHERE id = p_user_id;
  INSERT INTO notification (user_id, type, title, body, link, params)
  VALUES (
    p_user_id,
    'achievement_unlocked',
    'Achievement unlocked: ' || v_name,
    COALESCE(v_description, '') ||
      CASE WHEN v_reward > 0 THEN ' (+' || v_reward || ' coins)' ELSE '' END,
    CASE WHEN v_username IS NOT NULL THEN '/profile/' || v_username ELSE NULL END,
    jsonb_build_object('key', 'achievement', 'slug', p_slug, 'reward', v_reward)
  );

  IF v_reward > 0 THEN
    PERFORM public.check_and_promote_tier(p_user_id);
  END IF;

  RETURN TRUE;
END;
$function$`,
];

async function main() {
  for (const stmt of STATEMENTS) {
    await sql.unsafe(stmt);
  }
  // Read back: confirm the column exists and every emitter now writes params.
  const col = await sql.unsafe(
    `SELECT 1 FROM information_schema.columns WHERE table_name='notification' AND column_name='params'`,
  );
  const emitters = await sql.unsafe(`
    SELECT proname FROM (
      SELECT p.proname, pg_get_functiondef(p.oid) AS def
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prokind='f'
    ) q
    WHERE q.def ILIKE '%INSERT INTO notification%'
      AND q.def NOT ILIKE '%title, body, link, params%'
      AND q.def NOT ILIKE '%title,body,link,params%'
    ORDER BY proname
  `);
  console.log(
    `params column present: ${col.length === 1}; emitters still missing params: ${JSON.stringify(emitters)}`,
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
