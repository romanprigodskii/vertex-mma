import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { fighter } from "./fighters";
import { userProfile } from "./users";

// Wave 37: user-generated fighter rankings.
//
// custom_ranking holds the list metadata (title, description, author).
// custom_ranking_entry holds the positioned fighter slots — one row per
// (ranking, fighter), with a unique constraint on (ranking, position) so
// two slots can't fight for #1 and (ranking, fighter) so the same fighter
// can't appear twice.

export const customRanking = pgTable(
  "custom_ranking",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("custom_ranking_user_idx").on(table.userId),
    index("custom_ranking_created_idx").on(table.createdAt),
  ],
);

export const customRankingEntry = pgTable(
  "custom_ranking_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rankingId: uuid("ranking_id")
      .notNull()
      .references(() => customRanking.id, { onDelete: "cascade" }),
    fighterId: uuid("fighter_id")
      .notNull()
      .references(() => fighter.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    note: text("note"),
  },
  (table) => [
    index("custom_ranking_entry_ranking_idx").on(table.rankingId),
    unique("custom_ranking_entry_pos_unique").on(table.rankingId, table.position),
    unique("custom_ranking_entry_fighter_unique").on(
      table.rankingId,
      table.fighterId,
    ),
  ],
);

export type CustomRanking = typeof customRanking.$inferSelect;
export type NewCustomRanking = typeof customRanking.$inferInsert;
export type CustomRankingEntry = typeof customRankingEntry.$inferSelect;
export type NewCustomRankingEntry = typeof customRankingEntry.$inferInsert;
