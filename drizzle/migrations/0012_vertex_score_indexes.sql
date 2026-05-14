-- Wave 3.5 step 4A: indexes for Vertex Score sorting + tier filtering.
--
-- The earlier migrations (0004 / 0008 / 0009) already added DESC NULLS LAST
-- indexes on vertex_score / vertex_score_all_time / peak_score and a partial
-- index on is_dominant_champion. This migration is idempotent — it makes the
-- index set explicit and adds a partial index on championship_pedigree > 0
-- for the "tier=champion" catalog filter.

CREATE INDEX IF NOT EXISTS idx_fighter_vertex_score_desc
  ON fighter (vertex_score DESC NULLS LAST)
  WHERE vertex_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fighter_vertex_score_all_time_desc
  ON fighter (vertex_score_all_time DESC NULLS LAST)
  WHERE vertex_score_all_time IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fighter_championship_pedigree
  ON fighter (championship_pedigree)
  WHERE championship_pedigree > 0;
