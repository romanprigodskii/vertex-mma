import {
  boolean,
  char,
  index,
  integer,
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
export type BoutScorecard = typeof boutScorecard.$inferSelect;
export type NewBoutScorecard = typeof boutScorecard.$inferInsert;
export type BoutExternalOdds = typeof boutExternalOdds.$inferSelect;
export type NewBoutExternalOdds = typeof boutExternalOdds.$inferInsert;
export type BoutVideo = typeof boutVideo.$inferSelect;
export type NewBoutVideo = typeof boutVideo.$inferInsert;
