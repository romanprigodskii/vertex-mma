-- Wave 47: username change rate-limit column + tier promotion helper +
-- coin-earning helper updates so promotion checks fire from every site
-- that bumps total_coins_earned.
--
-- Tier ladder uses the existing user_tier enum (bronze / silver / gold /
-- diamond / champion). Thresholds (lifetime coins earned) and daily
-- bonuses (TS side mirrors them in src/lib/tier.ts):
--   bronze    0       → 500 c/day
--   silver    50,000  → 750
--   gold      200,000 → 1,000
--   diamond   500,000 → 1,500
--   champion  1,000,000 → 2,000

ALTER TABLE user_profile
  ADD COLUMN IF NOT EXISTS username_last_changed_at timestamptz;

-- ---------------------------------------------------------------------------
-- check_and_promote_tier — upgrade-only; never downgrades.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_and_promote_tier(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_earned int;
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

    INSERT INTO notification (user_id, type, title, body, link)
    VALUES (
      p_user_id,
      'system',
      'Tier upgrade · ' || UPPER(v_new_tier),
      'You crossed ' || v_total_earned ||
        ' lifetime coins earned. Daily bonus boosted!',
      CASE WHEN v_username IS NOT NULL
        THEN '/profile/' || v_username
        ELSE NULL
      END
    );
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- unlock_achievement — Wave 46 body + tier check after coin award.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.unlock_achievement(
  p_user_id uuid,
  p_slug text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_achievement_id uuid;
  v_reward int;
  v_new_balance int;
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
  INSERT INTO notification (user_id, type, title, body, link)
  VALUES (
    p_user_id,
    'achievement_unlocked',
    'Achievement unlocked: ' || v_name,
    COALESCE(v_description, '') ||
      CASE WHEN v_reward > 0 THEN ' (+' || v_reward || ' coins)' ELSE '' END,
    CASE WHEN v_username IS NOT NULL THEN '/profile/' || v_username ELSE NULL END
  );

  -- Wave 47: tier promotion only matters if the user earned coins here.
  IF v_reward > 0 THEN
    PERFORM public.check_and_promote_tier(p_user_id);
  END IF;

  RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- settle_market_winner — Wave 46 body + tier check per winning bet.
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
  v_winning_label text;
  v_bet record;
  v_payout int;
  v_new_balance int;
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

    INSERT INTO notification (user_id, type, title, body, link)
    VALUES (
      v_bet.user_id,
      'bet_settled',
      'Bet won · +' || v_payout || ' coins',
      'Your pick on "' || v_winning_label || '" hit — ' ||
        ROUND(v_bet.shares_bought::numeric, 2)::text || ' shares paid out.',
      '/me/bets'
    );

    -- Wave 47: tier promotion check.
    PERFORM public.check_and_promote_tier(v_bet.user_id);
  END LOOP;

  UPDATE bet
    SET payout = 0, resolved_at = NOW()
    WHERE market_id = p_market_id
      AND outcome_id = v_losing_id
      AND resolved_at IS NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- settle_market_method — Wave 46 body + tier check per winning bet.
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
  v_winning_label text;
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

    INSERT INTO notification (user_id, type, title, body, link)
    VALUES (
      v_bet.user_id,
      'bet_settled',
      'Method bet won · +' || v_payout || ' coins',
      'Your pick on "' || v_winning_label || '" hit — ' ||
        ROUND(v_bet.shares_bought::numeric, 2)::text || ' shares paid out.',
      '/me/bets'
    );

    PERFORM public.check_and_promote_tier(v_bet.user_id);
  END LOOP;

  UPDATE bet
    SET payout = 0, resolved_at = NOW()
    WHERE market_id = p_market_id
      AND outcome_id <> v_winning_id
      AND resolved_at IS NULL;
END;
$$;
