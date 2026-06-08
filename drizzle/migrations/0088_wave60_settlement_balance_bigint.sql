-- Wave 60 — finish the settlement bigint widening + record two correctness
-- fixes in migration history.
--
-- Context. Wave 58 (0087) widened user_profile.balance_coins /
-- total_coins_earned / total_coins_lost and transaction.amount / balance_after
-- to bigint. Wave 59 (0086_wave59) then widened the FIXED-ODDS path
-- (unlock_betting_achievements, settle_fixed_odds_bets_for_bout,
-- settle_parlay_legs_for_bout) to bigint, but left the LMSR path on int4 locals.
-- `RETURNING balance_coins INTO v_new_balance` (and ROUND(shares) → v_payout)
-- then truncates / raises `integer out of range` once a balance crosses the
-- int4 ceiling (~2.147e9).
--
-- What this migration regenerates (with bigint locals where they were int4):
--   • refund_market           — latest migration def was 0064 (int4)
--   • settle_market_outcome    — latest migration def was 0066 (int4)
--   • settle_parlay_legs_for_bout — see "fix B" below
-- (check_and_promote_tier, unlock_achievement, settle_market_winner and
-- settle_market_method are widened in place in 0065 — their latest migration
-- definition — so they need no re-issue here.)
--
-- It also records two settlement-correctness fixes that previously lived only in
-- the apply_*.ts scripts (or had regressed in migration order):
--   fix A — fixed_odds_grade / fixed_odds_method_bucket (the per-selection
--     grading helpers) existed only in scripts/apply_parlay_settlement.ts. They
--     are added here so the migration path has a correct grader. The grade
--     helper now mirrors settleSelection (src/lib/sportsbook.ts): a completed
--     bout whose method has not been scraped yet (bucket 'unknown') grades only
--     the winner market (win_a/win_b) and VOIDS every method/totals/distance
--     selection, instead of wrongly grading them won/lost.
--   fix B — settle_parlay_legs_for_bout pays the slip's stored potential_payout
--     when no leg voided (re-pricing only when a void leg dropped out). Wave 57
--     (0085) introduced this, but Wave 59 (0086_wave59) re-created the function
--     without it; this re-issue restores it AND keeps the bigint locals.
--
-- CANONICAL SOURCE: the live functions are installed by the apply_*.ts scripts
-- (scripts/apply_notification_params.ts + scripts/apply_parlay_settlement.ts);
-- the bodies here are byte-identical to those, kept in sync so no re-run of any
-- script or replay of any migration can reintroduce the int4 / grading / payout
-- regressions. Idempotent (CREATE OR REPLACE everywhere). NOT auto-applied.

-- ---------------------------------------------------------------------------
-- Grading helpers (fix A) — DRY truth shared by single bets AND parlay legs.
-- ---------------------------------------------------------------------------

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

CREATE OR REPLACE FUNCTION public.fixed_odds_grade(
  p_code text, p_winner uuid, p_a uuid, p_b uuid,
  p_mb text, p_went_distance boolean, p_round int
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  -- Mirror settleSelection (src/lib/sportsbook.ts): when the method bucket is
  -- 'unknown' (a completed bout whose method has not been scraped yet — common,
  -- the result often lands before the method) only the winner market can be
  -- graded (win_a/win_b, off winner_id); every method/totals/distance selection
  -- is VOID (refunded) until the method arrives.
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

-- ---------------------------------------------------------------------------
-- refund_market — bigint v_new_balance (was int4 in 0064).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.refund_market(p_market_id uuid, p_reason text)
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
$function$;

-- ---------------------------------------------------------------------------
-- settle_market_outcome — bigint v_payout / v_new_balance (was int4 in 0066).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.settle_market_outcome(p_market_id uuid, p_winning_idx integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_winning_id uuid;
  v_winning_label text;
  v_bet record;
  v_payout bigint;
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
    v_payout := ROUND(v_bet.shares_bought)::bigint;

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
$function$;

-- ---------------------------------------------------------------------------
-- settle_parlay_legs_for_bout — bigint locals (fix B restores the Wave-57
-- stored-payout path that 0086_wave59 dropped).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.settle_parlay_legs_for_bout(p_bout_id uuid)
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
$function$;
