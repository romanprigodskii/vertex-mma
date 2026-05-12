import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  // In Wave 1 the schema is empty and no app code calls into the db.
  // We keep the check here so misconfiguration surfaces loudly once data work begins.
  console.warn("DATABASE_URL is not set — Drizzle client will be unusable until it is.");
}

const client = connectionString
  ? postgres(connectionString, { prepare: false })
  : null;

export const db = client ? drizzle(client, { schema }) : null;
export type Database = NonNullable<typeof db>;
