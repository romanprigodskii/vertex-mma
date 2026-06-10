/**
 * Generates drizzle/migrations/0088_wave60_era_current_rescale.sql from
 * the current view migration (0076).
 *
 * Wave 60 — era_dominance_current rescaled to 0-100 parity + curated
 * title-fight source. Two problems, one component:
 *
 * 1. SCALE. The component was the lone 0-10-scale input in the current
 *    formula (title fight in 24mo → +5, ≥2 title fights in 36mo → +5,
 *    cap 10), so at weight 0.06 its maximum contribution was 0.6 raw
 *    points — cosmetic next to quality_wins (max 16) or recent_form
 *    (max 18). Same signal, ×10 scale: 50/50, cap 100. The 0.06 weight
 *    is unchanged, so the component now contributes up to 6.0 raw
 *    points. Positive-weight max raw becomes 88 (+5 streak) — exactly
 *    the Wave 31 curve's "100 reserved for raw ≥ 88" design intent.
 *
 * 2. SOURCE. The CTEs counted bout.is_title_fight, which the UFCStats
 *    scrape over-flags (bonus icons share the belt's cell — whole
 *    main-card slates get marked; 460 "title bouts" in 36 months vs 57
 *    real ones). Negligible at max 0.6 points, NOT negligible at 6.0.
 *    The views now read a new title_fight_bout table mirroring the
 *    curated src/lib/title-fights.ts set (hand-verified championship
 *    history) — the same source era_dominance_all_time already uses.
 *    The table is created + seeded by this migration and kept in sync
 *    by scripts/derive_title_fights.ts.
 *
 * The history replay (scripts/compute_score_history.ts) gets the
 * matching ×10 and the curated source in the same commit.
 *
 * GENERATED — asserted string transforms over 0076 + the curated ID
 * list read from src/lib/title-fights.ts. Do not hand-edit the output.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function replaceN(
  haystack: string,
  needle: string,
  repl: string,
  expected: number,
): string {
  const n = haystack.split(needle).length - 1;
  if (n !== expected) {
    throw new Error(
      `Expected exactly ${expected} occurrences of anchor, found ${n}:\n${needle}`,
    );
  }
  return haystack.split(needle).join(repl);
}

function body(sql: string): string {
  const i = sql.indexOf("DROP VIEW");
  if (i < 0) throw new Error("DROP VIEW not found");
  return sql.slice(i);
}

/** Curated title-fight bout IDs out of the generated title-fights.ts. */
function curatedIds(): string[] {
  const src = readFileSync(resolve("src/lib/title-fights.ts"), "utf8");
  const ids = [
    ...src.matchAll(
      /^ {2}"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",/gm,
    ),
  ].map((m) => m[1]);
  if (ids.length < 100) {
    throw new Error(
      `Only ${ids.length} curated title-fight IDs found — parse drift?`,
    );
  }
  return ids;
}

// --- T1: era_dominance_current 0-10 → 0-100 (both views) ---
const ERA_OLD = `    LEAST(10,
      (CASE WHEN COALESCE(rtfc.tf_24mo, 0) >= 1 THEN 5 ELSE 0 END)
    + (CASE WHEN COALESCE(rtfc.tf_36mo, 0) >= 2 THEN 5 ELSE 0 END)
    )::float AS era_dominance_current,`;

const ERA_NEW = `    -- Wave 60: 0-100 parity (was 0-10). Title fight in 24mo → 50,
    -- ≥2 title fights in 36mo → +50. Same signal, ×10 scale — at the
    -- unchanged 0.06 weight the component now contributes up to 6.0
    -- raw points (was 0.6), in line with its 0-100-scale neighbours.
    LEAST(100,
      (CASE WHEN COALESCE(rtfc.tf_24mo, 0) >= 1 THEN 50 ELSE 0 END)
    + (CASE WHEN COALESCE(rtfc.tf_36mo, 0) >= 2 THEN 50 ELSE 0 END)
    )::float AS era_dominance_current,`;

// --- T2: global CTE — curated table instead of the scraped flag ---
const GLOBAL_JOIN_OLD = `  LEFT JOIN bout b
    ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
    AND b.is_title_fight = TRUE
    AND b.status = 'completed'`;

const GLOBAL_JOIN_NEW = `  -- Wave 60: curated title fights (title_fight_bout) — the scraped
  -- is_title_fight flag over-counts (bonus icons share the belt cell).
  LEFT JOIN bout b
    ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
    AND b.status = 'completed'
    AND EXISTS (SELECT 1 FROM title_fight_bout tfb WHERE tfb.bout_id = b.id)`;

// --- T3: divisional CTE — same swap ---
const DIV_WHERE_OLD = `  WHERE b.status = 'completed' AND b.is_title_fight = TRUE`;

const DIV_WHERE_NEW = `  -- Wave 60: curated title fights (title_fight_bout) — the scraped
  -- is_title_fight flag over-counts (bonus icons share the belt cell).
  WHERE b.status = 'completed'
    AND EXISTS (SELECT 1 FROM title_fight_bout tfb WHERE tfb.bout_id = b.id)`;

function main() {
  const src = readFileSync(
    resolve("drizzle/migrations/0076_wave55_scorecard_dominance.sql"),
    "utf8",
  );
  let v = body(src);

  v = replaceN(v, ERA_OLD, ERA_NEW, 2);
  v = replaceN(v, GLOBAL_JOIN_OLD, GLOBAL_JOIN_NEW, 1);
  v = replaceN(v, DIV_WHERE_OLD, DIV_WHERE_NEW, 1);

  const ids = curatedIds();
  const idList = ids.map((id) => `  ('${id}')`).join(",\n");

  const tableDdl = `-- Curated title-fight bout IDs (mirrors src/lib/title-fights.ts).
-- Synced by scripts/derive_title_fights.ts on every re-derive; the
-- INSERT ... JOIN below only seeds rows whose bout still exists.
CREATE TABLE IF NOT EXISTS title_fight_bout (
  bout_id uuid PRIMARY KEY REFERENCES bout(id) ON DELETE CASCADE
);

DELETE FROM title_fight_bout;

INSERT INTO title_fight_bout (bout_id)
SELECT b.id
FROM bout b
JOIN (VALUES
${idList}
) AS curated(bout_id) ON b.id = curated.bout_id::uuid
ON CONFLICT (bout_id) DO NOTHING;

`;

  const header = `-- Wave 60: era_dominance_current rescaled to 0-100 parity, sourced
-- from curated title fights.
--
-- The component was the lone 0-10-scale input in the current formula
-- (title fight in 24mo → +5, ≥2 title fights in 36mo → +5, cap 10), so
-- at weight 0.06 its maximum contribution was 0.6 raw points. Same
-- signal, ×10 scale (50/50, cap 100): the unchanged 0.06 weight now
-- contributes up to 6.0 raw points.
--
-- The title-fight source moves from the scraped bout.is_title_fight
-- (over-flagged: UFCStats puts bonus icons in the belt's cell, so whole
-- main-card slates get marked — 460 "title bouts" in 36mo vs 57 real)
-- to the new title_fight_bout table, seeded here from the curated
-- src/lib/title-fights.ts and kept in sync by
-- scripts/derive_title_fights.ts. The boost therefore lands only on
-- actual champions and recent title challengers.
--
-- Applied to BOTH views (global + divisional). The history replay
-- (scripts/compute_score_history.ts) gets the matching changes in the
-- same commit.
--
-- GENERATED by scripts/generate_wave60.ts from 0076 — do not hand-edit.
--
-- Re-materialize after applying:
--   pnpm tsx scripts/materialize_vertex_score.ts
--   pnpm tsx scripts/materialize_divisional_score.ts

${tableDdl}${v}`;

  const out = resolve(
    "drizzle/migrations/0088_wave60_era_current_rescale.sql",
  );
  writeFileSync(out, header, "utf8");
  console.log(
    `Wrote ${out} (${ids.length} curated title-fight IDs seeded).`,
  );
}

main();
