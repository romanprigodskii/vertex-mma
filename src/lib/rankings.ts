import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { isRuLocale, localizedNameSql } from "@/lib/i18n-name";
import { displayDivision } from "@/lib/vertex-tier";

// Snake-case shapes mirror the raw column names returned by db.execute.

export type RankingListItem = {
  id: string;
  title: string;
  description: string | null;
  created_at: string;
  author_username: string;
  author_display_name: string | null;
  author_avatar_url: string | null;
  entry_count: number;
};

export type RankingEntryRow = {
  id: string;
  position: number;
  note: string | null;
  fighter_id: string;
  fighter_slug: string;
  fighter_name: string;
  fighter_photo_thumbnail_url: string | null;
  fighter_country_code: string | null;
  fighter_weight_class: string | null;
};

export type RankingDetail = RankingListItem & {
  user_id: string;
  entries: RankingEntryRow[];
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listRecentRankings(
  limit = 30,
): Promise<RankingListItem[]> {
  const rows = await db.execute<RankingListItem>(sql`
    SELECT
      r.id::text AS id,
      r.title,
      r.description,
      r.created_at::text AS created_at,
      up.username AS author_username,
      up.display_name AS author_display_name,
      up.avatar_url AS author_avatar_url,
      (SELECT COUNT(*)::int FROM custom_ranking_entry WHERE ranking_id = r.id) AS entry_count
    FROM custom_ranking r
    JOIN user_profile up ON up.id = r.user_id
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `);
  return rows as unknown as RankingListItem[];
}

export async function listRankingsByUser(
  userProfileId: string,
): Promise<RankingListItem[]> {
  if (!UUID_RE.test(userProfileId)) return [];
  const rows = await db.execute<RankingListItem>(sql`
    SELECT
      r.id::text AS id,
      r.title,
      r.description,
      r.created_at::text AS created_at,
      up.username AS author_username,
      up.display_name AS author_display_name,
      up.avatar_url AS author_avatar_url,
      (SELECT COUNT(*)::int FROM custom_ranking_entry WHERE ranking_id = r.id) AS entry_count
    FROM custom_ranking r
    JOIN user_profile up ON up.id = r.user_id
    WHERE r.user_id = ${userProfileId}::uuid
    ORDER BY r.created_at DESC
  `);
  return rows as unknown as RankingListItem[];
}

export async function getRankingById(
  id: string,
): Promise<RankingDetail | null> {
  if (!UUID_RE.test(id)) return null;

  const rankingRows = await db.execute<{
    id: string;
    user_id: string;
    title: string;
    description: string | null;
    created_at: string;
    author_username: string;
    author_display_name: string | null;
    author_avatar_url: string | null;
  }>(sql`
    SELECT
      r.id::text AS id,
      r.user_id::text AS user_id,
      r.title,
      r.description,
      r.created_at::text AS created_at,
      up.username AS author_username,
      up.display_name AS author_display_name,
      up.avatar_url AS author_avatar_url
    FROM custom_ranking r
    JOIN user_profile up ON up.id = r.user_id
    WHERE r.id = ${id}::uuid
    LIMIT 1
  `);
  if (rankingRows.length === 0) return null;
  const r = rankingRows[0];

  const isRu = await isRuLocale();
  type RawEntryRow = Omit<RankingEntryRow, "fighter_weight_class"> & {
    roster_status: string | null;
    current_division: string | null;
    weight_class_primary: string | null;
  };
  const entries = await db.execute<RawEntryRow>(sql`
    SELECT
      cre.id::text AS id,
      cre.position,
      cre.note,
      f.id::text AS fighter_id,
      f.slug AS fighter_slug,
      ${localizedNameSql("f", isRu)} AS fighter_name,
      f.photo_thumbnail_url AS fighter_photo_thumbnail_url,
      f.country_code AS fighter_country_code,
      f.roster_status::text AS roster_status,
      f.current_division,
      f.weight_class_primary::text AS weight_class_primary
    FROM custom_ranking_entry cre
    JOIN fighter f ON f.id = cre.fighter_id
    WHERE cre.ranking_id = ${id}::uuid
    ORDER BY cre.position ASC
  `);

  // Labelled like every other fighter surface (displayDivision), not by
  // weight_class_primary — a champion who moved up is ranked under the belt
  // they hold now.
  const entryRows: RankingEntryRow[] = (
    entries as unknown as RawEntryRow[]
  ).map(({ roster_status, current_division, weight_class_primary, ...e }) => ({
    ...e,
    fighter_weight_class: displayDivision({
      rosterStatus: roster_status,
      currentDivision: current_division,
      weightClassPrimary: weight_class_primary,
    }),
  }));

  return {
    id: r.id,
    user_id: r.user_id,
    title: r.title,
    description: r.description,
    created_at: r.created_at,
    author_username: r.author_username,
    author_display_name: r.author_display_name,
    author_avatar_url: r.author_avatar_url,
    entry_count: entryRows.length,
    entries: entryRows,
  };
}
