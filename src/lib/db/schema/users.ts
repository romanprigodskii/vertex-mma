import {
  char,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { transactionTypeEnum, userTierEnum } from "./enums";

export const userProfile = pgTable(
  "user_profile",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // References supabase auth.users.id — FK left out because that table is in another schema.
    authUserId: uuid("auth_user_id").notNull().unique(),

    username: text("username").notNull().unique(),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    bio: text("bio"),
    countryCode: char("country_code", { length: 2 }),

    balanceCoins: integer("balance_coins").default(10000).notNull(),
    totalCoinsEarned: integer("total_coins_earned").default(10000).notNull(),
    totalCoinsLost: integer("total_coins_lost").default(0).notNull(),

    simulationCount: integer("simulation_count").default(0).notNull(),
    predictionCount: integer("prediction_count").default(0).notNull(),
    betCount: integer("bet_count").default(0).notNull(),
    currentStreak: integer("current_streak").default(0).notNull(),
    bestStreak: integer("best_streak").default(0).notNull(),

    tier: userTierEnum("tier").default("bronze").notNull(),

    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastDailyBonusAt: timestamp("last_daily_bonus_at", { withTimezone: true }),
  },
  (table) => [
    index("user_profile_auth_idx").on(table.authUserId),
    index("user_profile_username_idx").on(table.username),
    index("user_profile_balance_idx").on(table.balanceCoins),
  ],
);

export const transaction = pgTable(
  "transaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),

    type: transactionTypeEnum("type").notNull(),
    amount: integer("amount").notNull(),
    balanceAfter: integer("balance_after").notNull(),

    description: text("description"),
    // FKs intentionally omitted — wave 4/5 will decide cardinality.
    relatedBetId: uuid("related_bet_id"),
    relatedAchievementId: uuid("related_achievement_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("transaction_user_idx").on(table.userId),
    index("transaction_created_idx").on(table.createdAt),
  ],
);

export const achievement = pgTable("achievement", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),

  name: text("name").notNull(),
  description: text("description").notNull(),
  iconUrl: text("icon_url"),
  rewardCoins: integer("reward_coins").default(0).notNull(),
  rarity: text("rarity").default("common").notNull(),
});

export const userAchievement = pgTable(
  "user_achievement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    achievementId: uuid("achievement_id")
      .notNull()
      .references(() => achievement.id),
    unlockedAt: timestamp("unlocked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("user_achievement_unique").on(table.userId, table.achievementId),
  ],
);

export type UserProfile = typeof userProfile.$inferSelect;
export type NewUserProfile = typeof userProfile.$inferInsert;
