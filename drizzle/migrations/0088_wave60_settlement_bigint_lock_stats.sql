-- Wave 60 — LMSR settlement money-path hardening + lifetime-stats reconciliation.
--
-- Three independent fixes to the settlement PL/pgSQL functions. CREATE OR
-- REPLACE everywhere, bodies otherwise verbatim from the live definitions, so
-- this is idempotent and re-runnable. NOT applied via `drizzle-kit push`
-- (which drops RLS/drift); apply with scripts/apply_wave60.ts (reads this file)
-- and the in-script source-of-truth copies stay in sync — see the KEEP-IN-SYNC
-- notes below.
--
-- [1] BIGINT money locals (the LMSR analogue of Wave 59).
--     Wave 58 widened user_profile.balance_coins / total_coins_earned /
--     total_coins_lost and transaction.amount / balance_after to bigint, but
--     Wave 59 only widened the fixed-odds / parlay settle functions. The four
--     LMSR functions below still declared `v_payout int; v_new_balance int`
--     (int4) and cast payouts with `ROUND(...)::int`. `RETURNING balance_coins
--     INTO v_new_balance` truncates / raises `integer out of range` once a
--     balance crosses the int4 ceiling (~2.147e9), corrupting the recorded
--     transaction.balance_after. Locals + payout casts are now bigint.
--     LIVE SOURCE: settle_market_winner / settle_market_method (Wave 47,
--     migration 0065), settle_market_outcome (Wave 48, migration 0066),
--     refund_market (Wave 46, migration 0064) — all later re-emitted WITH the
--     notification `params` dual-write by Wave 49 (scripts/apply_notification_
--     params.ts), which is the version copied here. Only the declared types +
--     the FOR-UPDATE lock + the total_coins_lost reversal change.
--
-- [2] EXPLICIT per-market row lock (idempotency hardening).
--     The functions guarded re-settlement with `status IN ('resolved',
--     'cancelled') → RETURN`, which is correct but relied on UPDATE ordering
--     under concurrency. `PERFORM 1 FROM market WHERE id = p_market_id FOR
--     UPDATE` is now the FIRST statement of each LMSR function: two racing
--     settle calls for the same market serialize, so the second blocks, then
--     observes status='resolved' and no-ops. Lock order (market → market_
--     outcome → user_profile) matches placeBetAction, so no new deadlock.
--     (The fixed-odds / parlay functions already lock their bet/parlay rows
--     with SELECT ... FOR UPDATE, so they need no market lock.)
--
-- [3] LIFETIME-STATS REVERSAL on a win (fixes double-counted "Coins lost").
--     Every placement (markets/actions.ts) optimistically adds the stake to
--     total_coins_lost; refund/void paths already reverse it with
--     `GREATEST(0, total_coins_lost - stake)`, but the WIN paths did not — so a
--     winning bet's stake stayed counted as lost AND its payout was added to
--     earned, making leaderboard "Coins lost" / net-worth wrong. The win
--     branches now mirror the existing refund/void reversal. Applied to ALL bet
--     types for consistency: LMSR (stake = bet.coins_spent), fixed-odds and
--     parlay (stake = stake_coins). The fixed-odds / parlay bodies are
--     otherwise verbatim from Wave 59 (migration 0086_wave59_settlement_bigint
--     / scripts/apply_parlay_settlement.ts) — only the reversal line is added.
--
-- [4] BIGINT for the two coin-earning helpers reached DURING settlement.
--     [1] only widened the LMSR functions' own locals, but every win branch
--     PERFORMs check_and_promote_tier, whose `SELECT total_coins_earned INTO
--     v_total_earned` used an int4 local — so a user past the int4 ceiling on
--     LIFETIME earned would raise `integer out of range` and roll back the
--     whole settlement, defeating [1]. unlock_achievement (reached on the
--     fixed-odds / parlay win path via unlock_betting_achievements) had the
--     same int4 `RETURNING balance_coins INTO v_new_balance`. Both locals are
--     now bigint; bodies otherwise verbatim from Wave 47/49 (migration 0065 /
--     scripts/apply_notification_params.ts). Added beyond the original four-
--     function brief because they are int4-overflow paths on the same
--     settlement transaction this migration hardens.

-- ===========================================================================
-- [A] LMSR settlement — bigint locals + market FOR UPDATE lock + win reversal.
--     KEEP IN SYNC with scripts/apply_notification_params.ts (same definitions).
-- ===========================================================================

-- A1) settle_market_winner (2-outcome winner market)
CREATE OR REPLACE FUNCTION public.settle_market_winner(p_market_id uuid, p_winning_idx integer)
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
  v_payout bigint;
  v_new_balance bigint;
BEGIN
  -- Wave 60: serialize concurrent settlement of this market FIRST, so two
  -- racing settle calls can't both pass the resolved/cancelled guard below.
  PERFORM 1 FROM market WHERE id = p_market_id FOR UPDATE;

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
    v_payout := ROUND(v_bet.shares_bought)::bigint;

    UPDATE bet
      SET payout = v_payout, resolved_at = NOW()
      WHERE id = v_bet.id;

    -- Wave 60: a winning bet's stake is no longer a loss — reverse the
    -- optimistic total_coins_lost bump made at placement (mirrors refund/void).
    UPDATE user_profile
      SET balance_coins = balance_coins + v_payout,
          total_coins_earned = total_coins_earned + v_payout,
          total_coins_lost = GREATEST(0, total_coins_lost - v_bet.coins_spent)
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
$function$;

-- A2) settle_market_method (winner × method market)
CREATE OR REPLACE FUNCTION public.settle_market_method(p_market_id uuid, p_winner_offset integer, p_method_offset integer)
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
  v_payout bigint;
  v_new_balance bigint;
BEGIN
  PERFORM 1 FROM market WHERE id = p_market_id FOR UPDATE;

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
          total_coins_earned = total_coins_earned + v_payout,
          total_coins_lost = GREATEST(0, total_coins_lost - v_bet.coins_spent)
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
$function$;

-- A3) settle_market_outcome (generic N-outcome market: round / distance / prop)
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
  PERFORM 1 FROM market WHERE id = p_market_id FOR UPDATE;

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
          total_coins_earned = total_coins_earned + v_payout,
          total_coins_lost = GREATEST(0, total_coins_lost - v_bet.coins_spent)
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

-- A4) refund_market (cancel + refund every unresolved bet)
--     Already reverses total_coins_lost; only bigint local + market lock added.
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
  PERFORM 1 FROM market WHERE id = p_market_id FOR UPDATE;

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

-- ===========================================================================
-- [B] Fixed-odds / parlay settlement — add the win-branch total_coins_lost
--     reversal (Wave 60 [3]). Already bigint (Wave 59); bodies otherwise
--     verbatim from migration 0086_wave59_settlement_bigint.
--     KEEP IN SYNC with scripts/apply_parlay_settlement.ts (same definitions).
-- ===========================================================================

-- B1) settle_fixed_odds_bets_for_bout
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
      -- Wave 60: reverse the optimistic total_coins_lost bump made at placement
      -- (a won stake is not a loss) — mirrors the void branch below.
      UPDATE user_profile SET balance_coins=balance_coins+v_bet.potential_payout,
             total_coins_earned=total_coins_earned+v_bet.potential_payout,
             total_coins_lost=GREATEST(0,total_coins_lost-v_bet.stake_coins)
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

-- B2) settle_parlay_legs_for_bout
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
        SELECT LEAST(1000, round(exp(sum(ln(decimal_odds)))::numeric, 2))
          INTO v_combined FROM parlay_leg WHERE parlay_id=v_p.id AND status='won';
        v_payout := floor(v_p.stake_coins * v_combined)::bigint;
        UPDATE parlay SET status='won', payout=v_payout, settled_at=NOW() WHERE id=v_p.id;
        -- Wave 60: reverse the optimistic total_coins_lost bump made at
        -- placement (a won stake is not a loss) — mirrors the void branch above.
        UPDATE user_profile SET balance_coins=balance_coins+v_payout,
               total_coins_earned=total_coins_earned+v_payout,
               total_coins_lost=GREATEST(0,total_coins_lost-v_p.stake_coins)
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

-- ===========================================================================
-- [C] Coin-earning helpers reached during settlement — widen int4 money locals
--     to bigint (Wave 60 [4]). Bodies otherwise verbatim from Wave 47/49.
--     KEEP IN SYNC with scripts/apply_notification_params.ts (same definitions).
-- ===========================================================================

-- C1) check_and_promote_tier — PERFORM'd in every settle win branch.
CREATE OR REPLACE FUNCTION public.check_and_promote_tier(p_user_id uuid)
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
$function$;

-- C2) unlock_achievement — reached on the fixed-odds / parlay win path via
--     unlock_betting_achievements (and from the post-commit TS achievements
--     pass). v_reward stays int (achievement.reward_coins is a small int4).
CREATE OR REPLACE FUNCTION public.unlock_achievement(p_user_id uuid, p_slug text)
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
$function$;
