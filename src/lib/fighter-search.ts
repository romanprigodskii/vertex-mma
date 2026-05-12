import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export type FighterSearchResult = {
  id: string;
  slug: string;
  name_en: string;
  name_ru: string | null;
  nickname: string | null;
  photo_url: string | null;
  photo_silhouette_url: string | null;
  photo_thumbnail_url: string | null;
  weight_class_primary: string | null;
  country_code: string | null;
  wins_total: number | null;
  losses_total: number | null;
  draws_total: number | null;
  similarity: number;
};

/**
 * Fuzzy search fighters by name, nickname, or alias using pg_trgm similarity().
 *
 * Trigram similarity falls in [0, 1]; results are ordered DESC. Substring ILIKE
 * matches always qualify so exact-substring hits don't get dropped by the 0.3
 * similarity threshold.
 */
export async function searchFighters(
  query: string,
  limit = 20,
): Promise<FighterSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const result = await db.execute<FighterSearchResult>(sql`
    SELECT DISTINCT ON (f.id)
      f.id::text AS id,
      f.slug,
      f.name_en,
      f.name_ru,
      f.nickname,
      f.photo_url,
      f.photo_silhouette_url,
      f.photo_thumbnail_url,
      f.weight_class_primary::text,
      f.country_code,
      fsa.wins_total,
      fsa.losses_total,
      fsa.draws_total,
      GREATEST(
        similarity(f.name_en, ${trimmed}),
        similarity(COALESCE(f.nickname, ''), ${trimmed}),
        COALESCE((
          SELECT MAX(similarity(fa.alias, ${trimmed}))
          FROM fighter_alias fa
          WHERE fa.fighter_id = f.id
        ), 0)
      )::float AS similarity
    FROM fighter f
    LEFT JOIN fighter_stats_aggregate fsa ON fsa.fighter_id = f.id
    WHERE
      f.name_en ILIKE ${"%" + trimmed + "%"}
      OR f.nickname ILIKE ${"%" + trimmed + "%"}
      OR similarity(f.name_en, ${trimmed}) > 0.3
      OR similarity(COALESCE(f.nickname, ''), ${trimmed}) > 0.3
      OR EXISTS (
        SELECT 1 FROM fighter_alias fa2
        WHERE fa2.fighter_id = f.id
          AND similarity(fa2.alias, ${trimmed}) > 0.3
      )
    ORDER BY f.id, similarity DESC
    LIMIT ${limit}
  `);

  // postgres-js returns rows as the array itself.
  const rows = result as unknown as FighterSearchResult[];
  return [...rows].sort((a, b) => b.similarity - a.similarity);
}
