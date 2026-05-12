import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { userProfile } from "./users";

export type FightCardBout = {
  fighterAId: string;
  fighterBId: string;
  weightClass: string;
  isMain: boolean;
  order: number;
};

export const fightCard = pgTable(
  "fight_card",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),

    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),

    backgroundId: text("background_id").default("default"),
    themeColor: text("theme_color").default("primary"),
    titleFont: text("title_font").default("display"),

    bouts: jsonb("bouts").$type<FightCardBout[]>().notNull(),

    shareImageUrl: text("share_image_url"),
    isPublic: boolean("is_public").default(true).notNull(),

    viewCount: integer("view_count").default(0).notNull(),
    likeCount: integer("like_count").default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("fight_card_user_idx").on(table.userId),
    index("fight_card_slug_idx").on(table.slug),
    index("fight_card_public_idx").on(table.isPublic),
  ],
);

export const fightCardLike = pgTable(
  "fight_card_like",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    fightCardId: uuid("fight_card_id")
      .notNull()
      .references(() => fightCard.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.fightCardId] }),
  ],
);
