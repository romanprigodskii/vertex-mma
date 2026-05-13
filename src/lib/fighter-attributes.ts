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
 * Map a fighter's career numbers to six 0–100 attribute scores for the radar.
 *
 * Benchmarks chosen against UFCStats-era averages — not gospel, but they
 * produce sensible-looking radars for both elite and journeymen.
 *
 * `power` and `cardio` rely on the `bout.method` column, which is NULL for
 * about half of completed bouts in our DB (scraper coverage gap). Fighters
 * whose finishes weren't recorded get pulled toward zero on those axes — a
 * real reflection of incomplete data, not a bug in the formula.
 */
export function computeAttributes(f: FighterDetail): FighterAttributes {
  // --- Striking: composite of SLpM + accuracy + defense ---
  const slpmScore = clamp((safe(f.slpm) / 7) * 100);
  const accScore = clamp((safe(f.str_acc) * 100) / 0.6);
  const defScore = clamp((safe(f.str_def) * 100) / 0.7);
  const striking = Math.round(slpmScore * 0.5 + accScore * 0.25 + defScore * 0.25);

  // --- Grappling: takedown volume × accuracy + sub threat ---
  const tdAvgScore = clamp((safe(f.td_avg) / 5) * 100);
  const tdAccScore = clamp((safe(f.td_acc) * 100) / 0.6);
  const subScore = clamp((safe(f.sub_avg) / 3) * 100);
  const grappling = Math.round(
    tdAvgScore * 0.4 + tdAccScore * 0.3 + subScore * 0.3,
  );

  // --- Defense: takedown defense + striking defense ---
  const tdDefScore = clamp((safe(f.td_def) * 100) / 0.85);
  const strDefScore = clamp((safe(f.str_def) * 100) / 0.7);
  const defense = Math.round(tdDefScore * 0.5 + strDefScore * 0.5);

  // --- Cardio: proxy via % of wins that go to decision (longer fights). ---
  const totalUfcWins = f.ufc_wins;
  const cardio =
    totalUfcWins === 0
      ? 50
      : clamp(Math.round((f.ufc_wins_dec / totalUfcWins) * 100 + 30));

  // --- Power: finish rate (non-decision wins / total wins). Uses
  //     `ufc_wins_finish` which infers finish from round_finished when
  //     `bout.method` is NULL (half the corpus). Without this the score
  //     would zero out for famous finishers like Khabib whose submissions
  //     all have unrecorded methods.
  const power =
    totalUfcWins === 0
      ? 30
      : clamp(Math.round((f.ufc_wins_finish / totalUfcWins) * 100));

  // --- Activity: bouts vs. a "high tenure" benchmark of 30 UFC bouts ---
  const activity = clamp(Math.round((f.ufc_total / 30) * 100));

  return { striking, grappling, defense, cardio, power, activity };
}
