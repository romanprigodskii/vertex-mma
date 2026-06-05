-- Wave 57: two settlement correctness fixes. Both are CREATE OR REPLACE of an
-- existing function body — money paths are otherwise copied verbatim from the
-- live definitions (on_bout_auto_settle: 0066_wave48; settle_parlay_legs_for_bout:
-- scripts/apply_notification_params.ts, Wave 49). The trigger binding is left
-- untouched: CREATE OR REPLACE FUNCTION swaps the body in place, so the existing
-- on_bout_auto_settle / on_bout_settle_fixed_odds triggers pick up the new code.
--
-- Fix 1 — DRAW pays "goes the distance" (Yes) instead of refunding.
--   A draw is scored by the judges, i.e. the bout reached the final bell, so the
--   distance market's "Yes" objectively won. The LMSR trigger refunded the whole
--   bout on winner_id IS NULL, including the distance market — disagreeing with
--   the fixed-odds book (went_distance = method bucket IN ('dec','draw')). Now a
--   draw lets ONLY the distance market settle "Yes"; every other refund case
--   (no_contest / unknown winner / cancelled) still refunds, and other market
--   types still refund on a draw.
--
-- Fix 2 — fully-won parlay pays the stored potential_payout, not a recompute.
--   The all-legs-won path recomputed floor(stake * exp(sum(ln(decimal_odds))))
--   from the float4 leg odds, drifting a coin or two from the slip's quoted
--   potential_payout at the rounding boundary. Now, when NO leg voided, we pay
--   the saved parlay.potential_payout; only when a leg voided & dropped out do we
--   re-price across the surviving (won) legs.

-- ---------------------------------------------------------------------------
-- Fix 1: on_bout_auto_settle (LMSR market trigger body)
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
  v_outcome_count int;
  v_round_idx int;
  v_distance_idx int;
BEGIN
  IF NEW.status = 'completed'
     AND (
       OLD.status IS DISTINCT FROM NEW.status
       OR OLD.winner_id IS DISTINCT FROM NEW.winner_id
       OR OLD.method IS DISTINCT FROM NEW.method
     )
  THEN
    -- Classify method.
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

    -- Classify winner side.
    IF NEW.winner_id = NEW.fighter_a_id THEN
      v_winner_offset := 0;
    ELSIF NEW.winner_id = NEW.fighter_b_id THEN
      v_winner_offset := 3;
    ELSE
      v_winner_offset := -1;
    END IF;

    -- Decide once whether every market on the bout should refund.
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
      SELECT id, type::text AS type, question FROM market
      WHERE bout_id = NEW.id AND status = 'open'
    LOOP
      -- A DRAW is the one "refund" case that still has an objective answer for
      -- the distance market: the judges scored it, so the bout reached the final
      -- bell → "goes the distance" (Yes) won. Let the distance market fall
      -- through to its own branch instead of refunding (mirrors the fixed-odds
      -- book: went_distance = method bucket IN ('dec','draw')). Every other
      -- refund case still refunds, and other market types still refund on a draw.
      -- NEW.method IS NOT NULL guard matters: a null winner with a null method
      -- is an unknown/incomplete result, NOT a draw — it must still refund.
      -- Without the guard, NEW.method::text = 'draw' is NULL there, the whole
      -- IF collapses to NULL (treated as FALSE), and the distance market wrongly
      -- falls through to settle "No".
      IF v_is_refund
         AND NOT (v_market.type = 'distance'
                  AND NEW.method IS NOT NULL
                  AND NEW.method::text = 'draw') THEN
        PERFORM public.refund_market(v_market.id, v_refund_reason);

      ELSIF v_market.type = 'winner' THEN
        -- winner_offset 0 → idx 0 (A wins); 3 → idx 1 (B wins).
        PERFORM public.settle_market_winner(v_market.id, v_winner_offset / 3);

      ELSIF v_market.type = 'method' THEN
        IF v_can_settle_method THEN
          PERFORM public.settle_market_method(
            v_market.id, v_winner_offset, v_method_offset
          );
        ELSE
          PERFORM public.refund_market(v_market.id, 'Method unknown');
        END IF;

      ELSIF v_market.type = 'round' THEN
        SELECT COUNT(*)::int INTO v_outcome_count
        FROM market_outcome WHERE market_id = v_market.id;
        -- Outcomes layout: idx 0..(N-2) = R1..R(N-1), idx (N-1) = Decision.
        IF v_method_offset = 2 THEN
          v_round_idx := v_outcome_count - 1;
        ELSIF NEW.round_finished IS NOT NULL
              AND NEW.round_finished >= 1
              AND NEW.round_finished < v_outcome_count THEN
          v_round_idx := NEW.round_finished - 1;
        ELSE
          v_round_idx := -1;
        END IF;
        IF v_round_idx >= 0 THEN
          PERFORM public.settle_market_outcome(v_market.id, v_round_idx);
        ELSE
          PERFORM public.refund_market(
            v_market.id, 'Round outcome undetermined'
          );
        END IF;

      ELSIF v_market.type = 'distance' THEN
        -- idx 0 = goes the distance (Yes), idx 1 = finishes early (No).
        -- "Yes" covers BOTH a decision and a draw: both reach the judges'
        -- scorecards, i.e. the bout went the full distance.
        IF v_method_offset = 2
           OR (NEW.method IS NOT NULL AND NEW.method::text = 'draw') THEN
          v_distance_idx := 0;
        ELSE
          v_distance_idx := 1;
        END IF;
        PERFORM public.settle_market_outcome(v_market.id, v_distance_idx);

      ELSIF v_market.type = 'prop' THEN
        IF v_market.question ILIKE '%knockdown%' THEN
          -- Defer to the round-stats-gated helper. At status-flip the
          -- knockdown data isn't loaded yet, so this leaves the prop OPEN
          -- instead of summing 0 and wrongly settling "No"; the round-stats
          -- loader (and the cron backstop) settle it once the data lands.
          PERFORM public.settle_knockdown_props_for_bout(NEW.id);
        ELSE
          PERFORM public.refund_market(v_market.id, 'Unknown prop market');
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

-- ---------------------------------------------------------------------------
-- Fix 2: settle_parlay_legs_for_bout (Wave 49 body + stored-payout path)
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
  v_combined numeric; v_payout int; v_new_balance int;
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
        -- Every surviving leg won. If NO leg voided, pay the EXACT amount we
        -- quoted on the slip at placement (potential_payout). Recomputing it
        -- from the float4 leg odds here drifts a coin or two at the rounding
        -- boundary and silently underpays vs. what the betslip promised. Only
        -- when a leg voided & dropped out do we re-price over the won legs.
        IF v_void = 0 THEN
          v_payout := v_p.potential_payout;
          v_combined := v_p.combined_odds;
        ELSE
          SELECT LEAST(1000, round(exp(sum(ln(decimal_odds)))::numeric, 2))
            INTO v_combined FROM parlay_leg WHERE parlay_id=v_p.id AND status='won';
          v_payout := floor(v_p.stake_coins * v_combined)::int;
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
