import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { transactionTypeEnum, userTierEnum } from "./enums";
import { bet } from "./markets";

// Supabase manages auth.users in the `auth` schema. We declare a minimal handle
// to it here ONLY so user_profile.auth_user_id can carry a real FK: deleting an
// auth user (app, admin API, or Supabase dashboard) now structurally cascades
// the whole per-user graph, independent of any trigger being present. drizzle-kit's
// schemaFilter is `public`, so it uses this for the FK but never manages the table.
const authUsers = pgSchema("auth").table("users", {
  id: uuid("id").primaryKey(),
});

export const userProfile = pgTable(
  "user_profile",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Hard FK to auth.users with ON DELETE CASCADE — orphan prevention is now
    // enforced by the DB, not just the on_auth_user_deleted trigger.
    authUserId: uuid("auth_user_id")
      .notNull()
      .unique()
      .references(() => authUsers.id, { onDelete: "cascade" }),

    username: text("username").notNull().unique(),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    bio: text("bio"),
    countryCode: char("country_code", { length: 2 }),

    // bigint (not int4): these are lifetime accumulators that grow unbounded
    // over years; int4 overflows past ~2.1B. mode:"number" keeps the TS type a
    // plain number (coin totals stay well under 2^53).
    balanceCoins: bigint("balance_coins", { mode: "number" })
      .default(10000)
      .notNull(),
    totalCoinsEarned: bigint("total_coins_earned", { mode: "number" })
      .default(10000)
      .notNull(),
    totalCoinsLost: bigint("total_coins_lost", { mode: "number" })
      .default(0)
      .notNull(),

    betCount: bigint("bet_count", { mode: "number" }).default(0).notNull(),
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
    // Wave 47: rate-limits username changes to once per 30 days.
    usernameLastChangedAt: timestamp("username_last_changed_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    index("user_profile_auth_idx").on(table.authUserId),
    index("user_profile_username_idx").on(table.username),
    index("user_profile_balance_idx").on(table.balanceCoins),
    // Backstop against any residual debit race: the coin balance can never go
    // negative. placeBetAction already locks this row FOR UPDATE and debits
    // relatively, but the constraint makes overspend impossible at the DB level.
    check("user_profile_balance_non_negative", sql`${table.balanceCoins} >= 0`),
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
    // bigint to match balance_coins: amount/balance_after share the coin domain,
    // and balance_after is a direct snapshot of the (now bigint) balance.
    amount: bigint("amount", { mode: "number" }).notNull(),
    balanceAfter: bigint("balance_after", { mode: "number" }).notNull(),

    description: text("description"),
    // The ledger is immutable history, so a deleted bet/achievement must not
    // delete its ledger row — null the reference instead (ON DELETE SET NULL).
    relatedBetId: uuid("related_bet_id").references(() => bet.id, {
      onDelete: "set null",
    }),
    relatedAchievementId: uuid("related_achievement_id").references(
      () => achievement.id,
      { onDelete: "set null" },
    ),

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

// Wave 46: in-app notifications. INSERTs happen exclusively from PL/pgSQL
// helpers (settle_market_winner / settle_market_method / refund_market /
// unlock_achievement / on_bout_score_predictions), so RLS only exposes
// SELECT + UPDATE (mark-read) to the owner.
//
// `type` is a string discriminator — common values:
//   bet_settled, prediction_scored, achievement_unlocked, system.
// We keep it as text rather than an enum so future categories don't need
// a migration just to add a value.
export const notification = pgTable(
  "notification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    // Wave 49: structured payload for client-side localization — { key, …vals }.
    // The stored title/body remain the English fallback for old/unmapped rows.
    params: jsonb("params").$type<Record<string, unknown>>(),
    isRead: boolean("is_read").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("notification_user_unread_idx").on(table.userId, table.isRead),
    index("notification_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export type UserProfile = typeof userProfile.$inferSelect;
export type NewUserProfile = typeof userProfile.$inferInsert;
export type Notification = typeof notification.$inferSelect;
export type NewNotification = typeof notification.$inferInsert;
