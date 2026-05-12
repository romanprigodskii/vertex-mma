import {
  boolean,
  char,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  boutMethodEnum,
  boutStatusEnum,
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

export type Event = typeof event.$inferSelect;
export type NewEvent = typeof event.$inferInsert;
export type Bout = typeof bout.$inferSelect;
export type NewBout = typeof bout.$inferInsert;
