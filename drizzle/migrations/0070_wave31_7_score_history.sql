-- Wave 31.7: per-bout vertex_score history for peak tracking.
--
-- Populated by scripts/compute_score_history.ts which replays the Wave 31
-- formula chronologically per fighter. One row per (fighter, completed
-- bout) — the row records what the fighter's vertex_score WOULD HAVE
-- BEEN as of that bout's event_date, using only data available up to
-- and including that bout.
--
-- Profile UI surfaces peak = MAX(vertex_score) per fighter, with the
-- anchor bout (the bout that produced the peak) and the next bout (the
-- one that ended it, if any).
--
-- Schema also exists in src/lib/db/schema/fighters.ts (fighterScoreHistory)
-- for type-safe Drizzle queries. CREATE TABLE IF NOT EXISTS keeps this
-- file idempotent — running it twice is a no-op.

CREATE TABLE IF NOT EXISTS fighter_score_history (
  fighter_id     UUID    NOT NULL REFERENCES fighter(id) ON DELETE CASCADE,
  as_of_bout_id  UUID    NOT NULL REFERENCES bout(id)    ON DELETE CASCADE,
  as_of_date     DATE    NOT NULL,
  vertex_score   SMALLINT NOT NULL,
  raw_current    REAL     NOT NULL,
  PRIMARY KEY (fighter_id, as_of_bout_id)
);

CREATE INDEX IF NOT EXISTS fighter_score_history_fighter_date_idx
  ON fighter_score_history (fighter_id, as_of_date DESC);

CREATE INDEX IF NOT EXISTS fighter_score_history_peak_idx
  ON fighter_score_history (fighter_id, vertex_score DESC);
