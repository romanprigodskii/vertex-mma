-- Wave 40: engagement bundle.
--
--   - RLS on achievement / user_achievement (public read; writes server-side).
--   - Seed 8 starter achievements (idempotent via ON CONFLICT slug).
--   - unlock_achievement(user_id, slug) PL/pgSQL helper that idempotently
--     inserts a user_achievement row and awards reward_coins via a
--     transaction-of-type 'achievement'. Uses the existing
--     transaction_type enum value 'achievement' (no enum migration
--     required).

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE achievement      ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_achievement ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "achievement_select_all" ON achievement;
CREATE POLICY "achievement_select_all" ON achievement
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "user_achievement_select_all" ON user_achievement;
CREATE POLICY "user_achievement_select_all" ON user_achievement
  FOR SELECT USING (true);

-- ---------------------------------------------------------------------------
-- Seed achievements
-- ---------------------------------------------------------------------------

INSERT INTO achievement (slug, name, description, reward_coins, rarity) VALUES
  ('first_bet',        'First Bet',         'Placed your first bet on a market.',                                    200,  'common'),
  ('bet_10_wins',      'Streak of Ten',     'Won 10 bets — paid out at least 10 separate winning markets.',          500,  'uncommon'),
  ('first_ranking',    'Listmaker',         'Published your first custom ranking.',                                  200,  'common'),
  ('profile_complete', 'Fully Suited',      'Set display name, bio, country, and avatar.',                           100,  'common'),
  ('daily_streak_7',   'Week One',          'Claimed daily bonus 7 days in a row.',                                  1000, 'rare'),
  ('balance_50k',      'Half-Mil Club',     'Hold 50,000+ coins in balance.',                                        500,  'uncommon'),
  ('balance_100k',     'Six-Figure Roller', 'Hold 100,000+ coins in balance.',                                       1500, 'rare'),
  ('big_win',          'Big Hit',           'Win a single bet paying out 5,000+ coins.',                             500,  'uncommon')
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- unlock_achievement helper
-- ---------------------------------------------------------------------------
--
-- Returns TRUE iff a NEW user_achievement row was inserted. On conflict
-- (already unlocked) returns FALSE without writing a transaction row, so
-- callers can chain checks idempotently after every action.

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
BEGIN
  SELECT id, reward_coins, name
    INTO v_achievement_id, v_reward, v_name
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

  RETURN TRUE;
END;
$$;
