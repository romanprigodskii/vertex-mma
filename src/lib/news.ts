import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Human labels for the `news_classification` enum. */
export const NEWS_CLASSIFICATION_LABELS: Record<string, string> = {
  bout_announced: "Bout announced",
  bout_cancelled: "Bout cancelled",
  bout_changed: "Bout change",
  weigh_in: "Weigh-in",
  result: "Result",
  general_news: "News",
  rumor: "Rumor",
  unrelated: "Unrelated",
};

export function formatNewsClassification(value: string | null): string {
  return value ? (NEWS_CLASSIFICATION_LABELS[value] ?? value) : "News";
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  mdash: "—",
  ndash: "–",
};

/** Decode HTML entities — some feeds leave `&#43;` / `&amp;` in headlines. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (match, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X"
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? match;
  });
}

/** A short teaser for the feed list — first sentence or ~180 chars of body. */
function bodySnippet(body: string | null): string | null {
  if (!body) return null;
  const t = body.trim();
  if (!t) return null;
  if (t.length <= 200) return t;
  const period = t.indexOf(". ");
  if (period >= 80 && period <= 220) return t.slice(0, period + 1);
  const cut = t.slice(0, 200);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 100 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

export type NewsFighter = { id: string; slug: string; name: string };

export type NewsFeedItem = {
  id: string;
  url: string;
  title: string;
  snippet: string | null;
  published_at: string;
  classification: string;
  source_name: string;
  fighters: NewsFighter[];
};

export type NewsClassificationCount = {
  classification: string;
  count: number;
};

type FeedRow = {
  id: string;
  url: string;
  title: string;
  body_rephrased: string | null;
  published_at: string;
  classification: string | null;
  related_fighter_ids: string[] | null;
  source_name: string;
};

async function resolveNewsFighters(
  ids: string[],
): Promise<Map<string, NewsFighter>> {
  const unique = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  if (unique.length === 0) return new Map();
  const values = sql.join(
    unique.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute<{
    id: string;
    slug: string;
    name_en: string;
  }>(sql`
    SELECT id::text AS id, slug, name_en
    FROM fighter
    WHERE id IN (${values})
  `)) as unknown as Array<{ id: string; slug: string; name_en: string }>;
  const map = new Map<string, NewsFighter>();
  for (const r of rows) {
    map.set(r.id, { id: r.id, slug: r.slug, name: r.name_en });
  }
  return map;
}

function toFeedItem(row: FeedRow, fighters: NewsFighter[]): NewsFeedItem {
  return {
    id: row.id,
    url: row.url,
    title: decodeEntities(row.title),
    snippet: bodySnippet(row.body_rephrased),
    published_at: row.published_at,
    classification: row.classification ?? "general_news",
    source_name: row.source_name,
    fighters,
  };
}

const FEED_SELECT = sql`
  SELECT
    ni.id::text AS id,
    ni.url,
    ni.title,
    ni.body_rephrased,
    ni.published_at::text AS published_at,
    ni.classification::text AS classification,
    ni.related_fighter_ids,
    ns.name AS source_name
  FROM news_item ni
  JOIN news_source ns ON ns.id = ni.source_id
`;

/** Approved news, newest first, optionally filtered to one classification. */
export async function listNewsFeed(
  opts: { classification?: string; limit?: number } = {},
): Promise<NewsFeedItem[]> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 150));
  const cls =
    opts.classification && opts.classification in NEWS_CLASSIFICATION_LABELS
      ? opts.classification
      : undefined;
  const where = cls
    ? sql`AND ni.classification = ${cls}::news_classification`
    : sql``;

  const rows = (await db.execute<FeedRow>(sql`
    ${FEED_SELECT}
    WHERE ni.status IN ('approved', 'auto_approved')
    ${where}
    ORDER BY ni.published_at DESC
    LIMIT ${limit}
  `)) as unknown as FeedRow[];

  const fighters = await resolveNewsFighters(
    rows.flatMap((r) => r.related_fighter_ids ?? []),
  );
  return rows.map((r) =>
    toFeedItem(
      r,
      (r.related_fighter_ids ?? [])
        .map((id) => fighters.get(id))
        .filter((f): f is NewsFighter => f !== undefined),
    ),
  );
}

/** Approved-news counts per classification — drives the feed's filter chips. */
export async function getNewsClassificationCounts(): Promise<
  NewsClassificationCount[]
> {
  const rows = (await db.execute<NewsClassificationCount>(sql`
    SELECT classification::text AS classification, COUNT(*)::int AS count
    FROM news_item
    WHERE status IN ('approved', 'auto_approved')
      AND classification IS NOT NULL
    GROUP BY classification
    ORDER BY count DESC
  `)) as unknown as NewsClassificationCount[];
  return rows;
}

/** Approved news mentioning a given fighter. Chips are omitted — the reader
 *  is already on that fighter's page. */
export async function listNewsForFighter(
  fighterId: string,
  limit = 6,
): Promise<NewsFeedItem[]> {
  if (!UUID_RE.test(fighterId)) return [];
  const rows = (await db.execute<FeedRow>(sql`
    ${FEED_SELECT}
    WHERE ni.status IN ('approved', 'auto_approved')
      AND ${fighterId}::uuid = ANY(ni.related_fighter_ids)
    ORDER BY ni.published_at DESC
    LIMIT ${Math.min(20, Math.max(1, limit))}
  `)) as unknown as FeedRow[];
  return rows.map((r) => toFeedItem(r, []));
}

export type NewsItemDetail = {
  id: string;
  url: string;
  title: string;
  body: string | null;
  body_rephrased: string | null;
  published_at: string;
  classification: string;
  source_name: string;
  source_url: string | null;
  fighters: NewsFighter[];
};

type DetailRow = {
  id: string;
  url: string;
  title: string;
  body: string | null;
  body_rephrased: string | null;
  published_at: string;
  classification: string | null;
  related_fighter_ids: string[] | null;
  source_name: string;
  source_url: string | null;
};

/** A single approved news item with everything the article page needs. */
export async function getNewsItemById(
  id: string,
): Promise<NewsItemDetail | null> {
  if (!UUID_RE.test(id)) return null;
  const rows = (await db.execute<DetailRow>(sql`
    SELECT
      ni.id::text AS id,
      ni.url,
      ni.title,
      ni.body,
      ni.body_rephrased,
      ni.published_at::text AS published_at,
      ni.classification::text AS classification,
      ni.related_fighter_ids,
      ns.name AS source_name,
      ns.url AS source_url
    FROM news_item ni
    JOIN news_source ns ON ns.id = ni.source_id
    WHERE ni.id = ${id}::uuid
      AND ni.status IN ('approved', 'auto_approved')
    LIMIT 1
  `)) as unknown as DetailRow[];

  if (rows.length === 0) return null;
  const r = rows[0];

  const fighterMap = await resolveNewsFighters(r.related_fighter_ids ?? []);
  const fighters = (r.related_fighter_ids ?? [])
    .map((fid) => fighterMap.get(fid))
    .filter((f): f is NewsFighter => f !== undefined);

  return {
    id: r.id,
    url: r.url,
    title: decodeEntities(r.title),
    body: r.body,
    body_rephrased: r.body_rephrased,
    published_at: r.published_at,
    classification: r.classification ?? "general_news",
    source_name: r.source_name,
    source_url: r.source_url,
    fighters,
  };
}
