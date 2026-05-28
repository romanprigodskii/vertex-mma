import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { isRuLocale, localizedNameSql } from "@/lib/i18n-name";
import type { FightCardBout } from "@/lib/db/schema/cards";

// Snake-case shapes mirror the raw column names returned by db.execute.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PosterFighter = {
  id: string;
  slug: string;
  name: string;
  photo_thumbnail_url: string | null;
  country_code: string | null;
  record: string | null;
};

export type PosterBout = {
  order: number;
  weight_class: string;
  is_main: boolean;
  fighter_a: PosterFighter | null;
  fighter_b: PosterFighter | null;
};

export type FightCardListItem = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  theme_color: string;
  title_font: string;
  background_id: string;
  is_public: boolean;
  bout_count: number;
  like_count: number;
  view_count: number;
  created_at: string;
  author_username: string;
  author_display_name: string | null;
  author_avatar_url: string | null;
  headliner: { fighter_a: string; fighter_b: string } | null;
};

export type FightCardDetail = {
  id: string;
  slug: string;
  user_id: string;
  title: string;
  subtitle: string | null;
  theme_color: string;
  title_font: string;
  background_id: string;
  is_public: boolean;
  like_count: number;
  view_count: number;
  created_at: string;
  author_username: string;
  author_display_name: string | null;
  author_avatar_url: string | null;
  bouts: PosterBout[];
};

type CardRow = {
  id: string;
  slug: string;
  user_id: string;
  title: string;
  subtitle: string | null;
  theme_color: string | null;
  title_font: string | null;
  background_id: string | null;
  is_public: boolean;
  like_count: number;
  view_count: number;
  created_at: string;
  bouts: FightCardBout[] | null;
  author_username: string;
  author_display_name: string | null;
  author_avatar_url: string | null;
};

type FighterRow = {
  id: string;
  slug: string;
  name_en: string;
  photo_thumbnail_url: string | null;
  country_code: string | null;
  wins_total: number | null;
  losses_total: number | null;
  draws_total: number | null;
};

/** One query resolves every bout fighter ID to its display data. */
async function resolveFighters(
  ids: string[],
): Promise<Map<string, PosterFighter>> {
  const unique = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  if (unique.length === 0) return new Map();
  const values = sql.join(
    unique.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const isRu = await isRuLocale();
  const rows = (await db.execute<FighterRow>(sql`
    SELECT
      f.id::text AS id,
      f.slug,
      ${localizedNameSql("f", isRu)} AS name_en,
      f.photo_thumbnail_url,
      f.country_code,
      f.wins_total,
      f.losses_total,
      f.draws_total
    FROM fighter_with_stats f
    WHERE f.id IN (${values})
  `)) as unknown as FighterRow[];

  const map = new Map<string, PosterFighter>();
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      slug: r.slug,
      name: r.name_en,
      photo_thumbnail_url: r.photo_thumbnail_url,
      country_code: r.country_code,
      record:
        r.wins_total != null
          ? `${r.wins_total}-${r.losses_total ?? 0}-${r.draws_total ?? 0}`
          : null,
    });
  }
  return map;
}

function sortedBouts(raw: FightCardBout[] | null): FightCardBout[] {
  return [...(raw ?? [])].sort((a, b) => a.order - b.order);
}

const CARD_SELECT = sql`
  SELECT
    fc.id::text AS id,
    fc.slug,
    fc.user_id::text AS user_id,
    fc.title,
    fc.subtitle,
    fc.theme_color,
    fc.title_font,
    fc.background_id,
    fc.is_public,
    fc.like_count,
    fc.view_count,
    fc.created_at::text AS created_at,
    fc.bouts,
    up.username AS author_username,
    up.display_name AS author_display_name,
    up.avatar_url AS author_avatar_url
  FROM fight_card fc
  JOIN user_profile up ON up.id = fc.user_id
`;

async function queryCards(
  where: SQL,
  limit: number,
): Promise<FightCardListItem[]> {
  const rows = (await db.execute<CardRow>(sql`
    ${CARD_SELECT}
    ${where}
    ORDER BY fc.created_at DESC
    LIMIT ${limit}
  `)) as unknown as CardRow[];

  // Resolve only the headliner of each card, in a single fighter query.
  const headlinerByCard = new Map<string, FightCardBout>();
  for (const row of rows) {
    const bouts = sortedBouts(row.bouts);
    const headliner = bouts.find((b) => b.isMain) ?? bouts[0];
    if (headliner) headlinerByCard.set(row.id, headliner);
  }
  const fighters = await resolveFighters(
    [...headlinerByCard.values()].flatMap((b) => [b.fighterAId, b.fighterBId]),
  );

  return rows.map((row) => {
    const headliner = headlinerByCard.get(row.id);
    const a = headliner ? fighters.get(headliner.fighterAId) : undefined;
    const b = headliner ? fighters.get(headliner.fighterBId) : undefined;
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      subtitle: row.subtitle,
      theme_color: row.theme_color ?? "primary",
      title_font: row.title_font ?? "display",
      background_id: row.background_id ?? "default",
      is_public: row.is_public,
      bout_count: (row.bouts ?? []).length,
      like_count: row.like_count,
      view_count: row.view_count,
      created_at: row.created_at,
      author_username: row.author_username,
      author_display_name: row.author_display_name,
      author_avatar_url: row.author_avatar_url,
      headliner:
        a && b ? { fighter_a: a.name, fighter_b: b.name } : null,
    };
  });
}

export function listPublicCards(limit = 30): Promise<FightCardListItem[]> {
  return queryCards(sql`WHERE fc.is_public = true`, limit);
}

export function listCardsByUser(
  userProfileId: string,
): Promise<FightCardListItem[]> {
  if (!UUID_RE.test(userProfileId)) return Promise.resolve([]);
  return queryCards(sql`WHERE fc.user_id = ${userProfileId}::uuid`, 100);
}

export async function getFightCardBySlug(
  slug: string,
): Promise<FightCardDetail | null> {
  const trimmed = slug.trim();
  if (!trimmed) return null;
  const rows = (await db.execute<CardRow>(sql`
    ${CARD_SELECT}
    WHERE fc.slug = ${trimmed}
    LIMIT 1
  `)) as unknown as CardRow[];
  if (rows.length === 0) return null;
  const row = rows[0];

  const bouts = sortedBouts(row.bouts);
  const fighters = await resolveFighters(
    bouts.flatMap((b) => [b.fighterAId, b.fighterBId]),
  );

  return {
    id: row.id,
    slug: row.slug,
    user_id: row.user_id,
    title: row.title,
    subtitle: row.subtitle,
    theme_color: row.theme_color ?? "primary",
    title_font: row.title_font ?? "display",
    background_id: row.background_id ?? "default",
    is_public: row.is_public,
    like_count: row.like_count,
    view_count: row.view_count,
    created_at: row.created_at,
    author_username: row.author_username,
    author_display_name: row.author_display_name,
    author_avatar_url: row.author_avatar_url,
    bouts: bouts.map((b) => ({
      order: b.order,
      weight_class: b.weightClass,
      is_main: b.isMain,
      fighter_a: fighters.get(b.fighterAId) ?? null,
      fighter_b: fighters.get(b.fighterBId) ?? null,
    })),
  };
}

export async function hasUserLikedCard(
  userProfileId: string,
  cardId: string,
): Promise<boolean> {
  if (!UUID_RE.test(userProfileId) || !UUID_RE.test(cardId)) return false;
  const rows = (await db.execute<{ liked: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM fight_card_like
      WHERE user_id = ${userProfileId}::uuid
        AND fight_card_id = ${cardId}::uuid
    ) AS liked
  `)) as unknown as Array<{ liked: boolean }>;
  return rows[0]?.liked ?? false;
}

export async function incrementCardViewCount(id: string): Promise<void> {
  if (!UUID_RE.test(id)) return;
  await db.execute(
    sql`UPDATE fight_card SET view_count = view_count + 1 WHERE id = ${id}::uuid`,
  );
}
