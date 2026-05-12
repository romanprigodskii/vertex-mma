import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// prepare: false для совместимости с Supabase pooler.
const queryClient = postgres(connectionString, { prepare: false });
export const db = drizzle(queryClient, { schema });

export type Db = typeof db;
