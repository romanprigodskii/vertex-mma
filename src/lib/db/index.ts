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

// prepare: false для совместимости с Supabase pooler.
//
// Worth knowing before anyone tries to "fix" that for plan reuse: this flag is
// inert here either way. Drizzle's postgres-js driver sends every statement
// through `client.unsafe(query, params)` (drizzle-orm 0.45.2), and postgres.js
// hardcodes `prepare: false` inside unsafe() (3.4.9, src/index.js:122) unless
// the caller passes an override — which Drizzle never does. So nothing Drizzle
// issues is ever a named prepared statement, and every statement is parsed and
// planned afresh. That is not free: during the 2026-09-04 incident, planning
// the profile round-stats query cost 497 ms against 184 ms to execute it, while
// the same statement issued through PREPARE/EXECUTE settled at ~45 ms. Reaching
// that would mean sending the hot reads through the postgres.js tagged template
// instead of db.execute, not flipping this flag.
//
// max + idle_timeout keep us under the session-pooler 15-slot cap when
// Turbopack HMR creates fresh module instances (each leaks its old pool until
// GC), and when several scripts run concurrently against the same project.
// That hazard is a development one, so the tight idle window stays in
// development: in production this process is the only long-lived consumer,
// traffic is sparse, and a 20 s window had almost every visit re-establishing
// its connections — Supavisor's auth handshake measured ~1.3 s apiece.
const queryClient = postgres(connectionString, {
  prepare: false,
  max: 3,
  idle_timeout: process.env.NODE_ENV === "production" ? 300 : 20,
});
export const db = drizzle(queryClient, { schema });

export type Db = typeof db;
