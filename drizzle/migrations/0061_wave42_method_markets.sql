-- Wave 42: methodology ("How will it end?") markets.
--
-- Outcomes per method market, by order_index:
--   0 = A by KO/TKO    1 = A by Submission    2 = A by Decision
--   3 = B by KO/TKO    4 = B by Submission    5 = B by Decision
--
-- settle_market_method picks the winning idx from a (winner_offset,
-- method_offset) tuple; the trigger maps bout (winner_id, method) to that
-- tuple and routes to settle_market_method for type='method' markets,
-- settle_market_winner for type='winner' markets, refund_market for any
-- draw / no_contest / cancelled.
--
-- Helpers from Wave 39 (settle_market_winner, refund_market) stay
-- untouched; only the trigger function and the new settle_market_method
-- helper change.

-- ---------------------------------------------------------------------------
-- settle_market_method
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.settle_market_method(
  p_market_id uuid,
  p_winner_offset int,
  p_method_offset int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_winning_idx int;
  v_winning_id uuid;
  v_bet record;
  v_payout int;
  v_new_balance int;
BEGIN
  IF p_winner_offset NOT IN (0, 3) THEN
    RAISE EXCEPTION 'winner_offset must be 0 or 3, got %', p_winner_offset;
  END IF;
  IF p_method_offset NOT IN (0, 1, 2) THEN
    RAISE EXCEPTION 'method_offset must be 0/1/2, got %', p_method_offset;
  END IF;

  -- Idempotency: bail if already terminal.
  IF EXISTS (
    SELECT 1 FROM market
    WHERE id = p_market_id AND status IN ('resolved', 'cancelled')
  ) THEN
    RETURN;
  END IF;

  v_winning_idx := p_winner_offset + p_method_offset;

  SELECT id INTO v_winning_id
  FROM market_outcome
  WHERE market_id = p_market_id AND order_index = v_winning_idx;
  IF v_winning_id IS NULL THEN
    RAISE EXCEPTION 'Method outcome idx % not found for market %',
      v_winning_idx, p_market_id;
  END IF;

  -- Flip is_winning across all six outcomes in one shot.
  UPDATE market_outcome
    SET is_winning = (id = v_winning_id)
    WHERE market_id = p_market_id;

  UPDATE market
    SET status = 'resolved',
        resolved_outcome_id = v_winning_id,
        resolved_at = NOW()
    WHERE id = p_market_id;

  -- Pay out winning bets (1 share = 1 coin).
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
  END LOOP;

  -- Mark losing bets resolved with payout 0.
  UPDATE bet
    SET payout = 0, resolved_at = NOW()
    WHERE market_id = p_market_id
      AND outcome_id <> v_winning_id
      AND resolved_at IS NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Updated trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.on_bout_auto_settle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_market record;
  v_winner_offset int;
  v_method_offset int;
  v_can_settle_method boolean;
  v_is_refund boolean;
  v_refund_reason text;
BEGIN
  IF NEW.status = 'completed'
     AND (
       OLD.status IS DISTINCT FROM NEW.status
       OR OLD.winner_id IS DISTINCT FROM NEW.winner_id
       OR OLD.method IS DISTINCT FROM NEW.method
     )
  THEN
    -- Classify the method category (KO/TKO=0, Sub=1, Decision=2). Anything
    -- else leaves v_can_settle_method=false so we refund the method
    -- market while still settling the winner market.
    v_can_settle_method := FALSE;
    v_method_offset := -1;
    IF NEW.method IS NOT NULL THEN
      IF NEW.method::text IN ('ko', 'tko') THEN
        v_method_offset := 0;
        v_can_settle_method := TRUE;
      ELSIF NEW.method::text = 'submission' THEN
        v_method_offset := 1;
        v_can_settle_method := TRUE;
      ELSIF NEW.method::text LIKE 'decision%' THEN
        v_method_offset := 2;
        v_can_settle_method := TRUE;
      END IF;
    END IF;

    -- Map winner to the fighter offset used by the method outcome grid.
    IF NEW.winner_id = NEW.fighter_a_id THEN
      v_winner_offset := 0;
    ELSIF NEW.winner_id = NEW.fighter_b_id THEN
      v_winner_offset := 3;
    ELSE
      v_winner_offset := -1;
    END IF;

    -- Decide once whether the entire market set should refund.
    v_is_refund := FALSE;
    v_refund_reason := NULL;
    IF NEW.method IS NOT NULL AND NEW.method::text = 'no_contest' THEN
      v_is_refund := TRUE;
      v_refund_reason := 'No contest';
    ELSIF NEW.winner_id IS NULL THEN
      v_is_refund := TRUE;
      v_refund_reason := 'Draw';
    ELSIF v_winner_offset < 0 THEN
      v_is_refund := TRUE;
      v_refund_reason := 'Unknown winner';
    END IF;

    FOR v_market IN
      SELECT id, type::text AS type FROM market
      WHERE bout_id = NEW.id AND status = 'open'
    LOOP
      IF v_is_refund THEN
        PERFORM public.refund_market(v_market.id, v_refund_reason);
      ELSIF v_market.type = 'winner' THEN
        -- winner_offset 0 → idx 0 (A wins), 3 → idx 1 (B wins).
        PERFORM public.settle_market_winner(v_market.id, v_winner_offset / 3);
      ELSIF v_market.type = 'method' THEN
        IF v_can_settle_method THEN
          PERFORM public.settle_market_method(
            v_market.id, v_winner_offset, v_method_offset
          );
        ELSE
          -- Method missing / unrecognised — refund just the method market.
          PERFORM public.refund_market(v_market.id, 'Method unknown');
        END IF;
      END IF;
    END LOOP;
  END IF;

  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM NEW.status THEN
    FOR v_market IN
      SELECT id FROM market WHERE bout_id = NEW.id AND status = 'open'
    LOOP
      PERFORM public.refund_market(v_market.id, 'Bout cancelled');
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_bout_auto_settle ON bout;
CREATE TRIGGER on_bout_auto_settle
  AFTER UPDATE OF status, winner_id, method ON bout
  FOR EACH ROW EXECUTE FUNCTION public.on_bout_auto_settle();
