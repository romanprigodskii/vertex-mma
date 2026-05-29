import { sql, type SQL } from "drizzle-orm";

import { CHAMPION_SLUGS } from "@/lib/champions";
import { db } from "@/lib/db";
import { isRuLocale, localizedNameSql } from "@/lib/i18n-name";

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
  rank_score?: number;
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

  const isRu = await isRuLocale();
  const result = await db.execute<FighterSearchResult>(sql`
    SELECT DISTINCT ON (f.id)
      f.id::text AS id,
      f.slug,
      ${localizedNameSql("f", isRu)} AS name_en,
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
      )::float AS similarity,
      (
        (CASE
          WHEN lower(f.name_en) = lower(${trimmed}) THEN 4
          WHEN f.name_en ILIKE ${trimmed + "%"}
            OR f.name_en ILIKE ${"% " + trimmed + "%"} THEN 3
          WHEN COALESCE(f.nickname, '') ILIKE ${trimmed + "%"}
            OR COALESCE(f.nickname, '') ILIKE ${"% " + trimmed + "%"} THEN 2
          WHEN f.name_en ILIKE ${"%" + trimmed + "%"}
            OR COALESCE(f.nickname, '') ILIKE ${"%" + trimmed + "%"} THEN 1
          ELSE 0
        END) * 1000
        + GREATEST(COALESCE(f.vertex_score, 0), COALESCE(f.vertex_score_all_time, 0))
      )::float AS rank_score
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
    ORDER BY f.id, rank_score DESC
    LIMIT ${limit}
  `);

  // Rank known/higher-rated fighters above nonames within the same match tier.
  const rows = result as unknown as FighterSearchResult[];
  return [...rows].sort(
    (a, b) => (b.rank_score ?? 0) - (a.rank_score ?? 0),
  );
}

/* -------------------------------------------------------------------------- */
/*                     Catalog search with combined filters                    */
/* -------------------------------------------------------------------------- */

export type CatalogSort =
  | "vertex_current"
  | "vertex_all_time"
  | "elite_first"
  | "all_time"
  | "champions_first"
  | "fights"
  | "recent"
  | "wins"
  | "winrate"
  | "name_asc"
  | "name_desc";

/** Score-based tier filter for the catalog. Tier is now independent of
 *  championship history (Wave 3.5 step 4A.2) — a champion can also be in
 *  any score tier. The `champion` filter is exposed separately. */
export type CatalogTierFilter =
  | "all"
  | "apex"
  | "elite"
  | "established"
  | "roster";

/** Champion-status filter, orthogonal to tier. `any` matches any of the
 *  three champion variants (Active / Dominant / Former). */
export type CatalogChampionFilter =
  | "all"
  | "any"
  | "active"
  | "dominant"
  | "former"
  | "none";

/** Gender filter for split leaderboards. Default is `all` (combined). */
export type CatalogGenderFilter = "all" | "male" | "female";

export type FighterCatalogFilters = {
  q?: string;
  weight?: string[];
  country?: string[];
  stance?: string[];
  /** UFC roster membership from roster.watch (Wave 6A.5). Defaults to
   *  "active" in the UI so the catalog opens with the ~614 currently-
   *  rostered fighters instead of the full ~2697 historical archive.
   *  As of Wave 6A.5b the import emits a binary active/retired view
   *  (released/inactive/unknown still in the enum but no longer written). */
  status?: "all" | "active" | "retired" | "inactive";
  hasPhoto?: boolean;
  hallOfFame?: boolean;
  /** Vertex Score tier filter (score-based). Defaults to "all". */
  tier?: CatalogTierFilter;
  /** Champion-status filter (history-based). Defaults to "all". */
  champion?: CatalogChampionFilter;
  /** Gender filter for split leaderboards. Defaults to "all" (combined). */
  gender?: CatalogGenderFilter;
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
  /** roster.watch membership populated by scripts/import_roster_watch.ts:
   *  active | released | retired | inactive | unknown. Drives the default
   *  catalog filter so /fighters opens on the live UFC roster. */
  roster_status: string;
  has_upcoming_bout: boolean;
  next_event_date: string | null;
  next_opponent_name: string | null;
  hall_of_fame_year: number | null;
  wins_total: number;
  losses_total: number;
  draws_total: number;
  no_contests: number;
  bout_count: number;
  /** From fighter_with_stats view (Wave 3A.3). */
  last_fight_date: string | null;
  last_fight_result: "W" | "L" | "D" | "NC" | null;
  last_fight_method: string | null;
  current_streak_type: "W" | "L" | null;
  current_streak_count: number;
  /** Vertex Score data (Wave 3.5). NULL for fighters with <3 UFC bouts; for
   *  `vertex_score` also NULL for inactive fighters. The frontend computes the
   *  tier via `classifyFighter()` from src/lib/vertex-tier.ts using these
   *  fields plus the slug. */
  vertex_score: number | null;
  vertex_score_all_time: number | null;
  championship_pedigree: number;
  is_dominant_champion: boolean;
  ufc_bouts: number;
  /** Wave 14B.2: per-division current score for the single active weight
   *  filter. NULL when (a) no weight filter, (b) multiple weight filters
   *  (cross-division comparison is meaningless), or (c) the fighter has
   *  no fighter_divisional_score row for the filtered division
   *  (insufficient bouts; their global vertex_score remains the
   *  fallback). When non-null, callers should prefer this over
   *  vertex_score for display + tier classification. */
  divisional_score: number | null;
  /** Wave 14B.2: same single-weight gate as divisional_score. One of
   *  'current' | 'provisional' | 'former' when a divisional row exists. */
  divisional_status: "current" | "provisional" | "former" | null;
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
    if (filters.weight.length === 1) {
      // Wave 14B.2: single-weight filter switches to the divisional
      // ranking pool — only fighters with an in_active_ranking=TRUE row
      // for this division (active rostered + primary_division=$weight,
      // OR scheduled bout in $weight) AND, as a fallback for fighters
      // with <3 bouts in the division (no fighter_divisional_score row
      // at all), the legacy primary-division match path so a freshly
      // promoted champion like Islam in WW still appears even before
      // they have 3 WW bouts. The LEFT JOIN below feeds the same
      // predicate via fds.fighter_id IS NOT NULL — see rowsQuery.
      const w = filters.weight[0];
      conditions.push(sql`(
        EXISTS (
          SELECT 1 FROM fighter_divisional_score fds_x
          WHERE fds_x.fighter_id = f.id
            AND fds_x.division::text = ${w}
            AND fds_x.in_active_ranking = TRUE
        )
        OR (
          COALESCE(f.current_division, f.weight_class_primary::text) = ${w}
          AND NOT EXISTS (
            SELECT 1 FROM fighter_divisional_score fds_y
            WHERE fds_y.fighter_id = f.id
              AND fds_y.division::text = ${w}
          )
        )
      )`);
    } else {
      const values = sql.join(
        filters.weight.map((v) => sql`${v}`),
        sql`, `,
      );
      // Wave 7A: multi-weight comparison stays on the legacy
      // current_division → weight_class_primary fallback. Divisional
      // scores aren't meaningful when comparing across divisions.
      conditions.push(
        sql`COALESCE(f.current_division, f.weight_class_primary::text) IN (${values})`,
      );
    }
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
    // Wave 6C: status filter targets the roster_status column (populated
    // by scripts/import_roster_watch.ts), not the legacy fighter.status
    // enum which is defaulted to 'active' for nearly every fighter.
    //
    // 'inactive' is the UI bucket that covers everyone NOT on the current
    // roster — both formally retired fighters (132) and 'released'
    // fighters (1951, the long tail). Jon Jones lives in 'released', so
    // before this collapse the UI's Retired button hid him from view.
    if (filters.status === "inactive") {
      conditions.push(sql`f.roster_status::text IN ('retired', 'released')`);
    } else {
      conditions.push(sql`f.roster_status::text = ${filters.status}`);
    }
  }

  if (filters.hasPhoto) {
    conditions.push(sql`f.photo_url IS NOT NULL`);
  }

  if (filters.hallOfFame) {
    conditions.push(sql`f.hall_of_fame_year IS NOT NULL`);
  }

  // Vertex Score tier filter — `champion` includes all 3 champion sub-tiers
  // by pedigree alone; the rest match on the better of current / all-time
  // score AND exclude fighters with a champion pedigree (so a Pro who happens
  // to have been a champion doesn't appear in `tier=pro`).
  if (filters.tier && filters.tier !== "all") {
    // Tier is purely score-based (Wave 31.9 bands: 75 / 55 / 35).
    // Champion fighters in Apex / Elite / Established bands appear in
    // those tier filters AND in the champion filter — by design, the
    // two dimensions are independent.
    const bestScore = sql`COALESCE(f.vertex_score, f.vertex_score_all_time)`;
    switch (filters.tier) {
      case "apex":
        conditions.push(sql`${bestScore} >= 75`);
        break;
      case "elite":
        conditions.push(sql`${bestScore} >= 55 AND ${bestScore} < 75`);
        break;
      case "established":
        conditions.push(sql`${bestScore} >= 35 AND ${bestScore} < 55`);
        break;
      case "roster":
        conditions.push(sql`${bestScore} IS NOT NULL AND ${bestScore} < 35`);
        break;
    }
  }

  if (filters.gender && filters.gender !== "all") {
    conditions.push(sql`f.gender = ${filters.gender}`);
  }

  if (filters.champion && filters.champion !== "all") {
    switch (filters.champion) {
      case "any":
        conditions.push(sql`f.championship_pedigree >= 80`);
        break;
      case "active":
        conditions.push(sql`f.championship_pedigree = 100`);
        break;
      case "dominant":
        // Dominant flag captures fighters with >= 3 cumulative title defenses;
        // populated by scripts/compute_championship_pedigree.ts. Excludes
        // current champions if they happen to also qualify (no overlap by
        // design — Active and Dominant are separate UI states).
        conditions.push(
          sql`f.is_dominant_champion = true AND f.championship_pedigree < 100`,
        );
        break;
      case "former":
        conditions.push(
          sql`f.championship_pedigree = 80 AND f.is_dominant_champion = false`,
        );
        break;
      case "none":
        conditions.push(sql`f.championship_pedigree < 80`);
        break;
    }
  }

  if (conditions.length === 0) return sql``;
  return sql`WHERE ${sql.join(conditions, sql` AND `)}`;
}

function buildOrderBy(filters: FighterCatalogFilters): SQL {
  const hasQuery = Boolean(filters.q?.trim());
  // Sort by the canonical divisional score (`divisional_sort_score` =
  // COALESCE(divisional, global)) for both the single-weight catalog
  // (that division's score) AND the unfiltered catalog (the fighter's
  // own current-division score — same number the profile hero shows).
  // Only multi-weight comparison stays on the global score, since
  // divisional scores aren't comparable across divisions.
  const multiWeight = (filters.weight?.length ?? 0) > 1;
  switch (filters.sort) {
    case "vertex_current":
      if (!multiWeight) {
        return hasQuery
          ? sql`match_tier DESC, GREATEST(COALESCE(f.vertex_score, 0), COALESCE(f.vertex_score_all_time, 0)) DESC, f.bout_count DESC, match_score DESC`
          : sql`divisional_sort_score DESC NULLS LAST, f.vertex_score_all_time DESC NULLS LAST, f.bout_count DESC`;
      }
      // Active fighters' current Vertex Score, falling back to all-time so
      // retired legends still rank somewhere. NULL scores (<3 UFC bouts)
      // sink to the bottom.
      return hasQuery
        ? sql`match_tier DESC, GREATEST(COALESCE(f.vertex_score, 0), COALESCE(f.vertex_score_all_time, 0)) DESC, f.bout_count DESC, match_score DESC`
        : sql`f.vertex_score DESC NULLS LAST, f.vertex_score_all_time DESC NULLS LAST, f.bout_count DESC`;
    case "vertex_all_time":
      return hasQuery
        ? sql`match_tier DESC, f.vertex_score_all_time DESC NULLS LAST, f.bout_count DESC, match_score DESC`
        : sql`f.vertex_score_all_time DESC NULLS LAST, f.bout_count DESC`;
    case "name_asc":
      return sql`f.name_en ASC`;
    case "name_desc":
      return sql`f.name_en DESC`;
    case "wins":
      // UFC-only wins so regional-circuit pioneers like Travis Fulton or
      // Dan Severn (career career_wins=300+/100+ from pre-UFC bouts)
      // don't crowd out actual UFC legends. ufc_wins comes from the
      // fighter_with_stats view's fighter_results CTE — only completed
      // UFC bouts.
      return sql`COALESCE(f.ufc_wins, 0) DESC, ufc_total DESC`;
    case "winrate":
      // Same intent — UFC-only win rate, with a soft floor of 5 UFC
      // bouts so flukey 1-0 fighters don't top the list at 100%.
      return sql`(
        COALESCE(f.ufc_wins, 0)::float
        / NULLIF(COALESCE(f.ufc_wins, 0) + COALESCE(f.ufc_losses, 0), 0)
      ) DESC NULLS LAST, COALESCE(f.ufc_wins, 0) DESC`;
    case "recent":
      return sql`last_fight_date DESC NULLS LAST, bout_count DESC`;
    case "champions_first": {
      const slugList = sql.join(
        CHAMPION_SLUGS.map((s) => sql`${s}`),
        sql`, `,
      );
      // Champions get rank 0 (top), everyone else rank 1. Within each tier,
      // sort by bout count → wins. When a query is present, similarity wins
      // over champion-status (the user almost certainly wants the matching
      // person at the top, not unrelated champions).
      return hasQuery
        ? sql`match_tier DESC, (CASE WHEN slug IN (${slugList}) THEN 0 ELSE 1 END), f.bout_count DESC, match_score DESC`
        : sql`(CASE WHEN slug IN (${slugList}) THEN 0 ELSE 1 END), bout_count DESC, COALESCE(wins_total, 0) DESC`;
    }
    case "fights":
      return hasQuery
        ? sql`match_score DESC, bout_count DESC`
        : sql`bout_count DESC, COALESCE(wins_total, 0) DESC`;
    case "all_time":
      // Historical greatness — no champion pin, no recency penalty.
      // Uses UFC-only wins/losses (from the view's ufc_stats CTE), NOT
      // career totals. Career totals via fighter_stats_aggregate include
      // pre-UFC fights (Dan Severn 101W, Jeremy Horn 91W…) and would
      // surface regional-circuit pioneers above actual UFC legends.
      // Credibility floor at 20 UFC bouts so 13-bout Khabib still hits
      // a 0.65 multiplier instead of being clipped to 0.52 at 25.
      return hasQuery
        ? sql`match_score DESC, ufc_total DESC`
        : sql`
          (
            ufc_wins::float
            * COALESCE(
                ufc_wins::float / NULLIF(ufc_wins + ufc_losses, 0),
                0.5
              )
            * (LEAST(ufc_total, 20)::float / 20.0)
          ) DESC NULLS LAST,
          ufc_total DESC
        `;
    case "elite_first":
    default: {
      const slugList = sql.join(
        CHAMPION_SLUGS.map((s) => sql`${s}`),
        sql`, `,
      );
      // Champions first, then a composite "elite score":
      //   wins * win_rate * recency_factor * credibility_floor
      // - recency_factor: 1.0 if last fight within 3 years, else 0.5.
      // - credibility_floor: LEAST(bout_count, 25) / 25 — caps the multiplier
      //   at 1.0 once a fighter hits 25 UFC bouts. Penalizes regional-circuit
      //   fighters with huge career records but only 1–2 UFC bouts (Travis
      //   Fulton, etc.) so they don't crowd out actual UFC legends.
      // Win rate falls back to 0.5 for unfought (NULLIF avoids divide-by-zero).
      return hasQuery
        ? sql`match_score DESC, (CASE WHEN slug IN (${slugList}) THEN 0 ELSE 1 END), bout_count DESC`
        : sql`
          (CASE WHEN slug IN (${slugList}) THEN 0 ELSE 1 END),
          (
            COALESCE(wins_total, 0)::float
            * COALESCE(
                wins_total::float / NULLIF(wins_total + losses_total, 0),
                0.5
              )
            * (
              CASE
                WHEN last_fight_date > NOW() - INTERVAL '3 years' THEN 1.0
                ELSE 0.5
              END
            )
            * (LEAST(bout_count, 25)::float / 25.0)
          ) DESC NULLS LAST,
          bout_count DESC
        `;
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
  const isRu = await isRuLocale();
  const where = buildWhere(filters);
  const orderBy = buildOrderBy(filters);

  const matchScoreSelect = trimmedQ
    ? sql`,
      GREATEST(
        similarity(f.name_en, ${trimmedQ}),
        similarity(COALESCE(f.nickname, ''), ${trimmedQ})
      )::float AS match_score`
    : sql``;

  // Coarse relevance bucket so prominence (vertex_score) decides the order
  // *within* a bucket — e.g. typing "jon" puts Jon Jones above an obscure
  // "Jon …", instead of letting a hair of extra trigram similarity float a
  // noname to the top. exact > name-prefix > nickname-prefix > substring > fuzzy.
  const matchTierSelect = trimmedQ
    ? sql`,
      (CASE
        WHEN lower(f.name_en) = lower(${trimmedQ}) THEN 4
        WHEN f.name_en ILIKE ${trimmedQ + "%"}
          OR f.name_en ILIKE ${"% " + trimmedQ + "%"} THEN 3
        WHEN COALESCE(f.nickname, '') ILIKE ${trimmedQ + "%"}
          OR COALESCE(f.nickname, '') ILIKE ${"% " + trimmedQ + "%"} THEN 2
        WHEN f.name_en ILIKE ${"%" + trimmedQ + "%"}
          OR COALESCE(f.nickname, '') ILIKE ${"%" + trimmedQ + "%"} THEN 1
        ELSE 0
      END)::int AS match_tier`
    : sql``;

  // Divisional score join. Single-weight filter → join the FILTERED
  // division. No weight filter → join the fighter's OWN current division
  // so the catalog shows the canonical headline score (same as the
  // profile hero, Wave 14B.2). Multi-weight comparison keeps the global
  // score — divisional scores aren't comparable across divisions.
  const singleWeight = filters.weight?.length === 1;
  const multiWeight = (filters.weight?.length ?? 0) > 1;
  const divisionalJoin = singleWeight
    ? sql`LEFT JOIN fighter_divisional_score fds
            ON fds.fighter_id = f.id
           AND fds.division::text = ${filters.weight![0]}
           AND fds.in_active_ranking = TRUE`
    : multiWeight
      ? sql``
      : sql`LEFT JOIN fighter_divisional_score fds
              ON fds.fighter_id = f.id
             AND fds.division::text = f.current_division
             AND fds.in_active_ranking = TRUE`;
  const divisionalSelect = multiWeight
    ? sql`,
      NULL::int AS divisional_score,
      NULL::text AS divisional_status`
    : sql`,
      fds.vertex_score AS divisional_score,
      fds.divisional_status,
      COALESCE(fds.vertex_score, f.vertex_score) AS divisional_sort_score`;

  const rowsQuery = sql`
    SELECT
      f.id::text AS id,
      f.slug,
      ${localizedNameSql("f", isRu)} AS name_en,
      f.name_ru,
      f.nickname,
      f.photo_url,
      f.photo_silhouette_url,
      f.photo_thumbnail_url,
      f.weight_class_primary::text AS weight_class_primary,
      f.country_code,
      f.stance::text AS stance,
      f.status::text AS status,
      f.roster_status::text AS roster_status,
      f.has_upcoming_bout,
      f.next_event_date,
      f.next_opponent_name,
      f.hall_of_fame_year,
      COALESCE(f.wins_total, 0) AS wins_total,
      COALESCE(f.losses_total, 0) AS losses_total,
      COALESCE(f.draws_total, 0) AS draws_total,
      COALESCE(f.no_contests, 0) AS no_contests,
      f.bout_count,
      f.last_fight_date,
      f.last_fight_result,
      f.last_fight_method,
      f.current_streak_type,
      f.current_streak_count,
      f.vertex_score,
      f.vertex_score_all_time,
      COALESCE(f.championship_pedigree, 0)::int AS championship_pedigree,
      COALESCE(f.is_dominant_champion, false) AS is_dominant_champion,
      COALESCE(f.ufc_total, 0)::int AS ufc_bouts
      ${divisionalSelect}
      ${matchScoreSelect}
      ${matchTierSelect}
    FROM fighter_with_stats f
    ${divisionalJoin}
    ${where}
    ORDER BY ${orderBy}
    OFFSET ${offset}
    LIMIT ${limit}
  `;

  const countQuery = sql`
    SELECT COUNT(*)::int AS total
    FROM fighter_with_stats f
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
  const isRu = await isRuLocale();
  const result = await db.execute<FighterCatalogRow>(sql`
    SELECT
      f.id::text AS id,
      f.slug,
      ${localizedNameSql("f", isRu)} AS name_en,
      f.name_ru,
      f.nickname,
      f.photo_url,
      f.photo_silhouette_url,
      f.photo_thumbnail_url,
      f.weight_class_primary::text AS weight_class_primary,
      f.country_code,
      f.stance::text AS stance,
      f.status::text AS status,
      f.roster_status::text AS roster_status,
      f.has_upcoming_bout,
      f.next_event_date,
      f.next_opponent_name,
      f.hall_of_fame_year,
      COALESCE(f.wins_total, 0) AS wins_total,
      COALESCE(f.losses_total, 0) AS losses_total,
      COALESCE(f.draws_total, 0) AS draws_total,
      COALESCE(f.no_contests, 0) AS no_contests,
      f.bout_count,
      f.last_fight_date,
      f.last_fight_result,
      f.last_fight_method,
      f.current_streak_type,
      f.current_streak_count,
      f.vertex_score,
      f.vertex_score_all_time,
      COALESCE(f.championship_pedigree, 0)::int AS championship_pedigree,
      COALESCE(f.is_dominant_champion, false) AS is_dominant_champion,
      COALESCE(f.ufc_total, 0)::int AS ufc_bouts,
      NULL::int AS divisional_score,
      NULL::text AS divisional_status
    FROM fighter_with_stats f
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
