import type { MetadataRoute } from "next";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://vertexmma.com";

// localePrefix "as-needed": EN is unprefixed, RU lives under /ru. Emitting
// hreflang alternates tells search engines the two locales are the same page,
// so the RU half of the site stops being invisible / treated as duplicate.
function entry(
  path: string,
  rest: Omit<MetadataRoute.Sitemap[number], "url">,
): MetadataRoute.Sitemap[number] {
  return {
    url: `${SITE}${path}`,
    alternates: {
      languages: {
        en: `${SITE}${path}`,
        ru: `${SITE}/ru${path === "/" ? "" : path}`,
      },
    },
    ...rest,
  };
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const staticUrls: MetadataRoute.Sitemap = [
    entry("/", { lastModified: now, priority: 1.0 }),
    entry("/fighters", { lastModified: now, priority: 0.9 }),
    entry("/fighters/compare", { lastModified: now, priority: 0.6 }),
    entry("/events", { lastModified: now, priority: 0.8 }),
    entry("/markets", { lastModified: now, priority: 0.8 }),
    entry("/rankings", { lastModified: now, priority: 0.7 }),
    entry("/leaderboard", { lastModified: now, priority: 0.7 }),
    entry("/about", { lastModified: now, priority: 0.3 }),
    entry("/privacy", { lastModified: now, priority: 0.3 }),
    entry("/terms", { lastModified: now, priority: 0.3 }),
  ];

  let fighterUrls: MetadataRoute.Sitemap = [];
  let eventUrls: MetadataRoute.Sitemap = [];

  // DB queries are wrapped: a sitemap that returns 500 means Google
  // forgets every URL it knew. Better to ship the static ones and skip
  // the dynamic batch if the DB is briefly unavailable (e.g. during
  // first deploy before secrets are wired).
  try {
    const fighterRows = await db.execute<{ slug: string; date: string }>(sql`
      SELECT
        slug,
        COALESCE(updated_at, created_at)::text AS date
      FROM fighter
      WHERE roster_status = 'active'
      ORDER BY vertex_score DESC NULLS LAST
      LIMIT 500
    `);
    fighterUrls = (
      fighterRows as unknown as Array<{ slug: string; date: string }>
    ).map((f) =>
      entry(`/fighters/${f.slug}`, {
        lastModified: new Date(f.date),
        priority: 0.6,
      }),
    );

    const eventRows = await db.execute<{ slug: string; date: string }>(sql`
      SELECT slug, date::text AS date
      FROM event
      WHERE promotion = 'ufc'
        AND date > NOW() - INTERVAL '5 years'
      ORDER BY date DESC
      LIMIT 500
    `);
    eventUrls = (
      eventRows as unknown as Array<{ slug: string; date: string }>
    ).map((e) =>
      entry(`/events/${e.slug}`, {
        lastModified: new Date(e.date),
        priority: 0.5,
      }),
    );
  } catch (err) {
    console.warn(
      "sitemap: DB query failed, returning static URLs only:",
      err,
    );
  }

  return [...staticUrls, ...fighterUrls, ...eventUrls];
}
