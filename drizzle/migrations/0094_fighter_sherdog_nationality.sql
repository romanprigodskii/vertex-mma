-- 0094 — fighter.sherdog_flag_code / fighter.sherdog_nationality
--
-- Nationality as Sherdog publishes it, RAW. Deliberately not merged into
-- fighter.country_code: that column is Wikidata P27 (citizenship) and is
-- rendered by the site, while Sherdog's is birthplace-derived and uses
-- non-ISO subdivision codes for the Home Nations ('en' = England). See the
-- comment on the columns in src/lib/db/schema/fighters.ts.
--
-- Nullable, NO default: an absent value must read as "not scraped yet",
-- never as a country. Idempotent.

ALTER TABLE fighter
  ADD COLUMN IF NOT EXISTS sherdog_flag_code text,
  ADD COLUMN IF NOT EXISTS sherdog_nationality text;

-- The sim export joins on it for every fighter on a card; the partial index
-- keeps that lookup off a sequential scan without indexing the ~9% of the
-- roster that has no Sherdog profile.
CREATE INDEX IF NOT EXISTS fighter_sherdog_flag_code_idx
  ON fighter (sherdog_flag_code)
  WHERE sherdog_flag_code IS NOT NULL;
