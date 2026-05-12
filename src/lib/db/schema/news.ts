import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { newsClassificationEnum, newsStatusEnum } from "./enums";
import { bout } from "./events";

export const newsSource = pgTable("news_source", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),

  name: text("name").notNull(),
  url: text("url").notNull(),
  feedUrl: text("feed_url"),
  type: text("type").notNull(),

  isTrusted: boolean("is_trusted").default(false).notNull(),
  baseConfidence: real("base_confidence").default(0.5).notNull(),
  isActive: boolean("is_active").default(true).notNull(),

  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const newsItem = pgTable(
  "news_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => newsSource.id),

    externalId: text("external_id"),
    url: text("url").notNull().unique(),

    title: text("title").notNull(),
    body: text("body"),
    author: text("author"),

    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),

    classification: newsClassificationEnum("classification"),
    confidence: real("confidence"),

    relatedBoutId: uuid("related_bout_id").references(() => bout.id),
    relatedFighterIds: uuid("related_fighter_ids")
      .array()
      .default(sql`'{}'::uuid[]`),

    status: newsStatusEnum("status").default("pending").notNull(),

    embedding: vector("embedding", { dimensions: 384 }),
  },
  (table) => [
    index("news_item_published_idx").on(table.publishedAt),
    index("news_item_status_idx").on(table.status),
    index("news_item_classification_idx").on(table.classification),
    index("news_item_related_bout_idx").on(table.relatedBoutId),
  ],
);
