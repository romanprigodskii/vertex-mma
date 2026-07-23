import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  boutMethodEnum,
  boutStatusEnum,
  boutVideoKindEnum,
  eventStatusEnum,
  promotionEnum,
  weightClassEnum,
} from "./enums";
import { fighter } from "./fighters";

export const event = pgTable(
  "event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),

    name: text("name").notNull(),
    // Russian event name for the RU locale (matchup surnames transliterated by
    // scripts/16_translate_events.py). Null until translated; UI falls back to name.
    nameRu: text("name_ru"),
    shortName: text("short_name"),
    promotion: promotionEnum("promotion").notNull(),

    date: timestamp("date", { withTimezone: true }).notNull(),
    locationCity: text("location_city"),
    locationCountry: char("location_country", { length: 2 }),
    venue: text("venue"),

    posterUrl: text("poster_url"),
    status: eventStatusEnum("status").default("upcoming").notNull(),

    ufcStatsId: text("ufc_stats_id").unique(),
    sherdogId: text("sherdog_id").unique(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("event_slug_idx").on(table.slug),
    index("event_date_idx").on(table.date),
    index("event_status_idx").on(table.status),
    index("event_promotion_idx").on(table.promotion),
  ],
);

export const bout = pgTable(
  "bout",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),

    fighterAId: uuid("fighter_a_id")
      .notNull()
      .references(() => fighter.id),
    fighterBId: uuid("fighter_b_id")
      .notNull()
      .references(() => fighter.id),

    weightClass: weightClassEnum("weight_class").notNull(),
    isTitleFight: boolean("is_title_fight").default(false).notNull(),
    isMainEvent: boolean("is_main_event").default(false).notNull(),
    isCoMainEvent: boolean("is_co_main_event").default(false).notNull(),
    scheduledRounds: integer("scheduled_rounds").default(3).notNull(),
    boutOrder: integer("bout_order"),

    status: boutStatusEnum("status").default("scheduled").notNull(),
    winnerId: uuid("winner_id").references(() => fighter.id),
    method: boutMethodEnum("method"),
    methodDetail: text("method_detail"),
    roundFinished: integer("round_finished"),
    timeFinishedSeconds: integer("time_finished_seconds"),

    ufcStatsId: text("ufc_stats_id").unique(),
    sherdogId: text("sherdog_id").unique(),
    mmadecisionsId: text("mmadecisions_id").unique(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("bout_event_idx").on(table.eventId),
    index("bout_fighter_a_idx").on(table.fighterAId),
    index("bout_fighter_b_idx").on(table.fighterBId),
    index("bout_status_idx").on(table.status),
  ],
);

// Append-only log of everything that HAPPENS to a booking between the
// announcement and the walk to the cage: a fight vanishing off a card, an
// opponent being swapped, a cancellation, a date or weight-class move.
//
// Why a separate table rather than columns on `bout`: none of this is
// reconstructable after the fact. The UFCStats event page shows the card as it
// stands TODAY — a fight pulled last month simply isn't there, and our own
// scrape used to hard-DELETE the row that proved it existed. Booking
// circumstance (short notice, replacement opponent) is the one plausible
// missing input for the model's remaining gap to the closing line, and it is
// forward-only: every week we don't record it is a week of signal gone for
// good. The table exists so that a year from now there is something to model.
//
// DELIBERATELY NO FOREIGN KEYS. `bout_id` and `event_id` are bare uuids:
// half the point is to outlive `DELETE FROM bout` (the removal log would
// cascade itself away at the exact moment it became interesting) and the
// provisional-event merges that drop `event` rows. Join on them by hand and
// expect misses.
//
// Written by the scraper (scripts/scraper/src/loaders/{events,news}.py) —
// see scripts/scraper/docs/change_accrual.md. Nothing reads it yet.
export const boutChangeEvent = pgTable(
  "bout_change_event",
  {
    // bigserial, not a random uuid: rows are deduped against the LAST one
    // written for a (bout, kind), and insertion order is the only ordering
    // that can't be perturbed by a backdated observed_at.
    id: bigserial("id", { mode: "number" }).primaryKey(),

    boutId: uuid("bout_id").notNull(),
    /** May be null when the bout's event is unknown or already gone. */
    eventId: uuid("event_id"),

    /** When the change HAPPENED, as best we can tell. For news-sourced rows
     *  this is the article's published_at, not the moment we parsed it — the
     *  classifier runs hourly and can pick up a backlog item days late. For
     *  scrape-sourced rows it is the observation time, which is an upper
     *  bound: we learn a fight is off up to 6 h after it comes off the page. */
    observedAt: timestamp("observed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** When WE wrote the row. Differs from observedAt whenever the source
     *  carries its own timestamp; keeps "when did the pipeline learn this"
     *  answerable without trusting the source clock. */
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    /** 'ufcstats' | 'news' | 'odds' — which pipeline observed it. */
    source: text("source").notNull(),
    /** 'bout_removed_from_card' | 'opponent_swapped' | 'status_cancelled'
     *  | 'date_moved' | 'weight_class_changed' | 'provisional_merged'.
     *  Free text on purpose: a new observation should be cheap to start
     *  recording, and an enum here would need a migration to add one. */
    kind: text("kind").notNull(),

    /** Deterministic fingerprint of the observed CHANGE (not of the
     *  observation). A row is written only when this differs from the most
     *  recent row with the same (bout_id, kind) — the scrape re-reads every
     *  upcoming card every 6 h, and without this an unrepaired opponent swap
     *  would log itself four times a day forever. */
    signature: text("signature").notNull(),

    /** Old and new values, ufc_stats_id, fighter names/ids, the news item and
     *  its confidence — whatever the writer had. Shape varies by kind and is
     *  documented in scripts/scraper/docs/change_accrual.md. */
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
  },
  (table) => [
    index("bout_change_event_bout_idx").on(table.boutId, table.observedAt),
    index("bout_change_event_observed_idx").on(table.observedAt),
    // Serves the dedupe lookup: latest row for a (bout, kind).
    index("bout_change_event_dedupe_idx").on(
      table.boutId,
      table.kind,
      sql`${table.id} DESC`,
    ),
  ],
);

export const boutRoundStats = pgTable(
  "bout_round_stats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boutId: uuid("bout_id")
      .notNull()
      .references(() => bout.id, { onDelete: "cascade" }),
    fighterId: uuid("fighter_id")
      .notNull()
      .references(() => fighter.id),
    round: integer("round").notNull(),

    sigStrLanded: integer("sig_str_landed").default(0).notNull(),
    sigStrAttempted: integer("sig_str_attempted").default(0).notNull(),
    sigStrHeadLanded: integer("sig_str_head_landed").default(0).notNull(),
    sigStrHeadAttempted: integer("sig_str_head_attempted").default(0).notNull(),
    sigStrBodyLanded: integer("sig_str_body_landed").default(0).notNull(),
    sigStrBodyAttempted: integer("sig_str_body_attempted").default(0).notNull(),
    sigStrLegsLanded: integer("sig_str_legs_landed").default(0).notNull(),
    sigStrLegsAttempted: integer("sig_str_legs_attempted").default(0).notNull(),
    sigStrDistanceLanded: integer("sig_str_distance_landed")
      .default(0)
      .notNull(),
    sigStrClinchLanded: integer("sig_str_clinch_landed").default(0).notNull(),
    sigStrGroundLanded: integer("sig_str_ground_landed").default(0).notNull(),
    totalStrLanded: integer("total_str_landed").default(0).notNull(),
    totalStrAttempted: integer("total_str_attempted").default(0).notNull(),

    takedownsLanded: integer("takedowns_landed").default(0).notNull(),
    takedownsAttempted: integer("takedowns_attempted").default(0).notNull(),
    subAttempts: integer("sub_attempts").default(0).notNull(),
    reversals: integer("reversals").default(0).notNull(),
    controlTimeSeconds: integer("control_time_seconds").default(0).notNull(),

    knockdowns: integer("knockdowns").default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("bout_round_stats_bout_idx").on(table.boutId),
    unique("bout_round_stats_unique").on(
      table.boutId,
      table.fighterId,
      table.round,
    ),
  ],
);

export const boutScorecard = pgTable(
  "bout_scorecard",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boutId: uuid("bout_id")
      .notNull()
      .references(() => bout.id, { onDelete: "cascade" }),
    judgeName: text("judge_name").notNull(),
    round: integer("round").notNull(),
    fighterAScore: integer("fighter_a_score").notNull(),
    fighterBScore: integer("fighter_b_score").notNull(),
    sourceUrl: text("source_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("bout_scorecard_bout_idx").on(table.boutId),
    unique("bout_scorecard_unique").on(
      table.boutId,
      table.judgeName,
      table.round,
    ),
  ],
);

// Wave 60: curated title-fight bout IDs, mirrored from
// src/lib/title-fights.ts (which is derived from the hand-verified
// championship-history.ts + title-challenger-history.ts). The scraped
// bout.is_title_fight flag is unreliable — UFCStats puts bonus icons in
// the same cell as the belt, so whole main-card slates get flagged.
// The fighter_vertex_score views' era_dominance_current CTEs read this
// table instead. Synced (delete + insert) by
// scripts/derive_title_fights.ts; seeded by migration 0088.
export const titleFightBout = pgTable("title_fight_bout", {
  boutId: uuid("bout_id")
    .primaryKey()
    .references(() => bout.id, { onDelete: "cascade" }),
});

// Wave 44: external sportsbook consensus odds per bout (one row per
// (bout, source) pair). Used to seed initial LMSR shares so brand-new
// markets open with prices close to the public market, and to render a
// "Sportsbook consensus" reference panel on /markets/[id].
//
// Decimal odds are the canonical storage format. American → decimal
// conversion happens on the scraper side so SQL stays simple. Method
// columns are nullable because the bestfightodds HTML doesn't expose
// stable prop IDs we can trust without a manual map.
export const boutExternalOdds = pgTable(
  "bout_external_odds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boutId: uuid("bout_id")
      .notNull()
      .references(() => bout.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("bestfightodds"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    winnerADecimal: real("winner_a_decimal"),
    winnerBDecimal: real("winner_b_decimal"),
    methodAKotkoDecimal: real("method_a_kotko_decimal"),
    methodASubDecimal: real("method_a_sub_decimal"),
    methodADecDecimal: real("method_a_dec_decimal"),
    methodBKotkoDecimal: real("method_b_kotko_decimal"),
    methodBSubDecimal: real("method_b_sub_decimal"),
    methodBDecDecimal: real("method_b_dec_decimal"),
    sourceUrl: text("source_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("bout_external_odds_bout_idx").on(table.boutId),
    unique("bout_external_odds_unique").on(table.boutId, table.source),
  ],
);

// UFC publishes ~daily on YouTube — every event ships both per-fight
// FULL FIGHT clips (highlights, 4-8 min) and a handful of full free-fight
// uploads (15-25 min). We mirror that mapping here so a bout can have
// multiple linked videos. video_id is the YouTube ID (e.g. "OyaDaWlPt5A").
export const boutVideo = pgTable(
  "bout_video",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boutId: uuid("bout_id")
      .notNull()
      .references(() => bout.id, { onDelete: "cascade" }),
    youtubeVideoId: text("youtube_video_id").notNull(),
    kind: boutVideoKindEnum("kind").notNull(),
    title: text("title").notNull(),
    durationSeconds: integer("duration_seconds"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    thumbnailUrl: text("thumbnail_url"),
    sourceChannel: text("source_channel").default("UFC").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("bout_video_bout_idx").on(table.boutId),
    unique("bout_video_yt_unique").on(table.boutId, table.youtubeVideoId),
  ],
);

export type Event = typeof event.$inferSelect;
export type NewEvent = typeof event.$inferInsert;
export type Bout = typeof bout.$inferSelect;
export type NewBout = typeof bout.$inferInsert;
export type BoutChangeEvent = typeof boutChangeEvent.$inferSelect;
export type NewBoutChangeEvent = typeof boutChangeEvent.$inferInsert;
export type BoutScorecard = typeof boutScorecard.$inferSelect;
export type NewBoutScorecard = typeof boutScorecard.$inferInsert;
export type BoutExternalOdds = typeof boutExternalOdds.$inferSelect;
export type NewBoutExternalOdds = typeof boutExternalOdds.$inferInsert;
export type BoutVideo = typeof boutVideo.$inferSelect;
export type NewBoutVideo = typeof boutVideo.$inferInsert;
