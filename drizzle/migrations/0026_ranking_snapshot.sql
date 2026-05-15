-- Wave 6C.1: historical UFC rankings snapshots + roster.watch extension.
--
-- ranking_snapshot — biweekly point-in-time UFC.com/rankings captures
-- fetched from Wayback Machine (2017-01-01 → today) by
-- scripts/scrape_ufc_rankings.py + scripts/parse_ufc_rankings.py +
-- scripts/import_ufc_rankings.ts. Wave 6C.2 will use this to replace the
-- "champion-status at bout time" heuristic in classifyOpponentAtBout()
-- with actual rank-at-bout-time.
--
-- Conventions:
--   rank = 0       → champion (or interim — page lists them in same slot)
--   rank = 1..15   → contender
--   division       → reuses the existing weight_class enum
--   fighter_id     → nullable; we backfill via fuzzy match in the importer,
--                    rows that don't resolve stay NULL with the raw name
--                    preserved so a later pass can re-match
--
-- UNIQUE on (snapshot_date, division, rank) lets the importer use
-- ON CONFLICT DO UPDATE so re-running the pipeline is idempotent.
--
-- Three roster.watch CSV columns get fighter columns of their own. They're
-- populated by scripts/import_roster_watch.ts but not consumed by any
-- current formula; Wave 6C.2 reads peak_rank in particular for the rank-
-- at-bout fallback when a bout pre-dates 2017 (no ranking_snapshot data).

CREATE TABLE ranking_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date NOT NULL,
  division weight_class NOT NULL,
  rank smallint NOT NULL,
  fighter_id uuid REFERENCES fighter(id) ON DELETE SET NULL,
  fighter_name_raw text NOT NULL,
  source_url text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE (snapshot_date, division, rank)
);

CREATE INDEX ranking_snapshot_date_idx ON ranking_snapshot(snapshot_date);
CREATE INDEX ranking_snapshot_fighter_idx ON ranking_snapshot(fighter_id);
CREATE INDEX ranking_snapshot_div_date_idx
  ON ranking_snapshot(division, snapshot_date DESC);

ALTER TABLE fighter
  ADD COLUMN peak_rank smallint,
  ADD COLUMN peak_p4p smallint,
  ADD COLUMN current_streak smallint;

CREATE INDEX fighter_peak_rank_idx ON fighter(peak_rank);
