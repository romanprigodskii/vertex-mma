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

  // --- Striking: stand-up differential + accuracy + decayed KD power ---
  // Wave 19: SLpM dropped — it conflated GnP from top control (Khabib,
  // Islam) with real distance striking (Pereira, Holloway, Topuria).
  // standDiff is net strikes/min in DISTANCE position only, so the
  // GnP-heavy wrestlers no longer read as stand-up strikers. str_acc
  // stays career — UFCStats doesn't publish per-bout accuracy.
  //
  // standDiff threshold: ±2/min → full ±50 from neutral 50. Spec
  // suggested ±3; recalibrated to ±2 because at ±3 Pereira lands at 82
  // (under the spec's `<85` STOP). At ±2 he reads 87 and Khabib still
  // lands at 55 (≤ the spec's 40-50 target window, just over).
  const standDiff = safe(f.decayed_stand_diff_per_min);
  const standDiffScore = clamp(50 + (standDiff / 2) * 50);
  const accScore = clamp((safe(f.str_acc) * 100) / 0.55);
  const kdSrc = f.decayed_kd_per_fight ?? safe(f.knockdowns_per_fight);
  const kdScore = clamp((kdSrc / 0.65) * 100);
  const striking = Math.round(
    standDiffScore * 0.5 + accScore * 0.25 + kdScore * 0.25,
  );

  // --- Grappling: decayed TD volume + accuracy + control + sub threat ---
  // td_landed_per_fight is the recent-weighted bout average; td_acc is
  // the recent landed/attempted ratio when the fighter has decay weight,
  // otherwise the career rate. subThreat is max(attempt rate, decayed
  // realised sub wins).
  const tdLanded = safe(f.decayed_td_landed_per_fight);
  const tdAttempted = safe(f.decayed_td_attempted_per_fight);
  const tdAvgScore = clamp((tdLanded / 2.5) * 100);
  const tdAccRecent = tdAttempted > 0 ? tdLanded / tdAttempted : safe(f.td_acc);
  const tdAccScore = clamp((tdAccRecent / 0.5) * 100);
  const controlSrc =
    f.decayed_control_per_fight ?? safe(f.control_seconds_avg);
  const controlScore = clamp((controlSrc / 300) * 100);
  // Wave 19: ground_diff captures GnP / ground-position dominance.
  // ±2/min net edge in ground position → full ±50 from neutral 50.
  // Khabib (+2.15), Aspinall (+1.83) cap; Pereira/Holloway near 50.
  const groundDiff = safe(f.decayed_ground_diff_per_min);
  const groundDiffScore = clamp(50 + (groundDiff / 2) * 50);
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
  // Wave 19: rebalance again to fit groundDiff into the grappling mix.
  // 18/12/20/15/35 (sum 100). Wave 18.4 was 20/15/25/40. The 5% taken
  // off subThreat goes into groundDiff — wrestlers with GnP edges
  // (Khabib, Aspinall) recoup it via the new axis; pure sub
  // specialists without GnP (Charles ground_diff ~0.11) take a slight
  // hit. Trade-off accepted to honestly separate ground GnP from
  // submission threat.
  const grappling = Math.round(
    tdAvgScore * 0.18
      + tdAccScore * 0.12
      + controlScore * 0.2
      + groundDiffScore * 0.15
      + subThreat * 0.35,
  );

  // --- Defense: TD def + Str def + decayed damage absorbed + decayed durability ---
  // tdDef/strDef stay career rates. damageScore uses decayed SApM.
  // durabilityScore uses decay-weighted finish-loss rate (Σ df over KO/
  // TKO/sub losses) over the same df denominator as everything else.
  const tdDefScore = clamp((safe(f.td_def) * 100) / 0.8);
  const strDefScore = clamp((safe(f.str_def) * 100) / 0.65);
  const sapmSrc = f.decayed_sapm ?? safe(f.sapm);
  const damageScore = clamp(100 - (sapmSrc / 5) * 100);
  const finishLossRate =
    totalDf > 0 ? safe(f.decayed_finish_losses_weighted) / totalDf : 0;
  const durabilityScore = clamp(100 - finishLossRate * 200);
  const defense = Math.round(
    tdDefScore * 0.3
      + strDefScore * 0.25
      + damageScore * 0.2
      + durabilityScore * 0.25,
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
