/**
 * Rebuild the fighter_vertex_score snapshot the site reads.
 *
 * Wave 62 (drizzle/migrations/0095_fighter_vertex_score_matview.sql) split the
 * rating surface in two: the 559-line definition lives in the plain view
 * `fighter_vertex_score_live`, and `fighter_vertex_score` — the name the app
 * queries — is a MATERIALIZED VIEW over it. A profile read is then a
 * unique-index lookup instead of a roster-wide recompute (measured before the
 * split: 938 ms mean per single-fighter call, 107 s for one full pass).
 *
 *   pnpm tsx scripts/refresh_vertex_score_matview.ts
 *
 * The recompute chain calls this immediately before materialize_vertex_score,
 * so the fighter columns are copied from the same snapshot the site serves and
 * the two can never disagree. The view body calls now() 18 times (layoff, decay,
 * activity windows), which is why this has to run daily rather than only after
 * a scrape.
 *
 * Idempotent and self-healing — it reconciles whatever state it finds:
 *   - matview, columns match the live view  → REFRESH ... CONCURRENTLY
 *     (needs the unique index; never blocks readers)
 *   - matview, columns drifted              → DROP + rebuild, because
 *     `SELECT *` freezes the column list at CREATE time and a wave that adds a
 *     column to the live view would otherwise never reach the site
 *   - still a plain view                    → apply the Wave 62 split itself,
 *     so a wave script that recreated it under the old name self-heals on the
 *     next nightly run instead of silently restoring the O(roster) read
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { prepare: false });

const MATVIEW = "fighter_vertex_score";
const LIVE = "fighter_vertex_score_live";

async function relkind(name: string): Promise<string | null> {
  const rows = await sql<{ k: string }[]>`
    SELECT c.relkind::text AS k
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ${name}
  `;
  return rows[0]?.k ?? null;
}

/**
 * Ordered "name:type" signature, so an added/renamed/retyped column shows up.
 *
 * Reads pg_attribute, NOT information_schema.columns: the latter has no rows at
 * all for a materialized view, so comparing through it reports an empty
 * signature for the matview, calls that drift against the live view, and
 * rebuilds from scratch on every single run — a full roster-wide pass nightly
 * in place of a cheap refresh. Verified on prod: information_schema returns 49
 * columns for the view and 0 for the matview, while pg_attribute returns the
 * same 49 for both.
 */
async function signature(name: string): Promise<string> {
  const rows = await sql<{ sig: string }[]>`
    SELECT a.attname || ':' || format_type(a.atttypid, a.atttypmod) AS sig
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relname = ${name}
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attnum
  `;
  if (rows.length === 0) throw new Error(`${name} exposes no columns`);
  return rows.map((r) => r.sig).join(",");
}

/** Create the matview over the live view + the index and grants it needs. */
async function build() {
  await sql.unsafe(
    `CREATE MATERIALIZED VIEW ${MATVIEW} AS SELECT * FROM ${LIVE}`,
  );
  // Unique index does double duty: it turns `WHERE id = $1` into an index
  // lookup, and REFRESH ... CONCURRENTLY refuses to run without one.
  await sql.unsafe(
    `CREATE UNIQUE INDEX ${MATVIEW}_id_uidx ON ${MATVIEW} (id)`,
  );
  // Mirror the grants the plain view carried (Supabase GRANT ALL to the API
  // roles); a freshly created relation starts owner-only.
  await sql.unsafe(
    `GRANT ALL ON ${MATVIEW} TO anon, authenticated, service_role`,
  );
  await sql.unsafe(`ANALYZE ${MATVIEW}`);
}

async function main() {
  // A full pass of the view runs well past the 2 min role default.
  await sql.unsafe(`SET statement_timeout = 0`);

  const kind = await relkind(MATVIEW);
  if (kind === null) throw new Error(`${MATVIEW} does not exist`);

  if (kind === "v") {
    // Pre-Wave-62 shape, or a wave script recreated the plain view under this
    // name. Apply the split: the definition moves to _live, the read surface
    // becomes the matview. Dropping any stale _live first keeps this re-runnable.
    console.log(`${MATVIEW} is a plain VIEW — applying the Wave 62 split.`);
    await sql.unsafe(`DROP VIEW IF EXISTS ${LIVE} CASCADE`);
    await sql.unsafe(`ALTER VIEW ${MATVIEW} RENAME TO ${LIVE}`);
    await build();
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM fighter_vertex_score
    `;
    console.log(`OK: split applied — ${MATVIEW} is now a matview (${n} rows).`);
    await sql.end();
    return;
  }

  if (kind !== "m") {
    throw new Error(`${MATVIEW} has unexpected relkind '${kind}'`);
  }

  if ((await relkind(LIVE)) !== "v") {
    throw new Error(`${LIVE} is missing — cannot refresh ${MATVIEW} without it`);
  }

  const [matSig, liveSig] = await Promise.all([
    signature(MATVIEW),
    signature(LIVE),
  ]);

  if (matSig !== liveSig) {
    // REFRESH only replaces data, never the column list, so a drifted matview
    // would keep serving the old shape forever. Rebuild instead.
    console.log("Column drift vs the live view — rebuilding the matview.");
    await sql.unsafe(`DROP MATERIALIZED VIEW ${MATVIEW}`);
    await build();
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM fighter_vertex_score
    `;
    console.log(`OK: rebuilt ${MATVIEW} on the current column list (${n} rows).`);
    await sql.end();
    return;
  }

  const started = Date.now();
  await sql.unsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${MATVIEW}`);
  await sql.unsafe(`ANALYZE ${MATVIEW}`);
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM fighter_vertex_score
  `;
  console.log(
    `OK: refreshed ${MATVIEW} (${n} rows) in ${Math.round((Date.now() - started) / 1000)}s.`,
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
