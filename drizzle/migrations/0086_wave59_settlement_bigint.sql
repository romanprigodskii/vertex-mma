-- Wave 59 — widen settlement money-path locals to bigint.
--
-- Wave 58 widened user_profile.balance_coins / total_coins_earned /
-- total_coins_lost and transaction.amount / balance_after to bigint, but the
-- settlement functions still declared their balance/payout locals (and the
-- unlock_betting_achievements parameters) as int4. `RETURNING balance_coins
-- INTO v_new_balance` then truncates / raises `integer out of range` once a
-- balance crosses the int4 ceiling (~2.147e9) — a single 1M-stake parlay can
-- pay floor(1e6 × 1000) = 1e9, so accumulated balances cross it — corrupting
-- the recorded transaction.balance_after and the balance_*k achievement gate.
--
-- This regenerates the three functions with bigint locals/params. The bodies
-- are otherwise IDENTICAL to the live Wave-49 (params) definitions — only the
-- declared types change. Idempotent: CREATE OR REPLACE everywhere, and the
-- old int4 unlock_betting_achievements overload is dropped first (its arg types
-- are part of its identity, so CREATE OR REPLACE alone would leave a duplicate
-- overload behind and make the call ambiguous).
--
-- KEEP IN SYNC with scripts/apply_parlay_settlement.ts (same definitions).

DROP FUNCTION IF EXISTS public.unlock_betting_achievements(uuid, int, real, boolean, int);

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
  SELECT (SELECT count(*) FROM bet WHERE user_id = p_user_id AND payout > 0 AND resolved_at IS NOT NULL)
       + (SELECT count(*) FROM fixed_odds_bet WHERE user_id = p_user_id AND status = 'won')
       + (SELECT count(*) FROM parlay WHERE user_id = p_user_id AND status = 'won')
    INTO v_total_wins;
  IF v_total_wins >= 10 THEN PERFORM public.unlock_achievement(p_user_id, 'bet_10_wins'); END IF;
END;
$$;

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

CREATE OR REPLACE FUNCTION public.settle_parlay_legs_for_bout(p_bout_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bout record; v_mb text; v_wd boolean; v_terminal_void boolean;
  v_leg record; v_outcome text;
  v_p record; v_open int; v_lost int; v_won int;
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
    SELECT p.id, p.stake_coins, p.user_id
    FROM parlay p
    WHERE p.status='open'
      AND EXISTS (SELECT 1 FROM parlay_leg pl WHERE pl.parlay_id=p.id AND pl.bout_id=p_bout_id)
    FOR UPDATE
  LOOP
    SELECT count(*) FILTER (WHERE status='open'),
           count(*) FILTER (WHERE status='lost'),
           count(*) FILTER (WHERE status='won')
      INTO v_open, v_lost, v_won
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
        SELECT LEAST(1000, round(exp(sum(ln(decimal_odds)))::numeric, 2))
          INTO v_combined FROM parlay_leg WHERE parlay_id=v_p.id AND status='won';
        v_payout := floor(v_p.stake_coins * v_combined)::bigint;
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
$$;
