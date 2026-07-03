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

/** Board era driven by the ?mode= search param. CURRENT ranks the active
 *  pool by current Vertex Score; ALL-TIME ranks every fighter ever (≥3 UFC
 *  bouts, retired legends included) by vertex_score_all_time, with the
 *  division boards pooled on weight_class_primary. */
export type BoardMode = "current" | "all_time";

/** Validate a ?mode= param; unknown values fall back to current. */
export function resolveMode(param: string | undefined): BoardMode {
  return param === "all-time" ? "all_time" : "current";
}

/** Progressive board disclosure driven by the ?depth= search param:
 *  top-15 (default) → top-50 → the whole ranking pool. */
export type BoardDepth = 15 | 50 | "all";

/** Sanity cap for depth="all" — the largest division pool is ~70 fighters
 *  and a P4P "all" is the full active roster per gender (~400). */
export const ALL_DEPTH_CAP = 500;

/** Validate a ?depth= param; unknown values fall back to the default 15. */
export function resolveDepth(param: string | undefined): BoardDepth {
  if (param === "50") return 50;
  if (param === "all") return "all";
  return 15;
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
  mode: BoardMode,
): Promise<OfficialRankingRow[]> {
  if (mode === "all_time") {
    return fetchAllTimeRanking(board, isRu, limit);
  }
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
          -- Pin to the fighter's LIVE current division: the materialize
          -- script guarantees this within one successful pipeline run, but
          -- a mid-chain abort can leave yesterday's divisional row while
          -- current_division already moved — the profile hero would then
          -- show the global score while this board showed the stale
          -- divisional one (audit fix).
          AND fds.division::text = f.current_division
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

/** ALL-TIME boards: every fighter with an all-time score (≥3 UFC bouts,
 *  retired included), pooled on weight_class_primary for divisions.
 *  vertex_score_all_time is raw (can exceed 100 for sort order) — sort on
 *  the raw value, display the clamped one (clampHeadline convention), so
 *  ties are computed on the number users actually see. */
async function fetchAllTimeRanking(
  board: OfficialBoard,
  isRu: boolean,
  limit: number,
): Promise<OfficialRankingRow[]> {
  const divisionFilter =
    board.kind === "division"
      ? sql`AND f.weight_class_primary::text = ${board.division}`
      : sql``;
  const rows = await db.execute<OfficialRankingRow>(sql`
    SELECT
      f.id::text AS fighter_id,
      f.slug,
      ${localizedNameSql("f", isRu)} AS name,
      f.country_code,
      f.photo_thumbnail_url,
      LEAST(100, GREATEST(0, ROUND(f.vertex_score_all_time)))::int AS score,
      f.ufc_wins,
      f.ufc_losses,
      f.ufc_draws,
      f.ufc_total,
      f.current_streak_type,
      f.current_streak_count,
      NULL::text AS divisional_status,
      ${
        // weight_class_primary, NOT current_division: the all-time DIVISION
        // boards pool on primary, so the P4P tag must point at the board
        // the fighter actually appears on (audit fix — a retired legend's
        // current_division tracks their last bout, possibly a one-off).
        board.kind === "p4p"
          ? sql`f.weight_class_primary::text`
          : sql`NULL::text`
      } AS p4p_division
    FROM fighter_with_stats f
    WHERE f.gender = ${board.gender}
      AND f.vertex_score_all_time IS NOT NULL
      ${divisionFilter}
    ORDER BY f.vertex_score_all_time DESC,
             f.ufc_wins DESC,
             f.slug ASC
    LIMIT ${limit}
  `);
  return rows as unknown as OfficialRankingRow[];
}

// Scores only move when the daily rating recompute runs, so cache each
// board for an hour — same policy (and rationale) as the homepage
// getCachedTopFighters. Args (boardId, isRu, limit, mode) are part of
// the key.
const cachedOfficialRanking = unstable_cache(
  async (boardId: string, isRu: boolean, limit: number, mode: BoardMode) => {
    const board = OFFICIAL_BOARDS.find((b) => b.id === boardId);
    if (!board) return [];
    return fetchOfficialRanking(board, isRu, limit, mode);
  },
  ["official-ranking"],
  { revalidate: 3600 },
);

export async function getOfficialRanking(
  board: OfficialBoard,
  limit = 15,
  mode: BoardMode = "current",
): Promise<OfficialRankingRow[]> {
  // Locale is request-scoped — resolve it OUTSIDE the cache boundary
  // (project unstable_cache convention) and pass it in as a key part.
  const isRu = await isRuLocale();
  return cachedOfficialRanking(board.id, isRu, limit, mode);
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

/** ALL-TIME boards crown anyone who EVER held the belt in the division
 *  (any reign, open or closed); interim-only holders get the interim mark. */
export function championMarkAllTime(
  slug: string,
  division: WeightClass | null,
): { isInterim: boolean } | null {
  const reigns = getChampionshipReigns(slug).filter(
    (r) => division === null || r.weightClass === division,
  );
  if (reigns.length === 0) return null;
  return { isInterim: reigns.every((r) => r.isInterim === true) };
}
