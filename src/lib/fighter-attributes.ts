import type { FighterDetail } from "@/lib/fighter-detail";

export const ATTRIBUTE_KEYS = [
  "striking",
  "grappling",
  "defense",
  "cardio",
  "power",
  "activity",
] as const;

export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];
export type FighterAttributes = Record<AttributeKey, number>;

export const ATTRIBUTE_LABELS: Record<AttributeKey, string> = {
  striking: "Striking",
  grappling: "Grappling",
  defense: "Defense",
  cardio: "Cardio",
  power: "Power",
  activity: "Activity",
};

const clamp = (n: number, lo = 0, hi = 100): number =>
  Math.max(lo, Math.min(hi, n));
const safe = (n: number | null | undefined): number => n ?? 0;

/**
 * Map a fighter's career numbers to six 0–100 attribute scores for the
 * radar.
 *
 * Wave 18.3 rework. Volume-shape metrics — KDs, control, takedowns, sub
 * attempts, KO wins, sub wins, late-round reach, SLpM, SApM, finish
 * losses — now flow through decay-weighted per-bout aggregates with the
 * same curve as Wave 15 quality_wins (1.0 within 1y, linear to 0.3 at
 * 3y, linear to 0.1 at 5y, 0.1 floor). Rate stats UFCStats publishes
 * only as career averages (str_acc, td_acc, td_def, str_def) stay
 * career-averaged — they aren't reconstructible per-bout from the data
 * we scrape.
 *
 * Fallback (??): when a fighter has no decay weight (no completed UFC
 * bouts at all → decayed_total_weight NULL), the formula reads the
 * Wave 18 career column or the legacy career rate so the output stays
 * well-defined.
 *
 * Cardio retains the Wave 18.1 confidence-blend with a neutral 50
 * baseline so R1 finishers (Aspinall) read "we don't know" rather than
 * "bad cardio".
 */
export function computeAttributes(f: FighterDetail): FighterAttributes {
  const totalDf = safe(f.decayed_total_weight);
  const decayedWins = safe(f.decayed_wins_weighted);

  // --- Striking: max of 3 styles (volume / power / technical) ---
  // Wave 19.1: each style scores excellence in one striking approach;
  // fighter reads their best. Volume (Holloway 6+/min landed). Power
  // (Pereira/Topuria/Aspinall — high KD rate + positive stand_diff).
  // Technical (Islam — accuracy + clean stand_diff above Khabib who
  // lacks any stand-up signal). The Wave 19 SLpM→stand_diff fix is
  // preserved inside the power and technical branches; volume reads
  // raw stand-up output (no GnP contamination because we use the
  // position-broken distance-landed column).
  const standLanded = safe(f.decayed_stand_landed_per_min);
  const standDiff = safe(f.decayed_stand_diff_per_min);
  const standLandedScore = clamp((standLanded / 5) * 100);
  const standDiffScore = clamp(50 + (standDiff / 3) * 50);
  const accScore = clamp((safe(f.str_acc) * 100) / 0.55);
  const kdSrc = f.decayed_kd_per_fight ?? safe(f.knockdowns_per_fight);
  const kdScore = clamp((kdSrc / 0.65) * 100);

  const strVolumeStyle = standLandedScore * 0.7 + accScore * 0.3;
  const strPowerStyle = kdScore * 0.6 + standDiffScore * 0.4;
  const strTechnicalStyle = accScore * 0.5 + standDiffScore * 0.5;
  const striking = Math.round(
    Math.max(strVolumeStyle, strPowerStyle, strTechnicalStyle),
  );

  // --- Grappling: max of 3 styles (control / wrestler / submission) ---
  // Wave 19.1: control (Khabib/Islam — top control + GnP volume).
  // Wrestler (Umar — TD volume + accuracy). Submission (Charles —
  // sub threat dominant). Each fighter reads their specialty via max
  // rather than being penalised for one-dimensionality.
  const tdLanded = safe(f.decayed_td_landed_per_fight);
  const tdAttempted = safe(f.decayed_td_attempted_per_fight);
  const tdAvgScore = clamp((tdLanded / 2.5) * 100);
  const tdAccRecent = tdAttempted > 0 ? tdLanded / tdAttempted : safe(f.td_acc);
  const tdAccScore = clamp((tdAccRecent / 0.5) * 100);
  const controlSrc =
    f.decayed_control_per_fight ?? safe(f.control_seconds_avg);
  const controlScore = clamp((controlSrc / 300) * 100);
  const subAttemptScore = clamp(
    (safe(f.decayed_sub_attempts_per_fight) / 1.5) * 100,
  );
  const subWinScore =
    decayedWins > 0
      ? clamp(
          (safe(f.decayed_sub_wins_weighted) / decayedWins) * 100 * (1 / 0.25),
        )
      : 0;
  const subThreat = Math.max(subAttemptScore, subWinScore);

  const grpControlStyle = controlScore * 0.6 + tdAvgScore * 0.4;
  const grpWrestlerStyle = tdAvgScore * 0.6 + tdAccScore * 0.4;
  const grpSubmissionStyle = subThreat * 0.8 + tdAvgScore * 0.2;
  const grappling = Math.round(
    Math.max(grpControlStyle, grpWrestlerStyle, grpSubmissionStyle),
  );

  // --- Defense: max of 3 styles (wrestler / striker / iron-chin) ---
  // Wave 19.1: wrestler_def (Khabib/Islam — top TD def). striker_def
  // (Holloway — head-movement / str def). iron_chin (Aspinall — never
  // finished, low SApM). Each style measures a different durability
  // axis; max() keeps specialists from being averaged into mediocrity.
  const tdDefScore = clamp((safe(f.td_def) * 100) / 0.8);
  const strDefScore = clamp((safe(f.str_def) * 100) / 0.65);
  const sapmSrc = f.decayed_sapm ?? safe(f.sapm);
  const damageScore = clamp(100 - (sapmSrc / 5) * 100);
  const finishLossRate =
    totalDf > 0 ? safe(f.decayed_finish_losses_weighted) / totalDf : 0;
  const durabilityScore = clamp(100 - finishLossRate * 200);

  const defWrestlerStyle = tdDefScore * 0.7 + strDefScore * 0.3;
  const defStrikerStyle = strDefScore * 0.6 + damageScore * 0.4;
  const defIronChinStyle = durabilityScore * 0.8 + damageScore * 0.2;
  const defense = Math.round(
    Math.max(defWrestlerStyle, defStrikerStyle, defIronChinStyle),
  );

  // --- Cardio: decayed late-round reach + Wave 18.1 confidence blend ---
  // A pure R1 finisher (Aspinall: 1 long fight in 10) has no honest
  // cardio signal — confidence drops to 0 and the score blends to a
  // neutral 50 baseline. ≥5 long fights = full confidence in the
  // computed rawCardio. lateFightsCount uses ufc_total against the
  // decayed late-reach rate as a sample-size proxy.
  const lateReachRate = safe(f.decayed_late_reach_rate);
  const lateFightsCount = Math.round(safe(f.ufc_total) * lateReachRate);
  let cardioConfidence: number;
  if (lateFightsCount >= 5) cardioConfidence = 1.0;
  else if (lateFightsCount >= 2) cardioConfidence = lateFightsCount / 5;
  else cardioConfidence = 0;
  const lateReachScore = clamp(lateReachRate * 100);
  const decRate =
    safe(f.ufc_wins) > 0 ? safe(f.ufc_wins_dec) / safe(f.ufc_wins) : 0;
  const decBonus = clamp(decRate * 60);
  const rawCardio = lateReachScore * 0.7 + decBonus * 0.3;
  const cardio = clamp(
    Math.round(rawCardio * cardioConfidence + 50 * (1 - cardioConfidence)),
  );

  // --- Power: decayed KO rate + decayed KD volume ---
  // koRate is decayed KO wins / decayed wins, calibrated to 70% = max.
  // kdScoreP rewards recent knockdowns even when the bout didn't end in
  // a clean KO (Pereira drops opponents often; Topuria's KO finishes
  // top out via decayed_ko_wins_weighted).
  const koRate =
    decayedWins > 0 ? safe(f.decayed_ko_wins_weighted) / decayedWins : 0;
  const koRateScore = clamp((koRate / 0.7) * 100);
  const kdScoreP = clamp((kdSrc / 0.6) * 100);
  const power = Math.round(koRateScore * 0.65 + kdScoreP * 0.35);

  // --- Activity: fights in the last 24 months (already recent) ---
  const activity = clamp(Math.round((safe(f.fights_last_24mo) / 4) * 100));

  return { striking, grappling, defense, cardio, power, activity };
}
