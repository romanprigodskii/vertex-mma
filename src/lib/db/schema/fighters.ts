import { sql } from "drizzle-orm";
import {
  char,
  date,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import {
  fighterStatusEnum,
  stanceEnum,
  weightClassEnum,
} from "./enums";

export const fighter = pgTable(
  "fighter",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),

    nameEn: text("name_en").notNull(),
    nameRu: text("name_ru"),
    nickname: text("nickname"),

    dob: date("dob"),
    heightCm: integer("height_cm"),
    reachCm: integer("reach_cm"),
    legReachCm: integer("leg_reach_cm"),
    stance: stanceEnum("stance").default("unknown"),

    countryCode: char("country_code", { length: 2 }),
    fightingOutOf: text("fighting_out_of"),

    weightClassPrimary: weightClassEnum("weight_class_primary"),
    status: fighterStatusEnum("status").default("active"),
    careerStart: date("career_start"),
    careerEnd: date("career_end"),
    hallOfFameYear: integer("hall_of_fame_year"),

    photoUrl: text("photo_url"),
    photoSilhouetteUrl: text("photo_silhouette_url"),
    photoThumbnailUrl: text("photo_thumbnail_url"),
    photoLicense: text("photo_license"),
    photoSourceUrl: text("photo_source_url"),
    photoAttribution: text("photo_attribution"),
    photoFetchedAt: timestamp("photo_fetched_at", { withTimezone: true }),
    photoFetchStatus: text("photo_fetch_status"),

    ufcStatsId: text("ufc_stats_id").unique(),
    sherdogId: text("sherdog_id").unique(),
    tapologyId: text("tapology_id").unique(),
    wikipediaUrl: text("wikipedia_url"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (table) => [
    index("fighter_slug_idx").on(table.slug),
    index("fighter_name_en_idx").on(table.nameEn),
    index("fighter_weight_class_idx").on(table.weightClassPrimary),
    index("fighter_status_idx").on(table.status),
    index("fighter_name_en_trgm_idx").using(
      "gin",
      sql`${table.nameEn} gin_trgm_ops`,
    ),
  ],
);

export const fighterAlias = pgTable(
  "fighter_alias",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fighterId: uuid("fighter_id")
      .notNull()
      .references(() => fighter.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("fighter_alias_alias_idx").on(table.alias),
    index("fighter_alias_alias_trgm_idx").using(
      "gin",
      sql`${table.alias} gin_trgm_ops`,
    ),
  ],
);

export const fighterStatsAggregate = pgTable("fighter_stats_aggregate", {
  fighterId: uuid("fighter_id")
    .primaryKey()
    .references(() => fighter.id, { onDelete: "cascade" }),

  winsTotal: integer("wins_total").default(0).notNull(),
  lossesTotal: integer("losses_total").default(0).notNull(),
  drawsTotal: integer("draws_total").default(0).notNull(),
  noContests: integer("no_contests").default(0).notNull(),

  winsKo: integer("wins_ko").default(0).notNull(),
  winsSub: integer("wins_sub").default(0).notNull(),
  winsDec: integer("wins_dec").default(0).notNull(),

  lossesKo: integer("losses_ko").default(0).notNull(),
  lossesSub: integer("losses_sub").default(0).notNull(),
  lossesDec: integer("losses_dec").default(0).notNull(),

  slpm: real("slpm"),
  strAcc: real("str_acc"),
  sapm: real("sapm"),
  strDef: real("str_def"),
  tdAvg: real("td_avg"),
  tdAcc: real("td_acc"),
  tdDef: real("td_def"),
  subAvg: real("sub_avg"),

  overallRating: integer("overall_rating"),
  strikingRating: integer("striking_rating"),
  grapplingRating: integer("grappling_rating"),
  cardioRating: integer("cardio_rating"),
  chinRating: integer("chin_rating"),
  powerRating: integer("power_rating"),
  iqRating: integer("iq_rating"),

  computedAt: timestamp("computed_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type Fighter = typeof fighter.$inferSelect;
export type NewFighter = typeof fighter.$inferInsert;
