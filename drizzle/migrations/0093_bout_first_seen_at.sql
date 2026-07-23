-- bout.first_seen_at / event.first_seen_at — when a booking was FIRST observed.
--
-- The other half of the forward-only booking record (see 0092 for the why).
-- With bout_change_event capturing what happens to a booking, this captures
-- when the booking appeared: by the UFCStats scrape, or — for a bout the news
-- pipeline announced first — the article's published_at. Together they give
-- "how much notice did these two fighters get", which is the input we suspect
-- the model is missing on lopsided matchups. The event column is the same
-- clock one level up: when the CARD first appeared, which is what a late
-- addition to an existing card should be measured against.
--
-- NULLABLE AND WITHOUT A DEFAULT, both on purpose. Since Postgres 11,
-- ADD COLUMN ... DEFAULT now() materialises that default for every EXISTING
-- row — which is precisely how bout.created_at became useless (8 736 bouts
-- stamped 2026-05-12, 8 695 of them AFTER their own event). Historical rows
-- stay NULL, meaning "unknown"; a timestamp that lies is worse than one that
-- admits it doesn't know. The two writers
-- (scripts/scraper/src/loaders/{events,news}.py) set the value explicitly on
-- INSERT and never in an ON CONFLICT DO UPDATE SET.
--
-- DO NOT BACKFILL THIS COLUMN. There is no honest source to backfill it from.
--
-- Apply with: pnpm tsx scripts/apply_bout_first_seen_at.ts
-- (idempotent; also declared in src/lib/db/schema/events.ts so drizzle-kit
-- push won't drop it. Not applied via push — see the note in 0092.)

ALTER TABLE bout  ADD COLUMN IF NOT EXISTS first_seen_at timestamp with time zone;
ALTER TABLE event ADD COLUMN IF NOT EXISTS first_seen_at timestamp with time zone;
