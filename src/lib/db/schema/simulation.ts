import {
  index,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { bout } from "./events";
import { fighter } from "./fighters";

// Phase 1 simulation output (scripts/simulation, LightGBM + isotonic
// calibration). Mirrors the JSON written by predict.py — see that file
// for the model contract. One row per (bout, model_version) so we keep
// a history when we retrain under a new version.
export const boutSimulation = pgTable(
  "bout_simulation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boutId: uuid("bout_id")
      .notNull()
      .references(() => bout.id, { onDelete: "cascade" }),
    modelVersion: text("model_version").notNull(),
    /** Calibrated probability that fighter A wins. probB = 1 - probA. */
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
    /** Market-implied prob A wins, if opening odds were available at
     *  prediction time. NULL otherwise. */
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
