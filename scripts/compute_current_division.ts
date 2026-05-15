/**
 * Wave 7A: populates fighter.current_division from the weight class of
 * each fighter's most recent completed UFC bout. Falls back to
 * fighter.weight_class_primary when no completed bouts exist (cut
 * prospects, signed-but-unfought).
 *
 * Idempotent: re-running overwrites every row from scratch. The catalog
 * filter in src/lib/fighter-search.ts uses
 *   COALESCE(current_division, weight_class_primary)
 * so a NULL current_division for fighters with no bouts is fine and
 * preserves the legacy behavior for them.
 *
 * Run after any bulk bout import (or single-event update) so division
 * switches like Topuria FW→LW and Islam LW→WW show up in /fighters.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

async function main() {
  console.log("Computing current_division from last completed bout...");

  // Single batched UPDATE: for each fighter, find their latest completed
  // bout's weight_class and set current_division. Fighters with no
  // completed bouts get NULL (fallback path uses weight_class_primary).
  const rows = await sql<{ updated: number }[]>`
    WITH last_bout AS (
      SELECT DISTINCT ON (fighter_id)
        fighter_id,
        b.weight_class::text AS wc
      FROM (
        SELECT fighter_a_id AS fighter_id, id AS bout_id
        FROM bout WHERE status = 'completed'
        UNION ALL
        SELECT fighter_b_id AS fighter_id, id AS bout_id
        FROM bout WHERE status = 'completed'
      ) bf
      JOIN bout b ON b.id = bf.bout_id
      JOIN event e ON e.id = b.event_id
      ORDER BY fighter_id, e.date DESC, b.id DESC
    )
    UPDATE fighter f
    SET current_division = lb.wc
    FROM last_bout lb
    WHERE lb.fighter_id = f.id
    RETURNING 1 AS updated
  `;
  console.log(`Set current_division for ${rows.length} fighters.`);

  // Zero out current_division for fighters with no completed bouts —
  // ensures idempotency if a fighter's bouts get removed.
  const cleared = await sql`
    UPDATE fighter f
    SET current_division = NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM bout b
      WHERE (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
        AND b.status = 'completed'
    )
    AND f.current_division IS NOT NULL
    RETURNING 1
  `;
  if (cleared.length > 0) {
    console.log(`Cleared current_division for ${cleared.length} fighters with no completed bouts.`);
  }

  // Quick sanity audit — fighters whose current_division != weight_class_primary
  const shifts = await sql<
    Array<{ legacy: string | null; current: string | null; n: number }>
  >`
    SELECT weight_class_primary::text AS legacy,
           current_division AS current,
           COUNT(*)::int AS n
    FROM fighter
    WHERE current_division IS NOT NULL
      AND current_division <> weight_class_primary::text
    GROUP BY weight_class_primary, current_division
    ORDER BY n DESC
  `;
  console.log("\nDivision shifts (current_division != weight_class_primary):");
  console.log("  legacy               → current               count");
  console.log("  " + "-".repeat(55));
  for (const r of shifts) {
    console.log(
      `  ${(r.legacy ?? "—").padEnd(20)} → ${(r.current ?? "—").padEnd(20)} ${String(r.n).padStart(4)}`,
    );
  }

  // Spot-check the high-profile movers
  const anchors = await sql<
    Array<{ name_en: string; legacy: string | null; current: string | null }>
  >`
    SELECT name_en,
           weight_class_primary::text AS legacy,
           current_division AS current
    FROM fighter
    WHERE slug IN (
      'ilia-topuria-54f64b',
      'islam-makhachev-275aca',
      'alex-pereira-e5549c',
      'jack-della-maddalena-6b453b',
      'conor-mcgregor-f4c499',
      'henry-cejudo-056c49',
      'amanda-nunes-80fa82',
      'bj-penn-73c7cf',
      'georges-st-pierre-6506c1'
    )
    ORDER BY name_en
  `;
  console.log("\nAnchor fighters:");
  for (const r of anchors) {
    const same = r.legacy === r.current ? " (same)" : "";
    console.log(
      `  ${r.name_en.padEnd(28)} legacy=${(r.legacy ?? "—").padEnd(20)} current=${r.current ?? "—"}${same}`,
    );
  }

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
