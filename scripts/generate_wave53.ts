/**
 * Generates drizzle/migrations/0074_wave53_alltime_peak_and_weighted_losses.sql
 * from the current view migration (0073).
 *
 * Numbered Wave 53 (not 34): the score-formula thread is at Wave 33, but
 * "Wave 34"-"52" are already taken by the project's feature waves (auth,
 * markets, predictions, …). 53 is the next free wave number.
 *
 * Two changes to the all-time formula (vertex_score_all_time), which had
 * been frozen since Wave 15 while current_score got 7 waves:
 *
 *   A. PEAK. New input peak_career = MAX(vertex_score) from
 *      fighter_score_history (the Wave 31.7 per-bout replay). A legend is
 *      partly judged on how high they climbed, not just career totals.
 *
 *   B. OPP-TIER-WEIGHTED LOSSES. total_loss_penalty was a flat
 *      ufc_losses × 4 — a title-fight loss to a champion cost the same
 *      as a loss to a journeyman. Now each loss costs 4 × severity,
 *      severity = LEAST(1, GREATEST(0.35, 1 - opp_tier/30)): a loss to
 *      an apex opponent ≈ 1.4, a loss to a journeyman ≈ 4.
 *
 * All-time weights rebalanced to keep the positive sum at 1.00:
 *   quality_wins 0.28→0.24, championship_pedigree 0.22→0.20,
 *   era_dominance 0.22→0.18, performance_diff 0.12, finishing 0.16,
 *   peak_career +0.10.
 *
 * Touches the GLOBAL view only — the divisional view has no all-time
 * score and passes through unchanged. GENERATED — three asserted string
 * transforms over 0073; do not hand-edit.
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

function main() {
  const src = readFileSync(
    resolve("drizzle/migrations/0073_wave33_loss_to_top_severity.sql"),
    "utf8",
  );
  let v = body(src);

  // --- T1: weighted all-time loss penalty + peak_career, in `components` ---
  v = replaceOnce(
    v,
    "    LEAST(100, COALESCE(ur.ufc_losses, 0) * 4)::float AS total_loss_penalty,",
    `    -- Wave 53: opp-tier-weighted all-time loss penalty. Each loss
    -- costs 4 × severity, severity = LEAST(1, GREATEST(0.35,
    -- 1 - opp_tier/30)) — a loss to a champion ≈ 1.4, a loss to a
    -- journeyman ≈ 4. Replaces the flat ufc_losses × 4.
    LEAST(100, COALESCE((
      SELECT ROUND(SUM(
        4.0 * LEAST(1.0, GREATEST(0.35,
          1.0 - COALESCE(bot_atl.opp_tier_value, 0)::float / 30.0
        ))
      ))
      FROM bout b_atl
      LEFT JOIN bout_opponent_tier bot_atl
        ON bot_atl.bout_id = b_atl.id AND bot_atl.fighter_id = f.id
      WHERE (b_atl.fighter_a_id = f.id OR b_atl.fighter_b_id = f.id)
        AND b_atl.status = 'completed'
        AND b_atl.winner_id IS NOT NULL
        AND b_atl.winner_id <> f.id
    ), 0))::float AS total_loss_penalty,
    -- Wave 53: career peak — highest replayed vertex_score from
    -- fighter_score_history (Wave 31.7). Feeds the all-time formula.
    COALESCE((
      SELECT MAX(fsh.vertex_score)
      FROM fighter_score_history fsh
      WHERE fsh.fighter_id = f.id
    ), 0)::float AS peak_career,`,
  );

  // --- T2: all-time formula — add peak, rebalance positives to 1.00 ---
  v = replaceOnce(
    v,
    "          quality_wins * 0.28\n" +
      "        + championship_pedigree * 0.22\n" +
      "        + era_dominance_all_time * 0.22\n" +
      "        + performance_diff * 0.12\n" +
      "        + finishing_dominance_score * 0.16\n" +
      "        - total_loss_penalty * 0.10",
    "          quality_wins * 0.24\n" +
      "        + championship_pedigree * 0.20\n" +
      "        + era_dominance_all_time * 0.18\n" +
      "        + performance_diff * 0.12\n" +
      "        + finishing_dominance_score * 0.16\n" +
      "        + peak_career * 0.10\n" +
      "        - total_loss_penalty * 0.10",
  );

  // --- T3: surface peak_career in the final SELECT column list ---
  v = replaceOnce(
    v,
    "  total_loss_penalty,\n  age_years,",
    "  total_loss_penalty,\n  peak_career,\n  age_years,",
  );

  const header = `-- Wave 53: all-time formula — career peak + opp-tier-weighted losses.
--
-- (Numbered 53, not 34 — the score-formula thread is at Wave 33 but
-- waves 34-52 are taken by the project's feature waves. 53 is next free.)
--
-- The all-time score (vertex_score_all_time) had been frozen since
-- Wave 15. Two fixes:
--
--   A. peak_career = MAX(vertex_score) from fighter_score_history (the
--      Wave 31.7 per-bout replay). A legend is partly judged on how high
--      they climbed.
--
--   B. total_loss_penalty was flat ufc_losses × 4 — a title-fight loss
--      to a champion cost as much as a loss to a journeyman. Now each
--      loss costs 4 × severity (0.35-floored opp-tier discount): a loss
--      to an apex opponent ≈ 1.4, to a journeyman ≈ 4.
--
-- All-time positive weights rebalanced to keep their sum at 1.00:
--   quality_wins 0.28→0.24, championship_pedigree 0.22→0.20,
--   era_dominance 0.22→0.18, performance_diff 0.12, finishing 0.16,
--   peak_career +0.10.
--
-- Current-score (vertex_score) is untouched — total_loss_penalty and
-- peak_career feed only the all-time branch. The divisional view has no
-- all-time score; it is recreated identically (no functional change).
--
-- GENERATED by scripts/generate_wave53.ts from 0073 — do not hand-edit.
--
-- Re-materialize after applying:
--   pnpm tsx scripts/materialize_vertex_score.ts

${v}`;

  const out = resolve(
    "drizzle/migrations/0074_wave53_alltime_peak_and_weighted_losses.sql",
  );
  writeFileSync(out, header, "utf8");
  console.log(`Wrote ${out}`);
}

main();
