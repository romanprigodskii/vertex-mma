-- Wave 45: predictions game scoring.
--
-- Free-picks contest: users pick winners on upcoming UFC cards, +10 points
-- per correct winner. Method/round columns are kept on prediction_pick so
-- a future wave can light up method scoring without a schema change, but
-- v1 doesn't award points for them.
--
-- Three pieces:
--   score_predictions_for_bout(uuid)            picks → points for one bout
--   refresh_prediction_event_results(event_id)  per-(user, event) rollup
--   on_bout_score_predictions                   AFTER UPDATE trigger on bout
--
-- All idempotent: scoring only touches picks where is_correct IS NULL so
-- re-running on an already-scored bout is a no-op. Helpers are SECURITY
-- DEFINER so the scraper (or anything writing to `bout`) can drive them.

-- ---------------------------------------------------------------------------
-- RLS — public read on all three tables; writes only via server actions.
-- ---------------------------------------------------------------------------

ALTER TABLE prediction_event        ENABLE ROW LEVEL SECURITY;
ALTER TABLE prediction_pick         ENABLE ROW LEVEL SECURITY;
ALTER TABLE prediction_event_result ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "prediction_event_select_all" ON prediction_event;
CREATE POLICY "prediction_event_select_all" ON prediction_event
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "prediction_pick_select_all" ON prediction_pick;
CREATE POLICY "prediction_pick_select_all" ON prediction_pick
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "prediction_event_result_select_all" ON prediction_event_result;
CREATE POLICY "prediction_event_result_select_all" ON prediction_event_result
  FOR SELECT USING (true);

-- ---------------------------------------------------------------------------
-- score_predictions_for_bout
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.score_predictions_for_bout(p_bout_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_winner uuid;
BEGIN
  SELECT status::text, winner_id
    INTO v_status, v_winner
  FROM bout WHERE id = p_bout_id;

  IF v_status IS NULL OR v_status <> 'completed' THEN
    RETURN;
  END IF;

  IF v_winner IS NOT NULL THEN
    UPDATE prediction_pick
    SET points_winner = CASE WHEN picked_fighter_id = v_winner THEN 10 ELSE 0 END,
        is_correct    = (picked_fighter_id = v_winner),
        total_points  = CASE WHEN picked_fighter_id = v_winner THEN 10 ELSE 0 END
                        + COALESCE(points_method, 0)
                        + COALESCE(points_round, 0)
    WHERE bout_id = p_bout_id AND is_correct IS NULL;
  ELSE
    -- Draw / NC: neither right nor wrong, but mark scored so future
    -- re-runs don't keep flipping the row.
    UPDATE prediction_pick
    SET points_winner = 0,
        is_correct    = FALSE,
        total_points  = COALESCE(points_method, 0) + COALESCE(points_round, 0)
    WHERE bout_id = p_bout_id AND is_correct IS NULL;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- refresh_prediction_event_results — per-(user, event) aggregate.
-- p_event_id is the bout's event.id; we resolve it to a prediction_event.id.
-- prediction_event_result uses `total_score` (real schema column name) —
-- the spec said total_points but the table doesn't have that column.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.refresh_prediction_event_results(p_event_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pred_event_id uuid;
BEGIN
  SELECT id INTO v_pred_event_id
  FROM prediction_event WHERE event_id = p_event_id;
  IF v_pred_event_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO prediction_event_result (
    user_id, prediction_event_id,
    correct_winners, correct_methods, correct_rounds,
    total_score, computed_at
  )
  SELECT
    pp.user_id,
    v_pred_event_id,
    SUM(CASE WHEN pp.is_correct THEN 1 ELSE 0 END)::int AS correct_winners,
    0 AS correct_methods,
    0 AS correct_rounds,
    SUM(COALESCE(pp.total_points, 0))::int AS total_score,
    NOW()
  FROM prediction_pick pp
  WHERE pp.prediction_event_id = v_pred_event_id
  GROUP BY pp.user_id
  ON CONFLICT (user_id, prediction_event_id) DO UPDATE
  SET correct_winners = EXCLUDED.correct_winners,
      total_score     = EXCLUDED.total_score,
      computed_at     = NOW();
END;
$$;

-- ---------------------------------------------------------------------------
-- Trigger: when a bout completes, score every prediction_pick for it and
-- refresh the per-event aggregate. If every bout on the event is terminal,
-- flip the prediction_event itself to 'resolved'.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.on_bout_score_predictions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
      UPDATE prediction_event
        SET status = 'resolved', resolved_at = NOW()
        WHERE event_id = NEW.event_id AND status <> 'resolved';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_bout_score_predictions ON bout;
CREATE TRIGGER on_bout_score_predictions
  AFTER UPDATE OF status, winner_id ON bout
  FOR EACH ROW EXECUTE FUNCTION public.on_bout_score_predictions();
