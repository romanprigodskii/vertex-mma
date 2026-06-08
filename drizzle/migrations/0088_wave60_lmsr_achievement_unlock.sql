-- Wave 60 — LMSR settle-time achievement unlock + refund-aware win count.
--
-- Two settlement-correctness fixes (batch b13-simulation):
--
--  1) unlock_betting_achievements counted refunds as wins. refund_market sets
--     bet.payout = coins_spent (with resolved_at) on a CANCELLED market, so the
--     bet_10_wins subquery `payout > 0 AND resolved_at IS NOT NULL` scored
--     refunds as phantom wins. A genuine LMSR win is a winning bet (payout > 0)
--     on a RESOLVED market, so the subquery now joins market and filters
--     status = 'resolved' — excluding refunds by the actual reason (cancelled)
--     while still counting genuine break-even wins. Mirrors the TS query in
--     src/lib/achievements.ts (checkAndUnlockAchievements).
--
--  2) The LMSR settle helpers (settle_market_winner / _method / _outcome)
--     credited a winning payout and promoted tier, but never called
--     unlock_betting_achievements — so an LMSR-only bettor who crossed
--     big_win / balance_50k / balance_100k / bet_10_wins via an LMSR payout got
--     no achievement (and no reward) until their next page action re-ran the TS
--     checker. They now unlock at settlement, mirroring
--     settle_fixed_odds_bets_for_bout. (p_odds = 1.0 → an LMSR win never trips
--     the sportsbook-only underdog_win.) The payout/balance locals are also
--     upgraded int → bigint, matching the Wave 58/59 money-path types so a
--     balance crossing ~2.1e9 can't overflow ("integer out of range").
--
-- NOT auto-applied. These PL/pgSQL functions live in (and are applied from) the
-- idempotent scripts: scripts/apply_notification_params.ts (the three
-- settle_market_* fns) and scripts/apply_parlay_settlement.ts
-- (unlock_betting_achievements). This file is the migration-of-record — KEEP IN
-- SYNC with those scripts. Apply manually after review (e.g. via the apply
-- scripts), not through drizzle-kit push.

-- 1) Refund-aware win count -------------------------------------------------
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
  -- A genuine LMSR win is a winning bet (payout > 0) on a RESOLVED market;
  -- refund_market leaves the market 'cancelled', so the resolved-market join
  -- keeps refunds from counting as phantom wins (and still counts a genuine
  -- break-even win).
  SELECT (SELECT count(*) FROM bet b JOIN market m ON m.id = b.market_id
            WHERE b.user_id = p_user_id AND b.payout > 0 AND m.status = 'resolved')
       + (SELECT count(*) FROM fixed_odds_bet WHERE user_id = p_user_id AND status = 'won')
       + (SELECT count(*) FROM parlay WHERE user_id = p_user_id AND status = 'won')
    INTO v_total_wins;
  IF v_total_wins >= 10 THEN PERFORM public.unlock_achievement(p_user_id, 'bet_10_wins'); END IF;
END;
$$;

-- 2a) settle_market_method --------------------------------------------------
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
    PERFORM public.unlock_betting_achievements(
      v_bet.user_id, v_payout, 1.0, false, v_new_balance);
  END LOOP;

  UPDATE bet
    SET payout = 0, resolved_at = NOW()
    WHERE market_id = p_market_id
      AND outcome_id <> v_winning_id
      AND resolved_at IS NULL;
END;
$function$;

-- 2b) settle_market_outcome -------------------------------------------------
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
    PERFORM public.unlock_betting_achievements(
      v_bet.user_id, v_payout, 1.0, false, v_new_balance);
  END LOOP;

  UPDATE bet
    SET payout = 0, resolved_at = NOW()
    WHERE market_id = p_market_id
      AND outcome_id <> v_winning_id
      AND resolved_at IS NULL;
END;
$function$;

-- 2c) settle_market_winner --------------------------------------------------
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
    PERFORM public.unlock_betting_achievements(
      v_bet.user_id, v_payout, 1.0, false, v_new_balance);
  END LOOP;

  UPDATE bet
    SET payout = 0, resolved_at = NOW()
    WHERE market_id = p_market_id
      AND outcome_id = v_losing_id
      AND resolved_at IS NULL;
END;
$function$;
