import {
  index,
  pgTable,
  real,
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
