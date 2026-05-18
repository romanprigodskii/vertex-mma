-- Wave 39: auto-settle markets when the underlying bout flips to
-- `completed` (or `cancelled`).
--
-- Three pieces:
--   settle_market_winner(market_id, idx)  PL/pgSQL helper that pays out
--                                          winners + zeroes losers
--                                          (idempotent: skips already-
--                                          resolved markets).
--   refund_market(market_id, reason)      Cancels a market and refunds
--                                          every unresolved bet at
--                                          coins_spent.
--   on_bout_auto_settle                   AFTER-UPDATE trigger on bout
--                                          (cols: status, winner_id,
--                                          method) that picks helper to
--                                          call based on the bout outcome.
--
-- Methodology markets (KO/Sub/Decision/etc.) are intentionally NOT handled
-- here — Wave 38 only seeds type='winner' markets. The trigger filters
-- `WHERE type = 'winner'` so future method-markets ride a separate code
-- path when they land.
--
-- All functions are SECURITY DEFINER so the trigger can fire from any
-- caller context (scraper UPDATE runs as `postgres`, but the same helpers
-- are also callable by the manual settle/refund scripts via SELECT).
-- search_path pinned to public.
--
-- Re-runnable.

-- ---------------------------------------------------------------------------
-- A) settle_market_winner — pay out a "winner" market in favor of idx
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.settle_market_winner(
  p_market_id uuid,
  p_winning_idx int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_winning_id uuid;
  v_losing_id uuid;
  v_bet record;
  v_payout int;
  v_new_balance int;
BEGIN
  IF p_winning_idx NOT IN (0, 1) THEN
    RAISE EXCEPTION 'winning_idx must be 0 or 1, got %', p_winning_idx;
  END IF;

  -- Idempotency: bail if the market is already resolved or cancelled.
  IF EXISTS (
    SELECT 1 FROM market
    WHERE id = p_market_id AND status IN ('resolved', 'cancelled')
  ) THEN
    RETURN;
  END IF;

  SELECT id INTO v_winning_id
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

  -- Pay out winning bets — each share = 1 coin.
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
  END LOOP;

  -- Mark losing bets resolved with payout 0.
  UPDATE bet
    SET payout = 0, resolved_at = NOW()
    WHERE market_id = p_market_id
      AND outcome_id = v_losing_id
      AND resolved_at IS NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- B) refund_market — cancel + refund every unresolved bet
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.refund_market(
  p_market_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bet record;
  v_new_balance int;
BEGIN
  -- Idempotency: bail if already terminal.
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

    -- Refund: bump balance back, and decrement total_coins_lost so the
    -- user's lifetime "coins lost" tally doesn't drift from reality.
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
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- C) Trigger on bout completion / cancellation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.on_bout_auto_settle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_market_id uuid;
BEGIN
  IF NEW.status = 'completed'
     AND (
       OLD.status IS DISTINCT FROM NEW.status
       OR OLD.winner_id IS DISTINCT FROM NEW.winner_id
       OR OLD.method IS DISTINCT FROM NEW.method
     )
  THEN
    FOR v_market_id IN
      SELECT id FROM market
      WHERE bout_id = NEW.id
        AND type = 'winner'
        AND status = 'open'
    LOOP
      IF NEW.method IS NOT NULL AND NEW.method::text = 'no_contest' THEN
        PERFORM public.refund_market(v_market_id, 'No contest');
      ELSIF NEW.winner_id IS NULL THEN
        PERFORM public.refund_market(v_market_id, 'Draw');
      ELSIF NEW.winner_id = NEW.fighter_a_id THEN
        PERFORM public.settle_market_winner(v_market_id, 0);
      ELSIF NEW.winner_id = NEW.fighter_b_id THEN
        PERFORM public.settle_market_winner(v_market_id, 1);
      ELSE
        -- winner_id points at a fighter not part of this bout — shouldn't
        -- happen, but refund rather than mis-pay if it does.
        PERFORM public.refund_market(v_market_id, 'Unknown winner');
      END IF;
    END LOOP;
  END IF;

  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM NEW.status THEN
    FOR v_market_id IN
      SELECT id FROM market WHERE bout_id = NEW.id AND status = 'open'
    LOOP
      PERFORM public.refund_market(v_market_id, 'Bout cancelled');
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_bout_auto_settle ON bout;
CREATE TRIGGER on_bout_auto_settle
  AFTER UPDATE OF status, winner_id, method ON bout
  FOR EACH ROW EXECUTE FUNCTION public.on_bout_auto_settle();
