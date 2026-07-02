import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";

import {
  getChampionshipReigns,
  type WeightClass,
} from "@/lib/championship-history";
import { db } from "@/lib/db";
import { isRuLocale, localizedNameSql } from "@/lib/i18n-name";

/**
 * Official Vertex rankings — every UFC division plus pound-for-pound, split
 * by gender, ranked purely by Vertex Score.
 *
 * Division boards mirror the catalog's single-weight ranking pool
 * (src/lib/fighter-search.ts, Wave 14B.2): the fighter_divisional_score
 * in_active_ranking rows PLUS a fallback for active fighters whose current
 * division is the board but who have no divisional row yet (<3 bouts there —
 * e.g. a freshly promoted champion), who rank on their global current score.
 * P4P boards use the canonical headline COALESCE(divisional current, global
 * current) with the same ordering as the homepage top-fighters list
 * (src/app/[locale]/page.tsx getTopFighters — keep the two in sync) so the
 * number always matches the profile hero.
 *
 * This is the editorial counterpart to the user-generated custom_ranking
 * lists that share the /rankings page.
 */

export interface OfficialBoard {
  /** URL-stable id used as the ?board= search param. */
  id: string;
  gender: "male" | "female";
  kind: "p4p" | "division";
  /** weight_class enum value for division boards; null for P4P. */
  division: WeightClass | null;
}

// Active UFC divisions per gender (women's featherweight is defunct).
// Women's divisions reuse the gender-agnostic weight_class enum values
// (project convention — same as championship-history.ts).
const MENS_DIVISIONS: readonly WeightClass[] = [
  "flyweight",
  "bantamweight",
  "featherweight",
  "lightweight",
  "welterweight",
  "middleweight",
  "light_heavyweight",
  "heavyweight",
];
const WOMENS_DIVISIONS: readonly WeightClass[] = [
  "strawweight",
  "flyweight",
  "bantamweight",
];

function divisionBoard(
  division: WeightClass,
  gender: "male" | "female",
): OfficialBoard {
  return {
    id:
      (gender === "female" ? "womens-" : "") + division.replace(/_/g, "-"),
    gender,
    kind: "division",
    division,
  };
}

// Presentation order mirrors ufc.com/rankings: men's P4P, men's divisions
// light-to-heavy, then the women's boards.
export const OFFICIAL_BOARDS: readonly OfficialBoard[] = [
  { id: "p4p", gender: "male", kind: "p4p", division: null },
  ...MENS_DIVISIONS.map((d) => divisionBoard(d, "male")),
  { id: "womens-p4p", gender: "female", kind: "p4p", division: null },
  ...WOMENS_DIVISIONS.map((d) => divisionBoard(d, "female")),
];

/** Validate a ?board= param against the whitelist; unknown values fall back
 *  to the default (men's P4P) instead of erroring. */
export function resolveBoard(param: string | undefined): OfficialBoard {
  if (!param) return OFFICIAL_BOARDS[0];
  return OFFICIAL_BOARDS.find((b) => b.id === param) ?? OFFICIAL_BOARDS[0];
}

// Type alias (not interface) so it satisfies db.execute's
// Record<string, unknown> constraint structurally.
export type OfficialRankingRow = {
  fighter_id: string;
  slug: string;
  name: string;
  country_code: string | null;
  photo_thumbnail_url: string | null;
  score: number;
  ufc_wins: number;
  ufc_losses: number;
  ufc_draws: number;
  ufc_total: number;
  current_streak_type: "W" | "L" | null;
  current_streak_count: number;
  divisional_status: string | null;
  /** The fighter's own division — populated on P4P boards only. */
  p4p_division: string | null;
};

async function fetchOfficialRanking(
  board: OfficialBoard,
  isRu: boolean,
  limit: number,
): Promise<OfficialRankingRow[]> {
  if (board.kind === "division") {
    // Two branches, mirroring the catalog's single-weight pool: divisional
    // rows first, then active fighters in this division without a divisional
    // row yet (<3 bouts — global current score). roster_status='active' also
    // keeps out released/retired fighters whose lingering scheduled bout
    // grants in_active_ranking (headline rule: retired ⇒ all-time, so a
    // decayed current score must never rank here).
    const rows = await db.execute<OfficialRankingRow>(sql`
      SELECT * FROM (
        SELECT
          f.id::text AS fighter_id,
          f.slug,
          ${localizedNameSql("f", isRu)} AS name,
          f.country_code,
          f.photo_thumbnail_url,
          fds.vertex_score::int AS score,
          f.ufc_wins,
          f.ufc_losses,
          f.ufc_draws,
          f.ufc_total,
          f.current_streak_type,
          f.current_streak_count,
          fds.divisional_status,
          NULL::text AS p4p_division,
          fds.bouts_in_division AS pool_bouts
        FROM fighter_divisional_score fds
        JOIN fighter_with_stats f ON f.id = fds.fighter_id
        WHERE fds.division = ${board.division}::weight_class
          AND fds.in_active_ranking = TRUE
          AND f.gender = ${board.gender}
          AND f.roster_status = 'active'
          AND fds.vertex_score IS NOT NULL

        UNION ALL

        SELECT
          f.id::text AS fighter_id,
          f.slug,
          ${localizedNameSql("f", isRu)} AS name,
          f.country_code,
          f.photo_thumbnail_url,
          f.vertex_score::int AS score,
          f.ufc_wins,
          f.ufc_losses,
          f.ufc_draws,
          f.ufc_total,
          f.current_streak_type,
          f.current_streak_count,
          NULL::text AS divisional_status,
          NULL::text AS p4p_division,
          0 AS pool_bouts
        FROM fighter_with_stats f
        WHERE f.roster_status = 'active'
          AND f.gender = ${board.gender}
          AND COALESCE(f.current_division, f.weight_class_primary::text) = ${board.division}
          AND f.vertex_score IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM fighter_divisional_score x
            WHERE x.fighter_id = f.id
              AND x.division = ${board.division}::weight_class
          )
      ) pool
      ORDER BY pool.score DESC,
               pool.pool_bouts DESC,
               pool.ufc_wins DESC,
               pool.slug ASC
      LIMIT ${limit}
    `);
    return rows as unknown as OfficialRankingRow[];
  }

  // P4P — the canonical headline coalesce (divisional current → global
  // current). Ordering matches the homepage getTopFighters query
  // (src/app/[locale]/page.tsx) tiebreak-for-tiebreak, plus a stable slug
  // tail, so the two surfaces can never rank tied fighters differently.
  const rows = await db.execute<OfficialRankingRow>(sql`
    SELECT
      f.id::text AS fighter_id,
      f.slug,
      ${localizedNameSql("f", isRu)} AS name,
      f.country_code,
      f.photo_thumbnail_url,
      COALESCE(fds.vertex_score, f.vertex_score)::int AS score,
      f.ufc_wins,
      f.ufc_losses,
      f.ufc_draws,
      f.ufc_total,
      f.current_streak_type,
      f.current_streak_count,
      fds.divisional_status,
      COALESCE(f.current_division, f.weight_class_primary::text) AS p4p_division
    FROM fighter_with_stats f
    LEFT JOIN fighter_divisional_score fds
      ON fds.fighter_id = f.id
     AND fds.division::text = f.current_division
     AND fds.in_active_ranking = TRUE
    WHERE f.roster_status = 'active'
      AND f.gender = ${board.gender}
      AND COALESCE(fds.vertex_score, f.vertex_score) IS NOT NULL
    ORDER BY COALESCE(fds.vertex_score, f.vertex_score) DESC,
             f.bout_count DESC,
             f.slug ASC
    LIMIT ${limit}
  `);
  return rows as unknown as OfficialRankingRow[];
}

// Scores only move when the daily rating recompute runs, so cache each
// board for an hour — same policy (and rationale) as the homepage
// getCachedTopFighters. Args (boardId, isRu, limit) are part of the key.
const cachedOfficialRanking = unstable_cache(
  async (boardId: string, isRu: boolean, limit: number) => {
    const board = OFFICIAL_BOARDS.find((b) => b.id === boardId);
    if (!board) return [];
    return fetchOfficialRanking(board, isRu, limit);
  },
  ["official-ranking"],
  { revalidate: 3600 },
);

export async function getOfficialRanking(
  board: OfficialBoard,
  limit = 15,
): Promise<OfficialRankingRow[]> {
  // Locale is request-scoped — resolve it OUTSIDE the cache boundary
  // (project unstable_cache convention) and pass it in as a key part.
  const isRu = await isRuLocale();
  return cachedOfficialRanking(board.id, isRu, limit);
}

/**
 * Active curated reign for a fighter, scoped to the board's division when
 * given (P4P passes null = any division). Sourced from championship-history,
 * never from the scraped bout.is_title_fight flag. Women's reigns reuse the
 * men's weight-class enum values, and the board rows are already gender-
 * filtered, so no extra gender check is needed here.
 */
export function championMark(
  slug: string,
  division: WeightClass | null,
): { isInterim: boolean } | null {
  const active = getChampionshipReigns(slug).filter(
    (r) =>
      r.endDate === null && (division === null || r.weightClass === division),
  );
  if (active.length === 0) return null;
  return { isInterim: active.every((r) => r.isInterim === true) };
}
