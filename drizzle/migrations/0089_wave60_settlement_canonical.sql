-- Wave 60 — CANONICAL settlement subsystem (single source of truth).
--
-- The settlement functions had accreted FOUR divergent copies across waves with
-- no deterministic apply order (two files were both numbered 0086, no journal):
--   • 0085_wave57_settlement_fixes.sql  — added the parlay stored-payout fix, but
--     int4 locals.
--   • 0088_wave59_settlement_bigint.sql — widened to bigint, but regenerated from
--     the Wave-49 base and so REVERTED wave57's parlay fix (a fully-won parlay
--     underpaid, recomputing odds from float4 instead of the stored payout).
--   • scripts/apply_parlay_settlement.ts / scripts/apply_notification_params.ts —
--     the live appliers, each carrying yet another partial combination.
-- Because nothing pinned the order, whichever copy applied LAST won — so prod
-- ended up with the bigint-but-buggy parlay path AND the int4 LMSR locals.
--
-- This migration redefines EVERY settlement-path function once, correctly, and is
-- the file the two apply_*.ts scripts mirror byte-for-byte (KEEP IN SYNC). Being
-- the highest-numbered settlement migration, its CREATE OR REPLACE wins
-- regardless of how the historical files interleave, making the final state
-- deterministic. See drizzle/migrations/MANIFEST.md for the ordering ledger.
--
-- Four folded-in fixes (all money-path):
--   1. fixed_odds_grade — a bout that is completed WITH a winner but whose method
--      is still NULL/unrecognised ('unknown' bucket) must VOID/refund every
--      non-winner prop (method/totals/distance), grading ONLY win_a/win_b. The
--      old grader marked those props LOST — an irreversible wrong loss even after
--      the method is later re-scraped. Mirrors settleSelection in
--      src/lib/sportsbook.ts (the TS settlement reference / unit-test oracle).
--   2. settle_parlay_legs_for_bout — a fully-won parlay (no voided leg) pays the
--      EXACT stored potential_payout / combined_odds quoted on the slip, instead
--      of recomputing via floor(stake × exp(Σ ln(odds))) off the float4 leg odds
--      (which drifts a coin or two and underpays). Re-pricing over surviving legs
--      happens only when a leg actually voided & dropped out (v_void > 0).
--   3. Single source of truth — all settlement functions live here once; the
--      historical 0085 / 0088 definitions are superseded.
--   4. bigint money-path locals — Wave 58 (0087) widened user_profile.balance_
--      coins / total_coins_earned / total_coins_lost and transaction.amount /
--      balance_after to bigint, but the settlement functions still declared their
--      balance / earned locals as int4. `RETURNING balance_coins INTO v_new_balance`
--      (and `SELECT total_coins_earned INTO v_total_earned`) then raise `integer
--      out of range` once a balance crosses the int4 ceiling (~2.147e9), aborting
--      the AFTER-UPDATE trigger and ROLLING BACK the result write. All such locals
--      are now bigint. (Per-bet payout columns stay int4 — MAX_PARLAY_ODDS=1000 ×
--      1M max stake = 1e9 < 2.1e9 — so only the accumulating locals needed it.)
--
-- These function/trigger definitions are applied OUT OF BAND (psql / an apply
-- script), NOT by `drizzle-kit push` (which only diffs table schema and would
-- drop drift/RLS). The triggers (on_bout_auto_settle, on_bout_settle_fixed_odds)
-- are left bound as-is — CREATE OR REPLACE swaps each body in place, so they pick
-- up the new code. Fully idempotent / re-runnable.

-- ===========================================================================
-- Grading helpers (DB-free truth table — mirror of src/lib/sportsbook.ts)
-- ===========================================================================

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

-- FIX 1: 'unknown' method (completed + winner, method not yet scraped) → only
-- win_a/win_b grade; every other prop VOIDs. Mirrors settleSelection.
CREATE OR REPLACE FUNCTION public.fixed_odds_grade(
  p_code text, p_winner uuid, p_a uuid, p_b uuid,
  p_mb text, p_went_distance boolean, p_round int
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    -- Winner market grades off winner_id alone, independent of the method bucket.
    WHEN p_code = 'win_a' THEN CASE WHEN p_winner IS NULL THEN 'void' WHEN p_winner = p_a THEN 'won' ELSE 'lost' END
    WHEN p_code = 'win_b' THEN CASE WHEN p_winner IS NULL THEN 'void' WHEN p_winner = p_b THEN 'won' ELSE 'lost' END
    -- Method not yet known: every non-winner prop is ungradeable → VOID, never
    -- LOST. Without this, props wrongly settle LOST on a completed-but-unmethoded
    -- bout — irreversibly, even after the method is later re-scraped.
    WHEN p_mb = 'unknown' THEN 'void'
    WHEN p_code = 'a_ko'  THEN CASE WHEN p_winner IS NULL OR p_mb='dq' THEN 'void' WHEN p_winner=p_a AND p_mb='ko'  THEN 'won' ELSE 'lost' END
    WHEN p_code = 'a_sub' THEN CASE WHEN p_winner IS NULL OR p_mb='dq' THEN 'void' WHEN p_winner=p_a AND p_mb='sub' THEN 'won' ELSE 'lost' END
    WHEN p_code = 'a_dec' THEN CASE WHEN p_winner IS NULL OR p_mb='dq' THEN 'void' WHEN p_winner=p_a AND p_mb='dec' THEN 'won' ELSE 'lost' END
    WHEN p_code = 'b_ko'  THEN CASE WHEN p_winner IS NULL OR p_mb='dq' THEN 'void' WHEN p_winner=p_b AND p_mb='ko'  THEN 'won' ELSE 'lost' END
    WHEN p_code = 'b_sub' THEN CASE WHEN p_winner IS NULL OR p_mb='dq' THEN 'void' WHEN p_winner=p_b AND p_mb='sub' THEN 'won' ELSE 'lost' END
    WHEN p_code = 'b_dec' THEN CASE WHEN p_winner IS NULL OR p_mb='dq' THEN 'void' WHEN p_winner=p_b AND p_mb='dec' THEN 'won' ELSE 'lost' END
    WHEN p_code = 'o2_5'  THEN CASE WHEN p_went_distance THEN 'won' WHEN p_round IS NULL THEN 'void' WHEN p_round <= 2 THEN 'lost' ELSE 'won' END
    WHEN p_code = 'u2_5'  THEN CASE WHEN p_went_distance THEN 'lost' WHEN p_round IS NULL THEN 'void' WHEN p_round <= 2 THEN 'won' ELSE 'lost' END
    WHEN p_code = 'dist_yes' THEN CASE WHEN p_went_distance THEN 'won' ELSE 'lost' END
    WHEN p_code = 'dist_no'  THEN CASE WHEN p_went_distance THEN 'lost' ELSE 'won' END
    ELSE 'void'
  END
$$;

-- ===========================================================================
-- Tier promotion + achievement unlock (called by every settle path)
-- ===========================================================================

-- FIX 4: v_total_earned bigint — reads total_coins_earned (bigint since Wave 58).
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

-- FIX 4: v_new_balance bigint.
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

-- FIX 4: p_payout / p_new_balance bigint params. CREATE OR REPLACE can't change a
-- parameter's type, so the old int4 overload is dropped first (else the call is
-- ambiguous).
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

-- ===========================================================================
-- LMSR market settlement (refund + winner/method/outcome)
-- ===========================================================================

-- FIX 4: v_new_balance bigint.
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

-- FIX 4: v_new_balance bigint.
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
$function$;

-- FIX 4: v_new_balance bigint.
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
$function$;

-- FIX 4: v_new_balance bigint.
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
$function$;

-- ===========================================================================
-- Fixed-odds sportsbook settlement (single bets + parlays)
-- ===========================================================================

-- v_new_balance bigint (already bigint in apply_parlay_settlement.ts; asserted
-- here as the canonical record). Grades through fixed_odds_grade above.
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

-- FIX 2 + FIX 4: bigint locals AND fully-won parlay (v_void = 0) pays the stored
-- potential_payout / combined_odds; recompute only when a leg voided & dropped.
CREATE OR REPLACE FUNCTION public.settle_parlay_legs_for_bout(p_bout_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
        -- Every surviving leg won. If NO leg voided, pay the EXACT amount quoted
        -- on the slip at placement (potential_payout). Recomputing it from the
        -- float4 leg odds drifts a coin or two and underpays. Only when a leg
        -- voided & dropped out do we re-price across the surviving won legs.
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
$$;
