import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { isRuLocale, localizedNameSql } from "@/lib/i18n-name";
import type { FighterDetail } from "@/lib/fighter-detail";

/**
 * 7-dim style vector. Each axis is normalized to an empirical UFC max so the
 * vector lies roughly in [0,1]^7. Normalizing keeps one wide-range axis (e.g.
 * td_avg) from dominating the Euclidean distance the similarity below measures.
 */
const AXIS_MAX = {
  slpm: 10,
  str_acc: 0.7,
  str_def: 0.85,
  td_avg: 7,
  td_acc: 0.85,
  td_def: 0.95,
  sub_avg: 4,
} as const;

type StatsRow = {
  slpm: number | null;
  str_acc: number | null;
  str_def: number | null;
  td_avg: number | null;
  td_acc: number | null;
  td_def: number | null;
  sub_avg: number | null;
};

function styleVector(s: StatsRow): number[] {
  return [
    (s.slpm ?? 0) / AXIS_MAX.slpm,
    (s.str_acc ?? 0) / AXIS_MAX.str_acc,
    (s.str_def ?? 0) / AXIS_MAX.str_def,
    (s.td_avg ?? 0) / AXIS_MAX.td_avg,
    (s.td_acc ?? 0) / AXIS_MAX.td_acc,
    (s.td_def ?? 0) / AXIS_MAX.td_def,
    (s.sub_avg ?? 0) / AXIS_MAX.sub_avg,
  ];
}

/**
 * Inverse-Euclidean similarity on normalized stat vectors, mapped to [0, 1].
 *
 * Cosine was the obvious first choice but it's angle-only: a fighter with
 * stats `[0.4, 0.5, 0.6]` ends up 99% similar to one with `[0.04, 0.05, 0.06]`
 * because they're parallel. Euclidean penalizes magnitude gaps, so a pure
 * striker (high slpm, low td_avg) actually reads as different from a
 * grappler (low slpm, high td_avg). The exponential decay (`/ tau`) keeps
 * the score moving smoothly between 0 and 1 instead of bunching at 100%.
 */
function similarity(a: number[], b: number[]): number {
  let sumSq = 0;
  for (let i = 0; i < a.length; i += 1) {
    sumSq += (a[i] - b[i]) ** 2;
  }
  const dist = Math.sqrt(sumSq);
  // tau picked so a distance of 0.35 (a meaningful style gap) lands around 0.5.
  const tau = 0.5;
  return Math.exp(-dist / tau);
}

export type SimilarFighter = {
  id: string;
  slug: string;
  name_en: string;
  nickname: string | null;
  photo_url: string | null;
  country_code: string | null;
  weight_class_primary: string | null;
  wins_total: number;
  losses_total: number;
  ufc_total: number;
  similarity: number;
};

type Candidate = SimilarFighter & StatsRow;

/**
 * Inverse-Euclidean-similar fighters in the same weight class (see
 * `similarity` for why not cosine). Returns up to `limit` fighters ordered by
 * descending similarity. Returns an empty array when the source has no weight
 * class to match against, or no slpm — the axis every candidate is required to
 * have (see the `f.slpm IS NOT NULL` filter below).
 */
export async function getSimilarFighters(
  current: FighterDetail,
  limit = 6,
): Promise<SimilarFighter[]> {
  if (!current.weight_class_primary) return [];

  // Align the source with the candidate filter: candidates all have a real
  // slpm and styleVector reads (slpm ?? 0), so a source with null slpm would
  // be pinned to the 0 striking-volume corner and compared against fighters
  // that all have one — systematically distorting the ranking. Require it.
  if (current.slpm == null) return [];

  const isRu = await isRuLocale();
  const result = await db.execute<Candidate>(sql`
    SELECT
      f.id::text AS id,
      f.slug,
      ${localizedNameSql("f", isRu)} AS name_en,
      f.nickname,
      f.photo_url,
      f.country_code,
      f.weight_class_primary::text AS weight_class_primary,
      COALESCE(f.wins_total, 0)::int AS wins_total,
      COALESCE(f.losses_total, 0)::int AS losses_total,
      f.ufc_total,
      f.slpm,
      f.str_acc,
      f.str_def,
      f.td_avg,
      f.td_acc,
      f.td_def,
      f.sub_avg,
      0::float AS similarity
    FROM fighter_with_stats f
    WHERE f.weight_class_primary::text = ${current.weight_class_primary}
      AND f.id <> ${current.id}::uuid
      AND f.slpm IS NOT NULL
      AND f.ufc_total >= 8
  `);

  const rows = result as unknown as Candidate[];
  if (rows.length === 0) return [];

  const myVec = styleVector(current);
  const scored = rows.map((c) => ({
    ...c,
    similarity: similarity(myVec, styleVector(c)),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, limit).map((c) => ({
    id: c.id,
    slug: c.slug,
    name_en: c.name_en,
    nickname: c.nickname,
    photo_url: c.photo_url,
    country_code: c.country_code,
    weight_class_primary: c.weight_class_primary,
    wins_total: c.wins_total,
    losses_total: c.losses_total,
    ufc_total: c.ufc_total,
    similarity: c.similarity,
  }));
}
