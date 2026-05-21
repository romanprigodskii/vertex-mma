/**
 * Generates drizzle/migrations/0076_wave55_scorecard_dominance.sql from
 * the current view migration (0075).
 *
 * Wave 55 — win-quality modifier on recent_form. A win was worth
 * +opp_tier_value flat: a 50-45 shutout and a 29-28 split counted the
 * same. Now the win contribution is opp_tier_value × win_quality:
 *
 *   finish (KO/TKO/Sub)        → 1.15  (a finish is maximal dominance)
 *   decision, by margin        → 0.90 (razor split) .. 1.10 (blowout)
 *   decision with no scorecard → 1.00  (neutral — ~19% of decisions,
 *                                       mostly pre-2006, have no
 *                                       mmadecisions.com scorecard)
 *
 * Style-neutral by design — a scorecard margin doesn't care whether the
 * rounds were won striking or grappling. The style-aware axis stays in
 * performance_diff (Wave 22 max+balance). No new top-level weight: this
 * is a modifier inside the existing recent_form component.
 *
 * New CTE scorecard_margin (bout_id, fighter_id, margin_per_round) is
 * career-wide and inserted into BOTH views. The win-line of recent_form
 * (global) and recent_form_div_contributions (divisional) gets the
 * modifier — losses are unchanged.
 *
 * GENERATED — six asserted string transforms over 0075. Do not hand-edit.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function replaceOnce(haystack: string, needle: string, repl: string): string {
  const n = haystack.split(needle).length - 1;
  if (n !== 1) {
    throw new Error(
      `Expected exactly 1 occurrence of anchor, found ${n}:\n${needle}`,
    );
  }
  return haystack.replace(needle, repl);
}

function body(sql: string): string {
  const i = sql.indexOf("DROP VIEW");
  if (i < 0) throw new Error("DROP VIEW not found");
  return sql.slice(i);
}

// Career-wide scorecard margin per (bout, fighter): average judge total
// divided by round count → margin per round. Identical in both views.
const SCORECARD_CTE = `-- Wave 55: scorecard margin per (bout, fighter). SUM over every
-- (judge, round) cell, ÷ judges ÷ rounds = margin per round. A 30-27
-- sweep or a 50-45 = 1.0/round; a 10-8 round lifts it; a split dips
-- toward 0. ~81% of decision bouts have mmadecisions.com scorecards.
scorecard_margin AS (
  SELECT
    sc.bout_id,
    side.fighter_id,
    (
      SUM(
        CASE WHEN side.is_a
          THEN sc.fighter_a_score - sc.fighter_b_score
          ELSE sc.fighter_b_score - sc.fighter_a_score
        END
      )::float
      / NULLIF(COUNT(DISTINCT sc.judge_name), 0)
      / NULLIF(COUNT(DISTINCT sc.round), 0)
    ) AS margin_per_round
  FROM bout_scorecard sc
  JOIN bout b ON b.id = sc.bout_id
  CROSS JOIN LATERAL (VALUES
    (b.fighter_a_id, TRUE),
    (b.fighter_b_id, FALSE)
  ) AS side(fighter_id, is_a)
  GROUP BY sc.bout_id, side.fighter_id, side.is_a
),
`;

/** The win-quality multiplier expression, indented to `pad` spaces. */
function winQuality(pad: string): string {
  return (
    `rbw.opp_tier_value::float * (\n` +
    `${pad}  -- Wave 55: win-quality — finish 1.15; decision scaled\n` +
    `${pad}  -- 0.90 (razor split) .. 1.10 (blowout) by scorecard\n` +
    `${pad}  -- margin/round; decision with no scorecard → 1.00.\n` +
    `${pad}  CASE\n` +
    `${pad}    WHEN LOWER(COALESCE(rbw.method, '')) LIKE 'ko%'\n` +
    `${pad}      OR LOWER(COALESCE(rbw.method, '')) LIKE 'tko%'\n` +
    `${pad}      OR LOWER(COALESCE(rbw.method, '')) LIKE 'sub%' THEN 1.15\n` +
    `${pad}    WHEN sm.margin_per_round IS NULL THEN 1.00\n` +
    `${pad}    ELSE 0.90 + 0.10 * LEAST(2.0, GREATEST(0.0, sm.margin_per_round))\n` +
    `${pad}  END\n` +
    `${pad})`
  );
}

function main() {
  const src = readFileSync(
    resolve("drizzle/migrations/0075_wave54_credibility_factor.sql"),
    "utf8",
  );
  let v = body(src);

  // --- T1a/T1b: insert scorecard_margin CTE into both views' WITH lists ---
  v = replaceOnce(v, "recent_form AS (", SCORECARD_CTE + "recent_form AS (");
  v = replaceOnce(
    v,
    "recent_form_div_contributions AS (",
    SCORECARD_CTE + "recent_form_div_contributions AS (",
  );

  // --- T2a/T2b: join scorecard_margin into the two contribution CTEs ---
  v = replaceOnce(
    v,
    "    FROM recent_bouts_window rbw\n    WHERE rbw.recency_rank <= 5",
    "    FROM recent_bouts_window rbw\n" +
      "    LEFT JOIN scorecard_margin sm\n" +
      "      ON sm.bout_id = rbw.bout_id AND sm.fighter_id = rbw.fighter_id\n" +
      "    WHERE rbw.recency_rank <= 5",
  );
  v = replaceOnce(
    v,
    "  FROM recent_bouts_window_div rbw\n  WHERE rbw.recency_rank <= 5",
    "  FROM recent_bouts_window_div rbw\n" +
      "  LEFT JOIN scorecard_margin sm\n" +
      "    ON sm.bout_id = rbw.bout_id AND sm.fighter_id = rbw.fighter_id\n" +
      "  WHERE rbw.recency_rank <= 5",
  );

  // --- T3a/T3b: apply win_quality to the win contribution ---
  v = replaceOnce(
    v,
    "        WHEN rbw.is_win THEN rbw.opp_tier_value::float\n        ELSE",
    "        WHEN rbw.is_win THEN " + winQuality("        ") + "\n        ELSE",
  );
  v = replaceOnce(
    v,
    "      WHEN rbw.is_win THEN rbw.opp_tier_value::float\n      ELSE",
    "      WHEN rbw.is_win THEN " + winQuality("      ") + "\n      ELSE",
  );

  const header = `-- Wave 55: scorecard dominance — win-quality modifier on recent_form.
--
-- A win counted +opp_tier_value flat — a 50-45 shutout and a 29-28
-- split were identical. Now the win contribution to recent_form is
-- opp_tier_value × win_quality:
--
--   finish (KO/TKO/Sub)        → 1.15
--   decision, by margin        → 0.90 (razor split) .. 1.10 (blowout)
--   decision with no scorecard → 1.00 (neutral)
--
-- Margin comes from a new scorecard_margin CTE over bout_scorecard
-- (mmadecisions.com judge cards; ~81% of decisions covered — the rest,
-- mostly pre-2006, fall back to the neutral 1.00).
--
-- Style-neutral by design — the style-aware axis stays in
-- performance_diff (Wave 22). No new top-level weight; this is a
-- modifier inside the existing recent_form component, applied to both
-- the global and divisional views. Losses are unchanged.
--
-- GENERATED by scripts/generate_wave55.ts from 0075 — do not hand-edit.
--
-- Re-materialize after applying:
--   pnpm tsx scripts/materialize_vertex_score.ts
--   pnpm tsx scripts/materialize_divisional_score.ts

${v}`;

  const out = resolve(
    "drizzle/migrations/0076_wave55_scorecard_dominance.sql",
  );
  writeFileSync(out, header, "utf8");
  console.log(`Wrote ${out}`);
}

main();
