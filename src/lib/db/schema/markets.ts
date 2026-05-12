import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { marketStatusEnum, marketTypeEnum } from "./enums";
import { bout } from "./events";
import { userProfile } from "./users";

export const market = pgTable(
  "market",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boutId: uuid("bout_id")
      .notNull()
      .references(() => bout.id, { onDelete: "cascade" }),

    type: marketTypeEnum("type").notNull(),
    question: text("question").notNull(),

    status: marketStatusEnum("status").default("open").notNull(),
    // No FK — outcome resolution may belong to outcomes table created after.
    resolvedOutcomeId: uuid("resolved_outcome_id"),

    bParameter: real("b_parameter").default(100).notNull(),

    totalVolume: integer("total_volume").default(0).notNull(),
    uniqueTraders: integer("unique_traders").default(0).notNull(),

    opensAt: timestamp("opens_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("market_bout_idx").on(table.boutId),
    index("market_status_idx").on(table.status),
    index("market_closes_idx").on(table.closesAt),
  ],
);

export const marketOutcome = pgTable(
  "market_outcome",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    marketId: uuid("market_id")
      .notNull()
      .references(() => market.id, { onDelete: "cascade" }),

    label: text("label").notNull(),
    orderIndex: integer("order_index").notNull(),

    currentShares: real("current_shares").default(0).notNull(),
    currentPrice: real("current_price").notNull(),

    isWinning: boolean("is_winning"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("market_outcome_market_idx").on(table.marketId)],
);

export const bet = pgTable(
  "bet",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    marketId: uuid("market_id")
      .notNull()
      .references(() => market.id, { onDelete: "cascade" }),
    outcomeId: uuid("outcome_id")
      .notNull()
      .references(() => marketOutcome.id),

    sharesBought: real("shares_bought").notNull(),
    coinsSpent: integer("coins_spent").notNull(),
    priceAtPurchase: real("price_at_purchase").notNull(),

    payout: integer("payout"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("bet_user_idx").on(table.userId),
    index("bet_market_idx").on(table.marketId),
  ],
);

export type Market = typeof market.$inferSelect;
export type NewMarket = typeof market.$inferInsert;
export type MarketOutcome = typeof marketOutcome.$inferSelect;
export type NewMarketOutcome = typeof marketOutcome.$inferInsert;
