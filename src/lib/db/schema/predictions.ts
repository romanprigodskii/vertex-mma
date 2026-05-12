import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { boutMethodEnum } from "./enums";
import { bout, event } from "./events";
import { fighter } from "./fighters";
import { userProfile } from "./users";

export const predictionEvent = pgTable("prediction_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id")
    .notNull()
    .unique()
    .references(() => event.id, { onDelete: "cascade" }),

  status: text("status").default("upcoming").notNull(),
  totalParticipants: integer("total_participants").default(0).notNull(),

  opensAt: timestamp("opens_at", { withTimezone: true }).notNull(),
  closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const predictionPick = pgTable(
  "prediction_pick",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    predictionEventId: uuid("prediction_event_id")
      .notNull()
      .references(() => predictionEvent.id, { onDelete: "cascade" }),
    boutId: uuid("bout_id")
      .notNull()
      .references(() => bout.id),

    pickedFighterId: uuid("picked_fighter_id")
      .notNull()
      .references(() => fighter.id),
    pickedMethod: boutMethodEnum("picked_method"),
    pickedRound: integer("picked_round"),

    pointsWinner: integer("points_winner").default(0),
    pointsMethod: integer("points_method").default(0),
    pointsRound: integer("points_round").default(0),
    totalPoints: integer("total_points").default(0),
    isCorrect: boolean("is_correct"),

    lockedAt: timestamp("locked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("prediction_pick_unique").on(table.userId, table.boutId),
    index("prediction_pick_event_idx").on(table.predictionEventId),
    index("prediction_pick_user_idx").on(table.userId),
  ],
);

export const predictionEventResult = pgTable(
  "prediction_event_result",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    predictionEventId: uuid("prediction_event_id")
      .notNull()
      .references(() => predictionEvent.id, { onDelete: "cascade" }),

    correctWinners: integer("correct_winners").default(0).notNull(),
    correctMethods: integer("correct_methods").default(0).notNull(),
    correctRounds: integer("correct_rounds").default(0).notNull(),
    totalScore: integer("total_score").default(0).notNull(),
    rank: integer("rank"),

    badgeAwarded: text("badge_awarded"),

    computedAt: timestamp("computed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("prediction_event_result_unique").on(
      table.userId,
      table.predictionEventId,
    ),
    index("prediction_event_result_event_idx").on(table.predictionEventId),
  ],
);
