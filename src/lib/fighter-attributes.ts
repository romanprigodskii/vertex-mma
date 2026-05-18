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
  // Wave 20: quality style — stand-up output weighted by opp tier. A
  // fighter who lands the same volume but vs ranked opponents scores
  // higher here than vs prospects.
  const standLandedQuality = safe(f.decayed_stand_landed_quality_per_min);
  const standQualityScore = clamp((standLandedQuality / 5) * 100);
  const strQualityStyle = standQualityScore * 0.7 + accScore * 0.3;
  const striking = Math.round(
    Math.max(strVolumeStyle, strPowerStyle, strTechnicalStyle, strQualityStyle),
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
  // Wave 20: quality style — takedowns/control weighted by opp tier.
  // Uses max(td_quality, control_quality) so the dominant signal
  // drives the branch; subThreat adds residual sub credit.
  const tdQuality = safe(f.decayed_td_landed_quality);
  const controlQuality = safe(f.decayed_control_quality);
  const grpTdQualityScore = clamp((tdQuality / 2.5) * 100);
  const grpCtrlQualityScore = clamp((controlQuality / 300) * 100);
  const grpQualityStyle =
    Math.max(grpTdQualityScore, grpCtrlQualityScore) * 0.7 + subThreat * 0.3;
  const grappling = Math.round(
    Math.max(
      grpControlStyle,
      grpWrestlerStyle,
      grpSubmissionStyle,
      grpQualityStyle,
    ),
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
  // Wave 20: quality style — damage absorbed per minute vs ranked
  // opponents (lower = better). Threshold 4/min (tighter than career
  // damageScore's 5/min) because elite fighters are expected to absorb
  // less when facing ranked competition.
  const damageQualityPerMin = safe(f.decayed_damage_quality);
  const damageQualityScore = clamp(100 - (damageQualityPerMin / 4) * 100);
  const defQualityStyle = damageQualityScore * 0.6 + tdDefScore * 0.4;
  const defense = Math.round(
    Math.max(
      defWrestlerStyle,
      defStrikerStyle,
      defIronChinStyle,
      defQualityStyle,
    ),
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
  const cardioBlended = clamp(
    Math.round(rawCardio * cardioConfidence + 50 * (1 - cardioConfidence)),
  );
  // Wave 20: cardio quality bypass — if a fighter has reached late
  // rounds vs ranked opponents, the data is enough to declare cardio
  // regardless of overall sample. Max with the blended score so the
  // baseline-50 floor stays in place for finishers who haven't been
  // tested against ranked competition.
  const lateQuality = safe(f.decayed_late_reach_quality);
  const cardioQualityScore = clamp(lateQuality * 100);
  const cardio = Math.round(Math.max(cardioBlended, cardioQualityScore));

  // --- Power: max of 4 styles (volume / quality / finisher / kd) ---
  // Wave 20: separated style branches so KO specialists with different
  // signatures don't blur. Volume = high KO rate (Khabib lacks),
  // quality = KOs vs ranked opponents (Pereira/Topuria), finisher =
  // fast finish time (Aspinall 72s avg), kd = decayed knockdown volume.
  // koRate falls back to the Wave 18 career rate when the fighter has
  // no decayed wins (zero UFC fights or all bouts pre-decay floor).
  const totalUfcWins = Math.max(1, safe(f.ufc_wins));
  const koRate =
    decayedWins > 0
      ? safe(f.decayed_ko_wins_weighted) / decayedWins
      : safe(f.ufc_wins_ko) / totalUfcWins;
  const koRateScore = clamp((koRate / 0.7) * 100);
  const kdScoreP = clamp((kdSrc / 0.65) * 100);
  const koQualityScore = clamp((safe(f.decayed_ko_quality) / 0.5) * 100);
  const koFinishSec = safe(f.decayed_avg_ko_finish_seconds);
  // 0s → 100, 600s (≈10 min total fight time) → 0. Aspinall 72s caps;
  // fighters with no KO wins (koFinishSec=0 from NULLIF→0) get 0 here
  // and rely on the volume/kd branches.
  const speedScoreRaw =
    koFinishSec > 0 ? clamp(100 - (koFinishSec / 600) * 100) : 0;
  // Gate the finisher branch by KO frequency so low-KO fighters can't
  // accidentally max speed via their handful of fast finishes (Khabib's
  // 2 KO wins happened to land at 317s avg; without this gate his
  // finisher_style would read 37). koRate ≥ 0.3 unlocks full speed; at
  // 0.15 (Khabib) the gate halves the contribution.
  const speedScore = speedScoreRaw * Math.min(1, koRate / 0.3);
  const kdQualityScore = clamp((safe(f.decayed_kd_quality) / 0.5) * 100);

  const powVolumeStyle = koRateScore * 0.7 + kdScoreP * 0.3;
  const powQualityStyle = koQualityScore * 0.6 + koRateScore * 0.4;
  const powFinisherStyle = speedScore * 0.6 + koRateScore * 0.4;
  const powKdStyle = kdScoreP * 0.8 + kdQualityScore * 0.2;
  const power = Math.round(
    Math.max(powVolumeStyle, powQualityStyle, powFinisherStyle, powKdStyle),
  );

  // --- Activity: max of 3 layered windows (12mo / 24mo / 36mo) ---
  // Wave 20: each layer scores (fight_count × avg_opp_tier) normalised
  // to a target band. 12mo cap at ~3 fights × 20 tier = 60. 24mo doubles
  // the cadence (6 × 20 = 120). 36mo triples (9 × 20 = 180). Max picks
  // the best window so a fighter who had a great 36mo span but a quiet
  // 12mo doesn't read as inactive.
  const fights12 = safe(f.fights_last_12mo);
  const tier12 = safe(f.avg_opp_tier_last_12mo);
  const fights24 = safe(f.fights_last_24mo);
  const tier24 = safe(f.avg_opp_tier_last_24mo);
  const fights36 = safe(f.fights_last_36mo);
  const tier36 = safe(f.avg_opp_tier_last_36mo);

  const layer12 = clamp(((fights12 * tier12) / 60) * 100);
  const layer24 = clamp(((fights24 * tier24) / 120) * 100);
  const layer36 = clamp(((fights36 * tier36) / 180) * 100);

  const activity = Math.round(Math.max(layer12, layer24, layer36));

  return { striking, grappling, defense, cardio, power, activity };
}
