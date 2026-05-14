-- Wave 3.5 step 5B: columns for Era Dominance, Performance Differential,
-- Finishing Dominance, and Title Fight Count.
--
--   title_fight_count        — number of curated UFC title fights this
--                              fighter appears in (any role: champion or
--                              challenger, win or loss).
--   era_dominance            — 0-100, populated by
--                              scripts/compute_era_dominance.ts:
--                                title_fight_count * 8
--                                + (is_active_champion ? 10 : 0)
--                                + (is_double_champion ? 5 : 0)
--                              capped at 100.
--   performance_differential — 0-100, sourced from the view's
--                              performance_diff CTE (SLpM-SAPM and TD avg
--                              vs. TD def). Materialized to the fighter
--                              row by materialize_vertex_score.ts.
--   finishing_dominance      — 0-100, sourced from the view's
--                              finishing_dom CTE (KD per fight, sub
--                              attempts per fight, KO and sub finish
--                              rates among UFC wins).

ALTER TABLE fighter
  ADD COLUMN IF NOT EXISTS title_fight_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS era_dominance integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS performance_differential integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS finishing_dominance integer DEFAULT 0 NOT NULL;

CREATE INDEX IF NOT EXISTS fighter_era_dominance_idx
  ON fighter (era_dominance DESC NULLS LAST);
