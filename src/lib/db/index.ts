import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { install as installDnsFallback } from "@/lib/dns-fallback";

import * as schema from "./schema";

// Defensive DNS fallback — the host's primary resolver intermittently times
// out resolving the Supabase pooler hostname (documented in Wave 2.5 / 3B.1.2).
// Patch dns.lookup BEFORE postgres-js opens a socket. No-op on healthy hosts.
installDnsFallback();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// prepare: false для совместимости с Supabase pooler. max + idle_timeout
// keep us under the session-pooler 15-slot cap when Turbopack HMR
// creates fresh module instances (each leaks its old pool until GC),
// and when several scripts run concurrently against the same project.
const queryClient = postgres(connectionString, {
  prepare: false,
  max: 3,
  idle_timeout: 20,
});
export const db = drizzle(queryClient, { schema });

export type Db = typeof db;
