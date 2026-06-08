import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  fixedOddsBetStatusEnum,
  fixedOddsMarketEnum,
  marketStatusEnum,
  marketTypeEnum,
} from "./enums";
import { bout } from "./events";
import { fighter } from "./fighters";
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

    // bigint: lifetime traded volume accumulates unbounded; int4 overflows.
    totalVolume: bigint("total_volume", { mode: "number" })
      .default(0)
      .notNull(),
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

    // double precision (not real/float4): the LMSR share total feeds payout via
    // ROUND(shares_bought); float32's ~0.06 granularity at large positions drifts
    // sub-coin. Prices stay real — they live in [0,1] where float32 is plenty.
    currentShares: doublePrecision("current_shares").default(0).notNull(),
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
    // Bets die with their outcome. A market_outcome is only ever removed when
    // its parent market is deleted, which already cascades bets via market_id;
    // cascading here too makes the outcome→bet lifecycle explicit and uniform
    // with the market→bet / market→market_outcome cascades. (cascade, not
    // restrict: ON DELETE RESTRICT is checked immediately and would break the
    // market-delete cascade — Postgres can delete the referenced
    // market_outcome before the referencing bet rows. NO ACTION/cascade defer
    // / cascade the check, so the diamond delete stays valid.)
    outcomeId: uuid("outcome_id")
      .notNull()
      .references(() => marketOutcome.id, { onDelete: "cascade" }),

    // double precision: this is the payout basis via ROUND(shares_bought).
    sharesBought: doublePrecision("shares_bought").notNull(),
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

// Vertex Sportsbook — fixed-odds bet. Unlike the LMSR `bet` (shares at a
// moving price), this stakes coins at a FIXED decimal odds locked from our
// model at placement time; payout = floor(stake × decimal_odds) on a win.
// Settlement (src/lib/sportsbook-data.ts) grades selection_code against the
// resolved bout. selected_fighter_id is denormalised for winner/method bets
// so grading needs no extra join.
export const fixedOddsBet = pgTable(
  "fixed_odds_bet",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    boutId: uuid("bout_id")
      .notNull()
      .references(() => bout.id, { onDelete: "cascade" }),

    marketKind: fixedOddsMarketEnum("market_kind").notNull(),
    /** Selection code from src/lib/sportsbook.ts (win_a, a_ko, o2_5, …). */
    selectionCode: text("selection_code").notNull(),
    /** Fighter the selection is about (winner/method); null for totals/distance. */
    selectedFighterId: uuid("selected_fighter_id").references(() => fighter.id, {
      onDelete: "set null",
    }),

    stakeCoins: integer("stake_coins").notNull(),
    /** Decimal odds locked at placement — payout basis, never recomputed. */
    decimalOdds: real("decimal_odds").notNull(),
    /** floor(stake × decimal_odds) — credited on a win. */
    potentialPayout: integer("potential_payout").notNull(),

    /** Model version + fair prob the odds were derived from (transparency). */
    modelVersion: text("model_version").notNull(),
    modelProb: real("model_prob").notNull(),

    status: fixedOddsBetStatusEnum("status").default("open").notNull(),
    /** Coins actually credited on settlement: payout on win, stake on void,
     *  0 on loss. Null while open. */
    payout: integer("payout"),
    settledAt: timestamp("settled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("fixed_odds_bet_user_idx").on(table.userId),
    index("fixed_odds_bet_bout_idx").on(table.boutId),
    index("fixed_odds_bet_status_idx").on(table.status),
    // Settlement grades a resolved bout's still-open bets: WHERE bout_id = X
    // AND status = 'open' (settle_fixed_odds_bets_for_bout). The composite
    // serves that predicate directly instead of scanning the bout index and
    // filtering status row-by-row on a popular bout's already-settled bets.
    index("fixed_odds_bet_bout_status_idx").on(table.boutId, table.status),
  ],
);

// Vertex Sportsbook — PARLAY (accumulator). One stake across N legs; combined
// odds = product of leg odds; wins only if every leg wins. A VOID leg (push:
// draw/NC/cancel) drops out and the combined odds recompute over the surviving
// legs. Settles when the LAST leg's bout resolves (or early-lost the moment any
// leg loses). Legs reuse the same selection codes + grading as single bets.
export const parlay = pgTable(
  "parlay",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),

    stakeCoins: integer("stake_coins").notNull(),
    /** Product of the leg odds at placement (display + max payout basis). */
    combinedOdds: real("combined_odds").notNull(),
    /** floor(stake × combinedOdds) — the all-legs-win payout. Recomputed
     *  lower at settlement if any leg voids out. */
    potentialPayout: integer("potential_payout").notNull(),
    numLegs: integer("num_legs").notNull(),

    status: fixedOddsBetStatusEnum("status").default("open").notNull(),
    /** Coins credited on settlement (won: stake×Πsurviving odds; void: stake;
     *  lost: 0). Null while open. */
    payout: integer("payout"),
    settledAt: timestamp("settled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("parlay_user_idx").on(table.userId),
    index("parlay_status_idx").on(table.status),
  ],
);

export const parlayLeg = pgTable(
  "parlay_leg",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parlayId: uuid("parlay_id")
      .notNull()
      .references(() => parlay.id, { onDelete: "cascade" }),
    boutId: uuid("bout_id")
      .notNull()
      .references(() => bout.id, { onDelete: "cascade" }),

    marketKind: fixedOddsMarketEnum("market_kind").notNull(),
    selectionCode: text("selection_code").notNull(),
    selectedFighterId: uuid("selected_fighter_id").references(() => fighter.id, {
      onDelete: "set null",
    }),
    /** Leg odds locked at placement. */
    decimalOdds: real("decimal_odds").notNull(),
    modelProb: real("model_prob").notNull(),

    status: fixedOddsBetStatusEnum("status").default("open").notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("parlay_leg_parlay_idx").on(table.parlayId),
    index("parlay_leg_bout_idx").on(table.boutId),
    index("parlay_leg_status_idx").on(table.status),
    // Settlement grades a resolved bout's still-open legs: WHERE bout_id = X
    // AND status = 'open' (settle_parlay_legs_for_bout). Composite serves it
    // directly, mirroring fixed_odds_bet_bout_status_idx.
    index("parlay_leg_bout_status_idx").on(table.boutId, table.status),
    // One leg per bout per parlay — no correlated same-bout legs.
    unique("parlay_leg_unique_bout").on(table.parlayId, table.boutId),
  ],
);

export type Market = typeof market.$inferSelect;
export type NewMarket = typeof market.$inferInsert;
export type MarketOutcome = typeof marketOutcome.$inferSelect;
export type NewMarketOutcome = typeof marketOutcome.$inferInsert;
export type FixedOddsBet = typeof fixedOddsBet.$inferSelect;
export type NewFixedOddsBet = typeof fixedOddsBet.$inferInsert;
export type Parlay = typeof parlay.$inferSelect;
export type NewParlay = typeof parlay.$inferInsert;
export type ParlayLeg = typeof parlayLeg.$inferSelect;
export type NewParlayLeg = typeof parlayLeg.$inferInsert;
