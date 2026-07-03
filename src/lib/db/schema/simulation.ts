import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { bout } from "./events";
import { fighter } from "./fighters";
import { userProfile } from "./users";

// Phase 1 simulation output (scripts/simulation, LightGBM+XGB+LogReg ensemble,
// blended — NOT post-hoc calibrated). Mirrors the JSON written by predict.py —
// see that file for the model contract. One row per (bout, model_version) so we
// keep a history when we retrain under a new version.
export const boutSimulation = pgTable(
  "bout_simulation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boutId: uuid("bout_id")
      .notNull()
      .references(() => bout.id, { onDelete: "cascade" }),
    modelVersion: text("model_version").notNull(),
    /** Blended model probability that fighter A wins (NOT post-hoc
     *  calibrated — see scripts/simulation/src/ensemble.py). probB = 1 - probA. */
    probA: real("prob_a").notNull(),
    probB: real("prob_b").notNull(),
    /** The fighter the model thinks wins — convenient for UI joins. */
    predictedWinnerId: uuid("predicted_winner_id").references(
      () => fighter.id,
      { onDelete: "set null" },
    ),
    /** 'low' / 'medium' / 'high' — derived from |prob - 0.5|. See
     *  scripts/simulation/src/config.py CONFIDENCE_BANDS. */
    confidenceLabel: text("confidence_label").notNull(),
    /** Market-implied prob A wins from the latest (closing) sportsbook line,
     *  if any line was scraped by prediction time. NULL otherwise. Used only
     *  for the edge/value display (edgeA below) — it is NOT a model input
     *  (the closing line is a near-leak and is missing for most upcoming
     *  bouts; see scripts/simulation/src/features.py). */
    marketProbA: real("market_prob_a"),
    /** model_prob_a - market_prob_a. Positive = model thinks A is more
     *  likely than the market does. Used for the "value" indicator in
     *  Phase 2. */
    edgeA: real("edge_a"),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("bout_simulation_unique").on(table.boutId, table.modelVersion),
    index("bout_simulation_bout_idx").on(table.boutId),
    index("bout_simulation_version_idx").on(table.modelVersion),
  ],
);

export type BoutSimulation = typeof boutSimulation.$inferSelect;
export type NewBoutSimulation = typeof boutSimulation.$inferInsert;

// Phase 2: per-prediction SHAP attributions. One row per
// (bout, model_version, feature) — we keep the top N (default 8) so the
// UI can render a "why" breakdown without re-running the model. shapValue
// is the raw TreeSHAP contribution in the model's log-odds space (signed,
// positive = pushed prediction toward fighter A winning). featureValue
// stores the raw input that fed the model so the UI can show the actual
// number alongside the attribution (e.g. "Reach +6 cm").
export const boutSimulationFeatures = pgTable(
  "bout_simulation_features",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boutId: uuid("bout_id")
      .notNull()
      .references(() => bout.id, { onDelete: "cascade" }),
    modelVersion: text("model_version").notNull(),
    featureName: text("feature_name").notNull(),
    /** Signed TreeSHAP contribution toward "A wins". */
    shapValue: real("shap_value").notNull(),
    /** Raw feature value at prediction time. NULL when the feature was
     *  itself missing (LightGBM handles missingness natively, SHAP
     *  attribution still computes). */
    featureValue: real("feature_value"),
    /** 1-indexed rank by |shap_value| within this (bout, model_version) —
     *  lets the UI ORDER BY abs_rank ASC LIMIT N without re-sorting. */
    absRank: smallint("abs_rank").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("bout_simulation_features_unique").on(
      table.boutId,
      table.modelVersion,
      table.featureName,
    ),
    index("bout_simulation_features_bout_idx").on(table.boutId),
    index("bout_simulation_features_bout_rank_idx").on(
      table.boutId,
      table.modelVersion,
      table.absRank,
    ),
  ],
);

export type BoutSimulationFeatureRow = typeof boutSimulationFeatures.$inferSelect;
export type NewBoutSimulationFeatureRow = typeof boutSimulationFeatures.$inferInsert;

// Phase 3: Monte Carlo round-by-round distribution. One row per
// (bout, model_version). Summary columns mirror the most-clicked
// numbers in the UI; `distribution` JSONB carries the full payload
// (e.g., per-round per-method per-fighter probabilities) for richer
// drilldown.
export const boutSimulationRounds = pgTable(
  "bout_simulation_rounds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boutId: uuid("bout_id")
      .notNull()
      .references(() => bout.id, { onDelete: "cascade" }),
    modelVersion: text("model_version").notNull(),
    nSimulations: integer("n_simulations").notNull(),
    /** The Monte-Carlo sim's OWN winner prob. DIAGNOSTIC ONLY — every consumer
     *  (panel, sportsbook) reconciles the method/round split to the ENSEMBLE
     *  winner prob (bout_simulation.prob_a), which is what bets settle against.
     *  Kept for debugging the MC vs the ensemble; do NOT bet/score off these. */
    mcWinnerProbA: real("mc_winner_prob_a").notNull(),
    mcWinnerProbB: real("mc_winner_prob_b").notNull(),
    probKoA: real("prob_ko_a").notNull(),
    probKoB: real("prob_ko_b").notNull(),
    probSubA: real("prob_sub_a").notNull(),
    probSubB: real("prob_sub_b").notNull(),
    probDecisionA: real("prob_decision_a").notNull(),
    probDecisionB: real("prob_decision_b").notNull(),
    avgFinishSeconds: real("avg_finish_seconds"),
    probFinishRound1: real("prob_finish_round_1"),
    probFinishRound2: real("prob_finish_round_2"),
    probFinishRound3: real("prob_finish_round_3"),
    probFinishRound4: real("prob_finish_round_4"),
    probFinishRound5: real("prob_finish_round_5"),
    distribution: jsonb("distribution").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("bout_simulation_rounds_unique").on(table.boutId, table.modelVersion),
    index("bout_simulation_rounds_bout_idx").on(table.boutId),
  ],
);

export type BoutSimulationRoundsRow = typeof boutSimulationRounds.$inferSelect;
export type NewBoutSimulationRoundsRow = typeof boutSimulationRounds.$inferInsert;

// Wave 62 — custom "dream fight" simulation queue. Users pick two fighters
// and, per fighter, the bout whose form to take (NULL as_of = current form:
// the fighter's full history to date; a set as_of = history up to AND
// INCLUDING that bout — post-fight form). The Next.js server action INSERTs
// status='pending'; the Python worker (scripts/simulation/scripts/
// run_custom.py, systemd vertex-sim-worker on the VPS) scores the matchup
// with the committed ensemble + Monte Carlo and fills `result` jsonb.
// Created by drizzle/migrations/0090 (scripts/apply_custom_simulation.ts);
// declared here so db:push never sees it as an unknown table to drop.
export const customSimulation = pgTable(
  "custom_simulation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userProfileId: uuid("user_profile_id").references(() => userProfile.id, {
      onDelete: "set null",
    }),
    fighterAId: uuid("fighter_a_id")
      .notNull()
      .references(() => fighter.id, { onDelete: "cascade" }),
    fighterBId: uuid("fighter_b_id")
      .notNull()
      .references(() => fighter.id, { onDelete: "cascade" }),
    asOfBoutAId: uuid("as_of_bout_a_id").references(() => bout.id, {
      onDelete: "set null",
    }),
    asOfBoutBId: uuid("as_of_bout_b_id").references(() => bout.id, {
      onDelete: "set null",
    }),
    /** 'pending' | 'done' | 'failed' */
    status: text("status").notNull().default("pending"),
    modelVersion: text("model_version"),
    /** Full scored payload (probs, MC method/round split, per-side form
     *  snapshots, sim context) — shape versioned by model_version; see
     *  scripts/simulation/src/custom.py. */
    result: jsonb("result"),
    error: text("error"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "custom_simulation_distinct_fighters",
      sql`${table.fighterAId} <> ${table.fighterBId}`,
    ),
    check(
      "custom_simulation_status_check",
      sql`${table.status} IN ('pending', 'done', 'failed')`,
    ),
    index("custom_simulation_user_idx").on(
      table.userProfileId,
      table.requestedAt,
    ),
    index("custom_simulation_pair_idx").on(
      table.fighterAId,
      table.fighterBId,
      table.status,
    ),
  ],
);

export type CustomSimulationRow = typeof customSimulation.$inferSelect;
export type NewCustomSimulationRow = typeof customSimulation.$inferInsert;
