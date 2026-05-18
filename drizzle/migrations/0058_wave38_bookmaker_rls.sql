-- Wave 38: bookmaker RLS.
--
-- market, market_outcome, bet schemas already exist (drizzle schema/markets.ts).
-- This migration only adds RLS policies — every write path goes through a
-- server action that talks to DATABASE_URL (postgres role, RLS bypassed),
-- so we just need public-read policies for browser SELECTs.
--
-- Re-runnable.

ALTER TABLE market         ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE bet            ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "market_select_all" ON market;
CREATE POLICY "market_select_all" ON market
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "market_outcome_select_all" ON market_outcome;
CREATE POLICY "market_outcome_select_all" ON market_outcome
  FOR SELECT USING (true);

-- Bets are public-read so a future leaderboard / community view can
-- surface "who bet how much" without each viewer needing their own RLS
-- exception. Writes stay server-side only.
DROP POLICY IF EXISTS "bet_select_all" ON bet;
CREATE POLICY "bet_select_all" ON bet
  FOR SELECT USING (true);
