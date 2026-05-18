import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  real,
  serial,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  fighterStatusEnum,
  rosterStatusEnum,
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

    // Inferred by scripts/infer_fighter_gender.ts (Wave 3.5 step 5C) since
    // the UFCStats scrape doesn't carry gender. Defaults to 'male'; the
    // script seeds strawweight + known women champions/challengers and
    // expands transitively through bouts.
    gender: text("gender").default("male").notNull(),

    weightClassPrimary: weightClassEnum("weight_class_primary"),
    status: fighterStatusEnum("status").default("active"),
    careerStart: date("career_start"),
    careerEnd: date("career_end"),
    hallOfFameYear: integer("hall_of_fame_year"),

    // Wave 3.5 step 6A.5: UFC roster membership tracked via roster.watch
    // imports (scripts/import_roster_watch.ts). 'active' = currently on UFC
    // contract; 'released' = ex-UFC found in roster.watch former roster;
    // 'retired' = ex-UFC + HoF flag; 'inactive' = legacy fighter not in either
    // roster.watch CSV; 'unknown' = never matched. Drives is_active and
    // activity inputs in fighter_vertex_score view (Wave 3.5 step 6A.5.4).
    rosterStatus: rosterStatusEnum("roster_status").default("unknown").notNull(),
    rosterStatusUpdatedAt: timestamp("roster_status_updated_at", { withTimezone: true }),
    hasUpcomingBout: boolean("has_upcoming_bout").default(false).notNull(),
    nextEventDate: date("next_event_date"),
    nextOpponentName: text("next_opponent_name"),
    eloRosterWatch: integer("elo_roster_watch"),

    photoUrl: text("photo_url"),
    photoSilhouetteUrl: text("photo_silhouette_url"),
    photoThumbnailUrl: text("photo_thumbnail_url"),
    photoLicense: text("photo_license"),
    photoSourceUrl: text("photo_source_url"),
    photoAttribution: text("photo_attribution"),
    photoFetchedAt: timestamp("photo_fetched_at", { withTimezone: true }),
    photoFetchStatus: text("photo_fetch_status"),

    // Vertex Score system (Wave 3.5).
    //
    // championshipPedigree — 0-100, backfilled by
    //   scripts/compute_championship_pedigree.ts from championship-history.ts
    //   (+ title-challenger-history.ts).
    // peakScore — 0-100, backfilled by scripts/compute_peak_scores.ts using a
    //   sliding 5-fight window (wins*12 + KO*5 + sub*5 + title*4, cap 100).
    //   NULL for fighters with < 10 UFC bouts; the all-time formula treats
    //   NULL as 0 via COALESCE.
    // vertexScore — current score, materialized from the fighter_vertex_score
    //   view. NULL for fighters with <3 UFC bouts OR last_fight_date older
    //   than 36 months (we don't rank retired legends as "current").
    // vertexScoreAllTime — same view, populated for any fighter with >= 3
    //   UFC bouts; drops Activity, adds Peak, applies a flat total-loss
    //   penalty so retired legends and journeymen calibrate correctly.
    championshipPedigree: integer("championship_pedigree").default(0).notNull(),
    // Wave 12: derived bucket used in current_score formula in place of
    // championship_pedigree. Populated by scripts/compute_current_cp.ts
    // after compute_championship_pedigree.ts. Applies time-decay +
    // recent-opp-quality bonus to former-champion buckets (80/70); other
    // buckets (100/90/40/0) pass through unchanged. championship_pedigree
    // itself remains the eternal-legacy value used by all_time_score and
    // UI tier classification.
    //
    // Wave 13.1: nullable. NULL for non-active (retired/released) fighters —
    // current_cp is a "current relevance" signal, undefined for fighters
    // who aren't in the current roster.
    currentCp: smallint("current_cp"),
    isDominantChampion: boolean("is_dominant_champion").default(false).notNull(),
    // Wave 3.5 step 5F: +30 added to quality_wins_score (above its 100 cap)
    // for fighters with 0 real UFC losses (DQ excluded), 8+ wins, and any
    // recorded championship reign. 0 for everyone else.
    undefeatedBonus: integer("undefeated_bonus").default(0).notNull(),
    peakScore: integer("peak_score"),
    eraDominance: integer("era_dominance").default(0).notNull(),
    // Wave 3.5 step 5E: split current vs all-time so the active-champion
    // bonus only inflates the current score.
    eraDominanceAllTime: integer("era_dominance_all_time").default(0).notNull(),
    vertexScore: integer("vertex_score"),
    vertexScoreAllTime: integer("vertex_score_all_time"),

    // Wave 6C.1: roster.watch extension fields. peak_rank uses -1 for
    // "was champion", 1..15 for "peaked at that contender slot", NULL
    // for "never ranked". Same shape for peak_p4p. current_streak is
    // the W/L counter from roster.watch (positive = win streak, negative
    // = losing). Wave 6C.2 reads peak_rank as a fallback when a bout
    // pre-dates 2017 and ranking_snapshot has no row.
    peakRank: smallint("peak_rank"),
    peakP4p: smallint("peak_p4p"),
    currentStreak: smallint("current_streak"),

    // Wave 6C.2: rank-tier win counters from compute_opponent_quality.ts.
    // Top-5/10/15 wins where the opponent's UFC.com rank (within 4 weeks
    // of bout date) outranked the champion-tier classification. Feed into
    // quality_wins_score as +15/+8/+4 each.
    top5Wins: integer("top5_wins").default(0).notNull(),
    top10Wins: integer("top10_wins").default(0).notNull(),
    top15Wins: integer("top15_wins").default(0).notNull(),

    // Wave 18: bout-derived aggregates powering the rebuilt radar
    // attributes in src/lib/fighter-attributes.ts. Populated by
    // scripts/compute_radar_aggregates.ts. NULL for fighters with zero
    // completed UFC bouts.
    //   control_seconds_avg     — mean control_time seconds per completed
    //                             UFC bout (summed across rounds). Powers
    //                             the new Grappling axis so wrestlers
    //                             whose game is hold-down dominance score
    //                             high even without finish-heavy stat
    //                             lines.
    //   knockdowns_per_fight    — mean knockdowns landed per UFC bout.
    //                             KO power proxy folded into Striking.
    //   late_round_reach_rate   — share of bouts that reached round ≥2
    //                             (or NULL round_finished → decision /
    //                             went distance). Replaces the old
    //                             "% wins by decision" cardio proxy that
    //                             punished finishers.
    //   fights_last_24mo        — count of completed UFC bouts in the
    //                             trailing 24 months. Drives the rebuilt
    //                             Activity axis (recent, not career
    //                             tenure).
    controlSecondsAvg: doublePrecision("control_seconds_avg"),
    knockdownsPerFight: doublePrecision("knockdowns_per_fight"),
    lateRoundReachRate: doublePrecision("late_round_reach_rate"),
    fightsLast24mo: smallint("fights_last_24mo"),

    // Wave 18.3: per-bout time-decay-weighted aggregates. Same decay
    // curve as Wave 15 quality_wins (1.0 within 1y → linearly to 0.3 at
    // 3y → linearly to 0.1 at 5y → 0.1 floor). Populated by the same
    // scripts/compute_radar_aggregates.ts run that fills the Wave 18
    // career columns above. NULL for fighters with no completed UFC
    // bouts (radar falls back to the career column via ??).
    //
    // *_per_fight  values are weighted means: Σ(stat × df) / Σ(df).
    // *_weighted   values are weighted SUMs (used as numerators in
    //              ratio formulas inside computeAttributes).
    // decayed_total_weight is Σ(df) — denominator for ratio fields and
    // a sample-size proxy for confidence weighting.
    decayedTotalWeight: doublePrecision("decayed_total_weight"),
    decayedKdPerFight: doublePrecision("decayed_kd_per_fight"),
    decayedControlPerFight: doublePrecision("decayed_control_per_fight"),
    decayedTdLandedPerFight: doublePrecision("decayed_td_landed_per_fight"),
    decayedTdAttemptedPerFight: doublePrecision("decayed_td_attempted_per_fight"),
    decayedSubAttemptsPerFight: doublePrecision("decayed_sub_attempts_per_fight"),
    decayedKoWinsWeighted: doublePrecision("decayed_ko_wins_weighted"),
    decayedSubWinsWeighted: doublePrecision("decayed_sub_wins_weighted"),
    decayedWinsWeighted: doublePrecision("decayed_wins_weighted"),
    decayedLateReachRate: doublePrecision("decayed_late_reach_rate"),
    decayedFinishLossesWeighted: doublePrecision("decayed_finish_losses_weighted"),
    decayedSlpm: doublePrecision("decayed_slpm"),
    decayedSapm: doublePrecision("decayed_sapm"),

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
    index("fighter_roster_status_idx").on(table.rosterStatus),
    index("fighter_has_upcoming_bout_idx").on(table.hasUpcomingBout),
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

// Wave 6C.1: historical UFC.com/rankings snapshots from Wayback Machine.
// One row per (snapshot_date, division, rank, fighter_name_raw, is_women).
// rank=0 is the champion slot (interim listed in the same slot per UFC's
// page); rank=1..15 are contenders. fighter_id is nullable because
// fuzzy-matching can fail — we keep fighter_name_raw and let a future
// re-match pass resolve it. is_women disambiguates men's vs women's
// flyweight/bantamweight (the weight_class enum is gender-agnostic).
// fighter_name_raw is part of the unique key so genuine UFC tied-rank
// publications (~406 of 38,490 source rows) round-trip without conflict.
export const rankingSnapshot = pgTable(
  "ranking_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotDate: date("snapshot_date").notNull(),
    division: weightClassEnum("division").notNull(),
    isWomen: boolean("is_women").default(false).notNull(),
    rank: smallint("rank").notNull(),
    fighterId: uuid("fighter_id").references(() => fighter.id, {
      onDelete: "set null",
    }),
    fighterNameRaw: text("fighter_name_raw").notNull(),
    sourceUrl: text("source_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("ranking_snapshot_unique").on(
      table.snapshotDate,
      table.division,
      table.rank,
      table.fighterNameRaw,
      table.isWomen,
    ),
    index("ranking_snapshot_date_idx").on(table.snapshotDate),
    index("ranking_snapshot_fighter_idx").on(table.fighterId),
    index("ranking_snapshot_div_date_idx").on(
      table.division,
      sql`${table.snapshotDate} DESC`,
    ),
    index("ranking_snapshot_gender_div_date_idx").on(
      table.division,
      table.isWomen,
      sql`${table.snapshotDate} DESC`,
    ),
  ],
);

// Wave 14A: per-(fighter, division) current_score. Backend foundation —
// UI continues to read fighter.vertex_score (global) in Wave 14A; a
// later wave wires the divisional values into the UI.
//
// One row per (fighter_id, division) pair where the fighter has ≥3
// completed UFC bouts in that division. Populated by
// scripts/materialize_divisional_score.ts, which reads
// fighter_divisional_vertex_score (migration 0047), injects a divisional
// championship-pedigree value (championship-history.ts scoped to the
// division), and recomputes raw_current + curve + skid using the locked
// Wave 15.1 formula.
//
// All-time is intentionally not represented here — all_time stays
// global. divisional_status takes one of:
//   'current'     — roster_status='active', current_division=division,
//                   last bout in division within 24mo, ≥5 bouts in
//                   division
//   'provisional' — same active criteria but only 3-4 bouts in division
//                   (sample size too small for full confidence)
//   'former'      — ≥3 bouts in division but no longer in it (retired,
//                   released, moved up/down, or lapsed >24mo)
export const fighterDivisionalScore = pgTable(
  "fighter_divisional_score",
  {
    id: serial("id").primaryKey(),
    fighterId: uuid("fighter_id")
      .notNull()
      .references(() => fighter.id, { onDelete: "cascade" }),
    division: weightClassEnum("division").notNull(),

    // Headline divisional score.
    rawCurrent: doublePrecision("raw_current"),
    multipliedCurrent: smallint("multiplied_current"),
    vertexScore: smallint("vertex_score"),

    // Activity / status.
    boutsInDivision: smallint("bouts_in_division").notNull(),
    lastBoutDateInDivision: date("last_bout_date_in_division"),
    divisionalStatus: text("divisional_status").notNull(),

    // Wave 14B.1: eligibility for active-division ranking display.
    // TRUE iff the fighter's primary current division (current_division ??
    // weight_class_primary) matches this row's division, OR they have a
    // scheduled bout in this division. FALSE-rows stay in the table for
    // fighter-profile history but are filtered out of ranking queries
    // downstream.
    inActiveRanking: boolean("in_active_ranking").notNull().default(false),

    // Sub-metric audit trail — mirrors fighter_vertex_score columns.
    qualityWinsDecayed: doublePrecision("quality_wins_decayed"),
    divisionalCp: smallint("divisional_cp"),
    divisionalCurrentCp: smallint("divisional_current_cp"),
    eraDominanceCurrent: doublePrecision("era_dominance_current"),
    performanceDiffCurrent: doublePrecision("performance_diff_current"),
    finishingDominanceDecayed: doublePrecision("finishing_dominance_decayed"),
    activity: doublePrecision("activity"),
    recentFormScore: smallint("recent_form_score"),
    recentLossPenalty: doublePrecision("recent_loss_penalty"),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("fighter_divisional_unique").on(table.fighterId, table.division),
    index("fighter_divisional_fighter_idx").on(table.fighterId),
    index("fighter_divisional_division_idx").on(table.division),
    index("fighter_divisional_score_idx").on(
      table.division,
      sql`${table.vertexScore} DESC NULLS LAST`,
    ),
  ],
);

export type Fighter = typeof fighter.$inferSelect;
export type NewFighter = typeof fighter.$inferInsert;
export type RankingSnapshot = typeof rankingSnapshot.$inferSelect;
export type NewRankingSnapshot = typeof rankingSnapshot.$inferInsert;
export type FighterDivisionalScore = typeof fighterDivisionalScore.$inferSelect;
export type NewFighterDivisionalScore = typeof fighterDivisionalScore.$inferInsert;
