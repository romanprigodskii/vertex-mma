import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { newsClassificationEnum, newsStatusEnum } from "./enums";
import { bout } from "./events";
import { userProfile } from "./users";

/** Structured social/video references extracted from the source article at
 *  ingest. Rendered as inline platform-icon links (role=inline), big social
 *  cards (role=featured), or compact stacked cards (role=reaction). */
export type NewsExternalRef = {
  kind: "instagram" | "twitter" | "x" | "youtube" | "tiktok" | "link";
  url: string;
  /** Text in the article that pointed at this URL — used by the autolinker
   *  to find where to render an inline link or a featured embed. */
  anchor: string;
  role: "featured" | "inline" | "reaction";
  author?: string | null;
  handle?: string | null;
  /** Post body, if Haiku could extract it from the source HTML. */
  quote?: string | null;
  posted_at?: string | null;
  thumbnail_url?: string | null;
  duration?: string | null;
};

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
    bodyRephrased: text("body_rephrased"),
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

    externalRefs: jsonb("external_refs")
      .$type<NewsExternalRef[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
  },
  (table) => [
    index("news_item_published_idx").on(table.publishedAt),
    index("news_item_status_idx").on(table.status),
    index("news_item_classification_idx").on(table.classification),
    index("news_item_related_bout_idx").on(table.relatedBoutId),
  ],
);

/** User comments on news articles. App-layer auth: every insert goes through
 *  a server action that validates getCurrentUser(). RLS policies are deferred
 *  to Wave 3 per project plan. Replies are limited to depth 1 by the API
 *  layer — no nested threading. Deletion is soft via `deletedAt`. */
export const newsComment = pgTable(
  "news_comment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    newsItemId: uuid("news_item_id")
      .notNull()
      .references(() => newsItem.id, { onDelete: "cascade" }),
    userProfileId: uuid("user_profile_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    /** NULL for top-level comments; a comment id for replies. Replies-of-replies
     *  are flattened to the same parent at the API layer. */
    parentId: uuid("parent_id"),
    body: text("body").notNull(),
    upvotes: integer("upvotes").default(0).notNull(),
    downvotes: integer("downvotes").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("news_comment_item_created_idx").on(
      table.newsItemId,
      table.createdAt,
    ),
    index("news_comment_parent_idx").on(table.parentId),
    index("news_comment_user_idx").on(table.userProfileId),
    check(
      "news_comment_body_length",
      sql`char_length(body) BETWEEN 1 AND 2000`,
    ),
  ],
);
