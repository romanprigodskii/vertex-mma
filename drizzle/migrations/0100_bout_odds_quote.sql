-- Append-only sportsbook quotes: one row per price a book posted, with the
-- moment the BOOK posted it.
--
-- bout_external_odds holds one row per (bout, source), rewritten in place by
-- ON CONFLICT DO UPDATE, so it can hold one price per bout and never says
-- when that price was current. That is why every "beats the market" number in
-- the repo is measured against a close and CLV has never been measurable. This
-- table is the append-only store it was missing, first filled from BetsAPI
-- (scripts/odds_scraper/scripts/load_betsapi.py): several books per bout, each
-- with its opening and last pre-bell price, and Bet365's full line movement.
--
-- Only PRE-BELL prices are written. The loader drops any quote it cannot show
-- was posted before the bout started — BetsAPI's last-seen price is routinely
-- an in-play one — so "the latest row per (bout, book, market)" IS the close
-- and no reader needs a filter to stay out of the fight.
--
-- bout_external_odds is untouched: the site, the markets and the model read
-- it, and a second source in it would change what they show.
--
-- Apply with: pnpm tsx scripts/apply_bout_odds_quote.ts
-- (idempotent; also declared in src/lib/db/schema/events.ts so drizzle-kit
-- push won't drop it — but see 0092 for why push must not be run unattended.)

CREATE TABLE IF NOT EXISTS bout_odds_quote (
    id           bigserial PRIMARY KEY NOT NULL,
    bout_id      uuid NOT NULL REFERENCES bout(id) ON DELETE CASCADE,
    -- the feed: 'betsapi'
    source       text NOT NULL,
    -- the book as the feed spells it: 'Bet365', 'DraftKings', …
    book         text NOT NULL,
    -- 'winner' | 'total_rounds'
    market       text NOT NULL,
    -- total_rounds only: the over/under line (1.5, 2.5, 4.5); NULL for winner
    line         real,
    -- winner: decimal price on bout.fighter_a_id / fighter_b_id. Already put
    -- in the bout's orientation — the feed's home/away and a book's reversed
    -- listing (matching_dir = -1) are resolved before the write.
    price_a      real,
    price_b      real,
    -- total_rounds: decimal price on over / under the line
    price_over   real,
    price_under  real,
    -- When the book posted this price (the feed's add_time), not when we
    -- fetched it. The whole reason the table exists.
    quoted_at    timestamp with time zone NOT NULL,
    -- where in the feed the row came from: 'move' (Bet365's line history),
    -- 'start' | 'kickoff' | 'end' (a book's snapshots in the odds summary)
    snapshot     text NOT NULL,
    -- the feed's own id for the bout
    external_id  text NOT NULL,
    recorded_at  timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bout_odds_quote_prices_check CHECK (
        (market = 'winner' AND line IS NULL
            AND price_a > 1 AND price_b > 1
            AND price_over IS NULL AND price_under IS NULL)
     OR (market = 'total_rounds' AND line IS NOT NULL
            AND price_over > 1 AND price_under > 1
            AND price_a IS NULL AND price_b IS NULL)
    ),
    -- One price per book per moment. A re-run of the loader, and the same
    -- quote reached twice (Bet365's summary `start` is the first row of its
    -- history), both land on this and are skipped.
    CONSTRAINT bout_odds_quote_unique
        UNIQUE NULLS NOT DISTINCT (bout_id, source, book, market, line, quoted_at)
);

CREATE INDEX IF NOT EXISTS bout_odds_quote_bout_idx
    ON bout_odds_quote USING btree (bout_id, market, book, quoted_at);
