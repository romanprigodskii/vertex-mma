/**
 * Rule-based "what if A vs B" fight predictor. v1. Inputs come from the
 * fighter_vertex_score view + fighter_stats_aggregate + the fighter row
 * itself; output matches the `SimulationResult` JSONB shape from
 * `schema/simulations.ts`.
 *
 * The algorithm is deliberately transparent — every adjustment is a
 * small additive term with a name. A future ML model can ship as v2
 * while keeping the same input/output contract.
 *
 * Limitations of v1: no head-to-head adjustment, no style-rock-paper-
 * scissors beyond the obvious striker-vs-low-td-def case, no camp/age
 * inputs, no historical-bout features beyond aggregates.
 */

import type { SimulationResult } from "@/lib/db/schema/simulations";

export interface SimulatorFighter {
  id: string;
  name_en: string;
  vertex_score: number | null;
  vertex_score_all_time: number | null;
  finishing_dominance_decayed: number | null;
  defensive_vulnerability: number | null;
  recent_form_score: number | null;
  slpm: number | null;
  sapm: number | null;
  str_def: number | null;
  td_def: number | null;
  td_avg: number | null;
  td_acc: number | null;
  sub_avg: number | null;
  height_cm: number | null;
  reach_cm: number | null;
}

const MODEL_VERSION = "v1.0-rule-based";

function num(n: number | null | undefined, fallback: number): number {
  return n == null || !Number.isFinite(n) ? fallback : n;
}

function sigmoid(x: number, scale: number): number {
  return 1 / (1 + Math.exp(-x / scale));
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

const ROUND_PCT_1 = 1 / 1000; // one decimal place in percent

function round1(v: number): number {
  return Math.round(v * 1000) * ROUND_PCT_1;
}

export function simulate(
  a: SimulatorFighter,
  b: SimulatorFighter,
): SimulationResult {
  // Score: prefer current vertex_score; fall back to all-time so retired
  // legends still produce a sensible probability instead of defaulting
  // halfway down.
  const vertexA = num(a.vertex_score ?? a.vertex_score_all_time, 50);
  const vertexB = num(b.vertex_score ?? b.vertex_score_all_time, 50);

  // 1. Base win probability — sigmoid on score differential.
  let pA = sigmoid(vertexA - vertexB, 8);

  // 2. Style matchup. Classify each side and apply targeted adjustments
  //    when the opposite side has a hole in the corresponding defence.
  const slpmA = num(a.slpm, 3);
  const slpmB = num(b.slpm, 3);
  const tdAvgA = num(a.td_avg, 0.5);
  const tdAvgB = num(b.td_avg, 0.5);
  const aIsStriker = slpmA > 3.5 && tdAvgA < 1.5;
  const bIsStriker = slpmB > 3.5 && tdAvgB < 1.5;
  const aIsWrestler = tdAvgA > 2 && slpmA < 4;
  const bIsWrestler = tdAvgB > 2 && slpmB < 4;

  if (aIsStriker && num(b.td_def, 0.5) < 0.5) pA += 0.05;
  if (bIsStriker && num(a.td_def, 0.5) < 0.5) pA -= 0.05;
  if (aIsWrestler && num(b.str_def, 0.5) < 0.5) pA += 0.05;
  if (bIsWrestler && num(a.str_def, 0.5) < 0.5) pA -= 0.05;

  // 3. Defensive vulnerability gap (0..100; lower is better).
  //    20-pt diff → ~10pp shift.
  const dvA = num(a.defensive_vulnerability, 20);
  const dvB = num(b.defensive_vulnerability, 20);
  pA += (dvB - dvA) / 200;

  // 4. Recent form (0..100). 20-pt diff → ~10pp shift.
  const formA = num(a.recent_form_score, 50);
  const formB = num(b.recent_form_score, 50);
  pA += (formA - formB) / 200;

  pA = clamp(pA, 0.05, 0.95);
  const pB = 1 - pA;

  // 5. Method distribution — anchored on the predicted winner's profile.
  const winner = pA >= pB ? a : b;
  const loser = pA >= pB ? b : a;
  const winnerFinish = num(winner.finishing_dominance_decayed, 30) / 100;
  const winnerSlpm = num(winner.slpm, 3);
  const winnerTd = num(winner.td_avg, 0.5);
  const winnerSub = num(winner.sub_avg, 0);
  const strikeFocus = winnerSlpm / Math.max(winnerTd + 0.5, 0.5);

  let kotkoPct: number;
  let subPct: number;
  let decPct: number;

  if (winnerFinish < 0.3) {
    // Volume / decision finisher.
    kotkoPct = 0.2;
    subPct = 0.1;
    decPct = 0.7;
  } else if (strikeFocus > 2.5) {
    // Striker.
    kotkoPct = 0.5 * winnerFinish + 0.15;
    subPct = 0.05;
    decPct = 1 - kotkoPct - subPct;
  } else if (winnerSub > 0.5 || winnerTd > 2) {
    // Submission grappler / wrestler.
    kotkoPct = 0.1;
    subPct = 0.45 * winnerFinish + 0.1;
    decPct = 1 - kotkoPct - subPct;
  } else {
    // Mixed.
    kotkoPct = 0.25 * winnerFinish + 0.1;
    subPct = 0.15 * winnerFinish + 0.05;
    decPct = 1 - kotkoPct - subPct;
  }

  // Adjust for opponent defensive holes.
  if (num(loser.str_def, 0.5) < 0.5) {
    kotkoPct += 0.05;
    decPct -= 0.05;
  }
  if (num(loser.td_def, 0.5) < 0.4) {
    subPct += 0.05;
    decPct -= 0.05;
  }

  // Normalise (clamp first so individual terms don't go negative).
  kotkoPct = Math.max(0, kotkoPct);
  subPct = Math.max(0, subPct);
  decPct = Math.max(0, decPct);
  const methodSum = kotkoPct + subPct + decPct;
  kotkoPct /= methodSum;
  subPct /= methodSum;
  decPct /= methodSum;

  // 6. Round distribution (3-round default). Finish mass is split into
  //    earlier rounds for high-finishing winners and later rounds
  //    otherwise.
  const finishPct = 1 - decPct;
  const r1Share = 0.4 * winnerFinish + 0.2; // 0.2..0.6
  const r2Share = 0.35;
  const r3Share = Math.max(0, 1 - r1Share - r2Share);
  const r1Pct = finishPct * r1Share;
  const r2Pct = finishPct * r2Share;
  const r3Pct = finishPct * r3Share;

  // 7. Most-likely scenario string.
  const winnerName = winner.name_en;
  let method: "KO/TKO" | "Submission" | "Decision";
  if (kotkoPct >= subPct && kotkoPct >= decPct) method = "KO/TKO";
  else if (subPct >= decPct) method = "Submission";
  else method = "Decision";

  let roundLabel: string;
  if (method === "Decision") {
    roundLabel = "by decision";
  } else {
    const maxR = Math.max(r1Pct, r2Pct, r3Pct);
    const rN = maxR === r1Pct ? 1 : maxR === r2Pct ? 2 : 3;
    roundLabel = `by ${method} in R${rN}`;
  }
  const mostLikelyScenario = `${winnerName} wins ${roundLabel}`;

  // 8. Key factors (top 5 by |delta|).
  const factors: Array<{ label: string; delta: number }> = [
    { label: "Vertex score", delta: round1(vertexA - vertexB) },
    { label: "Striking output (SLpM)", delta: round1(slpmA - slpmB) },
    { label: "Takedown volume", delta: round1(tdAvgA - tdAvgB) },
    { label: "Recent form", delta: Math.round(formA - formB) },
    {
      label: "Defensive holes (B − A)",
      delta: Math.round(dvB - dvA),
    },
    {
      label: "Finishing rate",
      delta: Math.round(
        num(a.finishing_dominance_decayed, 0) -
          num(b.finishing_dominance_decayed, 0),
      ),
    },
    { label: "Reach", delta: round1(num(a.reach_cm, 0) - num(b.reach_cm, 0)) },
  ];
  const topFactors = factors
    .filter((f) => Math.abs(f.delta) > 0.1)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
    .slice(0, 5);

  return {
    winProbabilityA: round1(pA * 100),
    winProbabilityB: round1(pB * 100),
    methodDistribution: {
      ko_tko: round1(kotkoPct * 100),
      submission: round1(subPct * 100),
      decision: round1(decPct * 100),
    },
    roundDistribution: {
      r1: round1(r1Pct * 100),
      r2: round1(r2Pct * 100),
      r3: round1(r3Pct * 100),
      decision: round1(decPct * 100),
    },
    mostLikelyScenario,
    keyFactors: topFactors,
    modelVersion: MODEL_VERSION,
  };
}
