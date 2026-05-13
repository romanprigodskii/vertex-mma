import { sql, type SQL } from "drizzle-orm";

import { CHAMPION_SLUGS } from "@/lib/champions";
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

/* -------------------------------------------------------------------------- */
/*                     Catalog search with combined filters                    */
/* -------------------------------------------------------------------------- */

export type CatalogSort =
  | "champions_first"
  | "fights"
  | "recent"
  | "wins"
  | "winrate"
  | "name_asc"
  | "name_desc";

export type FighterCatalogFilters = {
  q?: string;
  weight?: string[];
  country?: string[];
  stance?: string[];
  status?: "all" | "active" | "retired" | "inactive";
  hasPhoto?: boolean;
  hallOfFame?: boolean;
  sort?: CatalogSort;
  offset?: number;
  limit?: number;
};

export type FighterCatalogRow = {
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
  stance: string | null;
  status: string | null;
  hall_of_fame_year: number | null;
  wins_total: number;
  losses_total: number;
  draws_total: number;
  no_contests: number;
  bout_count: number;
};

export type FighterCatalogResponse = {
  fighters: FighterCatalogRow[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
};

export const CATALOG_DEFAULT_LIMIT = 48;
const MAX_LIMIT = 96;

function buildWhere(filters: FighterCatalogFilters): SQL {
  const conditions: SQL[] = [];

  const trimmedQ = filters.q?.trim();
  if (trimmedQ) {
    const like = `%${trimmedQ}%`;
    conditions.push(sql`(
      f.name_en ILIKE ${like}
      OR COALESCE(f.nickname, '') ILIKE ${like}
      OR similarity(f.name_en, ${trimmedQ}) > 0.3
      OR similarity(COALESCE(f.nickname, ''), ${trimmedQ}) > 0.3
      OR EXISTS (
        SELECT 1 FROM fighter_alias fa
        WHERE fa.fighter_id = f.id
          AND (fa.alias ILIKE ${like} OR similarity(fa.alias, ${trimmedQ}) > 0.3)
      )
    )`);
  }

  if (filters.weight && filters.weight.length > 0) {
    const values = sql.join(
      filters.weight.map((v) => sql`${v}`),
      sql`, `,
    );
    conditions.push(sql`f.weight_class_primary::text IN (${values})`);
  }

  if (filters.country && filters.country.length > 0) {
    const values = sql.join(
      filters.country.map((v) => sql`${v}`),
      sql`, `,
    );
    conditions.push(sql`f.country_code IN (${values})`);
  }

  if (filters.stance && filters.stance.length > 0) {
    const values = sql.join(
      filters.stance.map((v) => sql`${v}`),
      sql`, `,
    );
    conditions.push(sql`f.stance::text IN (${values})`);
  }

  if (filters.status && filters.status !== "all") {
    conditions.push(sql`f.status::text = ${filters.status}`);
  }

  if (filters.hasPhoto) {
    conditions.push(sql`f.photo_url IS NOT NULL`);
  }

  if (filters.hallOfFame) {
    conditions.push(sql`f.hall_of_fame_year IS NOT NULL`);
  }

  if (conditions.length === 0) return sql``;
  return sql`WHERE ${sql.join(conditions, sql` AND `)}`;
}

function buildOrderBy(filters: FighterCatalogFilters): SQL {
  const hasQuery = Boolean(filters.q?.trim());
  switch (filters.sort) {
    case "name_asc":
      return sql`f.name_en ASC`;
    case "name_desc":
      return sql`f.name_en DESC`;
    case "wins":
      return sql`COALESCE(fsa.wins_total, 0) DESC, bout_count DESC`;
    case "winrate":
      return sql`(
        COALESCE(fsa.wins_total, 0)::float
        / NULLIF(COALESCE(fsa.wins_total, 0) + COALESCE(fsa.losses_total, 0), 0)
      ) DESC NULLS LAST, COALESCE(fsa.wins_total, 0) DESC`;
    case "recent":
      return sql`last_bout_date DESC NULLS LAST, bout_count DESC`;
    case "fights":
      return hasQuery
        ? sql`match_score DESC, bout_count DESC`
        : sql`bout_count DESC, COALESCE(fsa.wins_total, 0) DESC`;
    case "champions_first":
    default: {
      const slugList = sql.join(
        CHAMPION_SLUGS.map((s) => sql`${s}`),
        sql`, `,
      );
      // Champions get rank 0 (top), everyone else rank 1. Within each tier,
      // sort by bout count → wins. When a query is present, similarity wins
      // over champion-status (the user almost certainly wants the matching
      // person at the top, not unrelated champions).
      return hasQuery
        ? sql`match_score DESC, (CASE WHEN f.slug IN (${slugList}) THEN 0 ELSE 1 END), bout_count DESC`
        : sql`(CASE WHEN f.slug IN (${slugList}) THEN 0 ELSE 1 END), bout_count DESC, COALESCE(fsa.wins_total, 0) DESC`;
    }
  }
}

/**
 * Combined filter + fuzzy-search query against the fighter catalog.
 * Returns paginated rows plus the unpaginated total for the same WHERE clause.
 */
export async function searchFightersWithFilters(
  filters: FighterCatalogFilters,
): Promise<FighterCatalogResponse> {
  const offset = Math.max(0, filters.offset ?? 0);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, filters.limit ?? CATALOG_DEFAULT_LIMIT),
  );

  const trimmedQ = filters.q?.trim();
  const where = buildWhere(filters);
  const orderBy = buildOrderBy(filters);

  const matchScoreSelect = trimmedQ
    ? sql`,
      GREATEST(
        similarity(f.name_en, ${trimmedQ}),
        similarity(COALESCE(f.nickname, ''), ${trimmedQ})
      )::float AS match_score`
    : sql``;

  const lastBoutDateSelect =
    filters.sort === "recent"
      ? sql`,
      (
        SELECT MAX(e.date)
        FROM bout b
        JOIN event e ON e.id = b.event_id
        WHERE b.fighter_a_id = f.id OR b.fighter_b_id = f.id
      ) AS last_bout_date`
      : sql``;

  const rowsQuery = sql`
    SELECT
      f.id::text AS id,
      f.slug,
      f.name_en,
      f.name_ru,
      f.nickname,
      f.photo_url,
      f.photo_silhouette_url,
      f.photo_thumbnail_url,
      f.weight_class_primary::text AS weight_class_primary,
      f.country_code,
      f.stance::text AS stance,
      f.status::text AS status,
      f.hall_of_fame_year,
      COALESCE(fsa.wins_total, 0) AS wins_total,
      COALESCE(fsa.losses_total, 0) AS losses_total,
      COALESCE(fsa.draws_total, 0) AS draws_total,
      COALESCE(fsa.no_contests, 0) AS no_contests,
      (
        SELECT COUNT(*)::int
        FROM bout
        WHERE bout.fighter_a_id = f.id OR bout.fighter_b_id = f.id
      ) AS bout_count
      ${matchScoreSelect}
      ${lastBoutDateSelect}
    FROM fighter f
    LEFT JOIN fighter_stats_aggregate fsa ON fsa.fighter_id = f.id
    ${where}
    ORDER BY ${orderBy}
    OFFSET ${offset}
    LIMIT ${limit}
  `;

  const countQuery = sql`
    SELECT COUNT(*)::int AS total
    FROM fighter f
    ${where}
  `;

  const [rowsResult, countResult] = await Promise.all([
    db.execute<FighterCatalogRow>(rowsQuery),
    db.execute<{ total: number }>(countQuery),
  ]);

  const fighters = rowsResult as unknown as FighterCatalogRow[];
  const totalRows = countResult as unknown as Array<{ total: number }>;
  const total = totalRows[0]?.total ?? 0;

  return {
    fighters: [...fighters],
    total,
    hasMore: offset + fighters.length < total,
    offset,
    limit,
  };
}

/* -------------------------------------------------------------------------- */
/*                      Aggregate helpers for filter UI                       */
/* -------------------------------------------------------------------------- */

export type CountryAggregate = { code: string; count: number };

/**
 * ISO-2 country codes with fighter counts, ordered by count DESC. Excludes nulls.
 */
export async function getFighterCountries(): Promise<CountryAggregate[]> {
  const result = await db.execute<CountryAggregate>(sql`
    SELECT country_code AS code, COUNT(*)::int AS count
    FROM fighter
    WHERE country_code IS NOT NULL
    GROUP BY country_code
    ORDER BY count DESC, country_code ASC
  `);
  return [...(result as unknown as CountryAggregate[])];
}

/** Total fighter count — used in the catalog hero subtitle. */
export async function getFighterTotal(): Promise<number> {
  const result = await db.execute<{ total: number }>(
    sql`SELECT COUNT(*)::int AS total FROM fighter`,
  );
  const rows = result as unknown as Array<{ total: number }>;
  return rows[0]?.total ?? 0;
}

/**
 * Fetch the catalog rows for an explicit slug list (used by the champion strip).
 * Preserves the input order so the caller can render champions in spec-order.
 */
export async function getFightersBySlug(
  slugs: readonly string[],
): Promise<FighterCatalogRow[]> {
  if (slugs.length === 0) return [];
  const values = sql.join(
    slugs.map((s) => sql`${s}`),
    sql`, `,
  );
  const result = await db.execute<FighterCatalogRow>(sql`
    SELECT
      f.id::text AS id,
      f.slug,
      f.name_en,
      f.name_ru,
      f.nickname,
      f.photo_url,
      f.photo_silhouette_url,
      f.photo_thumbnail_url,
      f.weight_class_primary::text AS weight_class_primary,
      f.country_code,
      f.stance::text AS stance,
      f.status::text AS status,
      f.hall_of_fame_year,
      COALESCE(fsa.wins_total, 0) AS wins_total,
      COALESCE(fsa.losses_total, 0) AS losses_total,
      COALESCE(fsa.draws_total, 0) AS draws_total,
      COALESCE(fsa.no_contests, 0) AS no_contests,
      (
        SELECT COUNT(*)::int FROM bout
        WHERE bout.fighter_a_id = f.id OR bout.fighter_b_id = f.id
      ) AS bout_count
    FROM fighter f
    LEFT JOIN fighter_stats_aggregate fsa ON fsa.fighter_id = f.id
    WHERE f.slug IN (${values})
  `);
  const rows = result as unknown as FighterCatalogRow[];

  // Re-order to match the input slug list. Missing fighters drop out — the
  // caller is responsible for rendering a placeholder.
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  return slugs
    .map((slug) => bySlug.get(slug))
    .filter((r): r is FighterCatalogRow => r !== undefined);
}
