-- Wave 3.5 step 6A.5.2: roster.watch integration — schema only.
--
-- Adds UFC-roster membership tracking columns populated by
-- scripts/import_roster_watch.ts from imports/roster_current.csv and
-- imports/roster_former.csv. The vertex_score view still uses the
-- last_fight_date heuristic at this point; step 6A.5.4 swaps it to
-- roster_status so the activity calc stops mis-classifying long-layoff
-- rostered fighters and recently-released contractors.
--
-- Values:
--   active   — present in roster.watch current roster (data.csv)
--   released — present in former roster (former_data.csv) without HoF flag
--   retired  — present in former roster with hof=TRUE
--   inactive — has UFC bouts but absent from both CSVs
--   unknown  — default; never matched in import (e.g. very old fighters)
--
-- elo_roster_watch is a cross-reference rating, NOT used in the Vertex Score
-- formula. Vertex Score remains derived from our quality_wins / pedigree /
-- era / activity components (commits 2deebc9 + 925d761).

CREATE TYPE roster_status AS ENUM (
  'active',
  'released',
  'retired',
  'inactive',
  'unknown'
);

ALTER TABLE fighter
  ADD COLUMN roster_status roster_status DEFAULT 'unknown' NOT NULL,
  ADD COLUMN roster_status_updated_at timestamptz,
  ADD COLUMN has_upcoming_bout boolean DEFAULT false NOT NULL,
  ADD COLUMN next_event_date date,
  ADD COLUMN next_opponent_name text,
  ADD COLUMN elo_roster_watch integer;

CREATE INDEX fighter_roster_status_idx ON fighter(roster_status);
CREATE INDEX fighter_has_upcoming_bout_idx ON fighter(has_upcoming_bout);
