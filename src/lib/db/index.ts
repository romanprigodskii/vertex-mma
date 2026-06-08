import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { install as installDnsFallback } from "@/lib/dns-fallback";
import { serverEnv } from "@/lib/env";

import * as schema from "./schema";

// Defensive DNS fallback — the host's primary resolver intermittently times
// out resolving the Supabase pooler hostname (documented in Wave 2.5 / 3B.1.2).
// Patch dns.lookup BEFORE postgres-js opens a socket. No-op on healthy hosts.
installDnsFallback();

// Validated at boot — throws a clear "Missing required environment variable"
// instead of a cryptic connection error at request time.
const connectionString = serverEnv().DATABASE_URL;

// prepare: false для совместимости с Supabase pooler. max + idle_timeout
// keep us under the session-pooler 15-slot cap when Turbopack HMR
// creates fresh module instances (each leaks its old pool until GC),
// and when several scripts run concurrently against the same project.
//
// max is env-driven (DB_POOL_MAX): force-dynamic pages fan out ~8 queries per
// hit, so a hardcoded 3-slot pool queues requests and inflates p95 under load.
// Dev keeps the safe default of 3; prod single-instance should set 8-10 — never
// letting the sum across instances exceed the session-pooler's 15 slots.
const DB_POOL_MAX = (() => {
  const parsed = Number.parseInt(process.env.DB_POOL_MAX ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
})();

const queryClient = postgres(connectionString, {
  prepare: false,
  max: DB_POOL_MAX,
  idle_timeout: 20,
});
export const db = drizzle(queryClient, { schema });

export type Db = typeof db;
