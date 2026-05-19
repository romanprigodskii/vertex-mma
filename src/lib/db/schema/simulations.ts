import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { fighter } from "./fighters";
import { userProfile } from "./users";

export type SimulationResult = {
  winProbabilityA: number;
  winProbabilityB: number;
  methodDistribution: Record<string, number>;
  roundDistribution: Record<string, number>;
  mostLikelyScenario: string;
  keyFactors: Array<{ label: string; delta: number }>;
  modelVersion: string;
  gameplanA?: string;
  gameplanB?: string;
};

export const simulation = pgTable(
  "simulation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => userProfile.id, {
      onDelete: "set null",
    }),

    fighterAId: uuid("fighter_a_id")
      .notNull()
      .references(() => fighter.id),
    fighterBId: uuid("fighter_b_id")
      .notNull()
      .references(() => fighter.id),

    result: jsonb("result").$type<SimulationResult>().notNull(),

    shareImageUrl: text("share_image_url"),
    isPublic: boolean("is_public").default(true).notNull(),

    viewCount: integer("view_count").default(0).notNull(),
    shareCount: integer("share_count").default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("simulation_user_idx").on(table.userId),
    index("simulation_fighters_idx").on(table.fighterAId, table.fighterBId),
    index("simulation_created_idx").on(table.createdAt),
  ],
);
