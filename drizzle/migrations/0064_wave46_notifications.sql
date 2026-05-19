-- Wave 46: in-app notification system.
--
-- One table + four function patches. Each PL/pgSQL helper that already
-- writes a transaction row on a user-relevant event also pushes a
-- notification row so the bell icon + /notifications page can surface
-- the event without polling.
--
-- Function bodies are reproduced verbatim from the previous wave (Waves
-- 39/40/42/45 sources) with only `INSERT INTO notification (...)` lines
-- added at the right anchor points. That way re-running 0064 keeps every
-- earlier wave's behavior intact.

-- ---------------------------------------------------------------------------
-- notification table + RLS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES user_profile(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_user_unread_idx
  ON notification(user_id, is_read);
CREATE INDEX IF NOT EXISTS notification_user_created_idx
  ON notification(user_id, created_at);

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notification_select_own" ON notification;
CREATE POLICY "notification_select_own" ON notification
  FOR SELECT USING (
    user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "notification_update_own" ON notification;
CREATE POLICY "notification_update_own" ON notification
  FOR UPDATE USING (
    user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
  );
-- No INSERT/DELETE policy — only server-side (postgres role) can write.

-- ---------------------------------------------------------------------------
-- unlock_achievement — Wave 40 body + notification on fresh insert
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

  -- Wave 46: notification (only on fresh insert; we'd have returned FALSE
  -- above if the unique constraint had fired).
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

  RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- settle_market_winner — Wave 39 body + notification per winning bet
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

    -- Wave 46: notify the winner.
    INSERT INTO notification (user_id, type, title, body, link)
    VALUES (
      v_bet.user_id,
      'bet_settled',
      'Bet won · +' || v_payout || ' coins',
      'Your pick on "' || v_winning_label || '" hit — ' ||
        ROUND(v_bet.shares_bought::numeric, 2)::text || ' shares paid out.',
      '/me/bets'
    );
  END LOOP;

  UPDATE bet
    SET payout = 0, resolved_at = NOW()
    WHERE market_id = p_market_id
      AND outcome_id = v_losing_id
      AND resolved_at IS NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- settle_market_method — Wave 42 body + notification per winning bet
-- (mirrors the winner case so method markets stay in sync.)
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
  END LOOP;

  UPDATE bet
    SET payout = 0, resolved_at = NOW()
    WHERE market_id = p_market_id
      AND outcome_id <> v_winning_id
      AND resolved_at IS NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- refund_market — Wave 39 body + notification per refunded bet
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

    -- Wave 46: notification for refund.
    INSERT INTO notification (user_id, type, title, body, link)
    VALUES (
      v_bet.user_id,
      'bet_settled',
      'Bet refunded · +' || v_bet.coins_spent || ' coins returned',
      p_reason,
      '/me/bets'
    );
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- on_bout_score_predictions — Wave 45 body + per-user notification when
-- the event fully resolves. Notifications fan out from
-- prediction_event_result so every participant gets one summary row.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.on_bout_score_predictions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pred_event_id uuid;
  v_event_name text;
BEGIN
  IF NEW.status = 'completed'
     AND OLD.status IS DISTINCT FROM NEW.status
  THEN
    PERFORM public.score_predictions_for_bout(NEW.id);
    PERFORM public.refresh_prediction_event_results(NEW.event_id);

    IF NOT EXISTS (
      SELECT 1 FROM bout
      WHERE event_id = NEW.event_id
        AND status NOT IN ('completed', 'cancelled', 'no_contest')
    ) THEN
      SELECT id INTO v_pred_event_id
      FROM prediction_event WHERE event_id = NEW.event_id;

      IF v_pred_event_id IS NOT NULL THEN
        -- Only push notifications on the transition into 'resolved' so
        -- re-runs don't spam participants.
        IF EXISTS (
          SELECT 1 FROM prediction_event
          WHERE id = v_pred_event_id AND status <> 'resolved'
        ) THEN
          UPDATE prediction_event
            SET status = 'resolved', resolved_at = NOW()
            WHERE id = v_pred_event_id;

          SELECT COALESCE(e.short_name, e.name) INTO v_event_name
          FROM event e WHERE e.id = NEW.event_id;

          INSERT INTO notification (user_id, type, title, body, link)
          SELECT
            per.user_id,
            'prediction_scored',
            'Predictions scored for ' || v_event_name,
            per.correct_winners || ' correct · ' ||
              per.total_score || ' points earned',
            '/me/predictions'
          FROM prediction_event_result per
          WHERE per.prediction_event_id = v_pred_event_id;
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
