-- Wave 48: extend the bookmaker to five market types per bout.
--
-- New types share a generic settlement helper, settle_market_outcome, so
-- the trigger doesn't grow another bespoke pay-out routine for each new
-- market shape. settle_market_winner / settle_market_method stay in place
-- (Wave 39/42) — the trigger keeps calling them so existing rows continue
-- to settle through their original paths and nothing rewrites in
-- backwards-incompatible ways.
--
-- All notification + tier-promotion side effects (Waves 46/47) follow the
-- same pattern as settle_market_winner: per-bet transaction row, per-bet
-- notification, per-bet tier check.

-- ---------------------------------------------------------------------------
-- settle_market_outcome — generic N-outcome settlement (idx >= 0).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.settle_market_outcome(
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
  v_winning_label text;
  v_bet record;
  v_payout int;
  v_new_balance int;
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

    INSERT INTO notification (user_id, type, title, body, link)
    VALUES (
      v_bet.user_id,
      'bet_settled',
      'Bet won · +' || v_payout || ' coins',
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

-- ---------------------------------------------------------------------------
-- settle_knockdown_props_for_bout — grade "any knockdown?" props ONLY once the
-- round-stats data they depend on is present.
--
-- bout.status flips to 'completed' in an EARLY scraper pass; bout_round_stats
-- (which carries `knockdowns`) is written by a SEPARATE, LATER pass. The
-- original prop handler summed knockdowns at status-flip time, read 0 (no rows
-- yet) and wrongly settled "No". This helper gates on the full set of rounds
-- being present, so it is a no-op until the data lands — then settles correctly.
-- It is called from on_bout_auto_settle (defers), from the round-stats loader
-- (settles inline once all rounds for the bout are inserted), and from the
-- settlement cron backstop. Idempotent: settle_market_outcome no-ops on an
-- already-resolved market.
--
-- Refund cases (no_contest / draw / unknown winner / cancelled) are handled by
-- on_bout_auto_settle's own refund paths and never reach a Yes/No here.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.settle_knockdown_props_for_bout(p_bout_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bout record;
  v_expected_rounds int;
  v_rounds_present int;
  v_kd_total int;
  v_market record;
BEGIN
  SELECT status::text AS status, method::text AS method, winner_id,
         round_finished, scheduled_rounds
    INTO v_bout
  FROM bout WHERE id = p_bout_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Only grade a clean, decided result.
  IF v_bout.status <> 'completed' THEN RETURN; END IF;
  IF v_bout.winner_id IS NULL THEN RETURN; END IF;            -- draw → refunded elsewhere
  IF v_bout.method IS NULL OR v_bout.method = 'no_contest' THEN RETURN; END IF;

  -- How many rounds the fight actually had: the finishing round for a stoppage,
  -- the scheduled length for a decision.
  v_expected_rounds := CASE
    WHEN v_bout.method LIKE 'decision%' THEN COALESCE(v_bout.scheduled_rounds, 3)
    WHEN v_bout.round_finished IS NOT NULL AND v_bout.round_finished >= 1
      THEN v_bout.round_finished
    ELSE COALESCE(v_bout.scheduled_rounds, 3)
  END;

  -- Defer until every round's stats are loaded (callers may fire before the
  -- enrich pass; this keeps the prop OPEN rather than grading on partial data).
  SELECT COUNT(DISTINCT round) INTO v_rounds_present
  FROM bout_round_stats WHERE bout_id = p_bout_id;
  IF v_rounds_present < v_expected_rounds THEN RETURN; END IF;

  SELECT COALESCE(SUM(knockdowns), 0)::int INTO v_kd_total
  FROM bout_round_stats WHERE bout_id = p_bout_id;

  FOR v_market IN
    SELECT id FROM market
    WHERE bout_id = p_bout_id AND type = 'prop'
      AND question ILIKE '%knockdown%' AND status = 'open'
  LOOP
    -- idx 0 = Yes (>=1 knockdown), idx 1 = No.
    PERFORM public.settle_market_outcome(
      v_market.id, CASE WHEN v_kd_total > 0 THEN 0 ELSE 1 END
    );
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- on_bout_auto_settle — Wave 42/46 body extended with round / distance /
-- prop handlers. Same universal refund guards (no_contest / draw /
-- unknown winner / cancelled bout) up front.
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
      IF v_is_refund THEN
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
        IF v_method_offset = 2 THEN
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

DROP TRIGGER IF EXISTS on_bout_auto_settle ON bout;
CREATE TRIGGER on_bout_auto_settle
  AFTER UPDATE OF status, winner_id, method ON bout
  FOR EACH ROW EXECUTE FUNCTION public.on_bout_auto_settle();
