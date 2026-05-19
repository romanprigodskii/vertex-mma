import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import type { SimulationResult } from "@/lib/db/schema/simulations";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SimulationFighter = {
  id: string;
  slug: string;
  name_en: string;
  photo_url: string | null;
  photo_thumbnail_url: string | null;
  country_code: string | null;
  vertex_score: number | null;
};

export type SimulationDetail = {
  id: string;
  result: SimulationResult;
  fighter_a: SimulationFighter;
  fighter_b: SimulationFighter;
  author_username: string | null;
  is_public: boolean;
  view_count: number;
  share_count: number;
  created_at: string;
};

export async function getSimulationById(
  id: string,
): Promise<SimulationDetail | null> {
  if (!UUID_RE.test(id)) return null;

  const rows = await db.execute<{
    id: string;
    result: SimulationResult;
    is_public: boolean;
    view_count: number;
    share_count: number;
    created_at: string;
    a_id: string;
    a_slug: string;
    a_name: string;
    a_photo: string | null;
    a_thumb: string | null;
    a_country: string | null;
    a_vertex: number | null;
    b_id: string;
    b_slug: string;
    b_name: string;
    b_photo: string | null;
    b_thumb: string | null;
    b_country: string | null;
    b_vertex: number | null;
    author_username: string | null;
  }>(sql`
    SELECT
      s.id::text AS id,
      s.result,
      s.is_public,
      s.view_count,
      s.share_count,
      s.created_at::text AS created_at,
      fa.id::text   AS a_id,
      fa.slug       AS a_slug,
      fa.name_en    AS a_name,
      fa.photo_url  AS a_photo,
      fa.photo_thumbnail_url AS a_thumb,
      fa.country_code AS a_country,
      fa.vertex_score AS a_vertex,
      fb.id::text   AS b_id,
      fb.slug       AS b_slug,
      fb.name_en    AS b_name,
      fb.photo_url  AS b_photo,
      fb.photo_thumbnail_url AS b_thumb,
      fb.country_code AS b_country,
      fb.vertex_score AS b_vertex,
      up.username   AS author_username
    FROM simulation s
    JOIN fighter fa ON fa.id = s.fighter_a_id
    JOIN fighter fb ON fb.id = s.fighter_b_id
    LEFT JOIN user_profile up ON up.id = s.user_id
    WHERE s.id = ${id}::uuid
    LIMIT 1
  `);
  const r = (rows as unknown as Array<{
    id: string;
    result: SimulationResult;
    is_public: boolean;
    view_count: number;
    share_count: number;
    created_at: string;
    a_id: string;
    a_slug: string;
    a_name: string;
    a_photo: string | null;
    a_thumb: string | null;
    a_country: string | null;
    a_vertex: number | null;
    b_id: string;
    b_slug: string;
    b_name: string;
    b_photo: string | null;
    b_thumb: string | null;
    b_country: string | null;
    b_vertex: number | null;
    author_username: string | null;
  }>)[0];
  if (!r) return null;

  return {
    id: r.id,
    result: r.result,
    is_public: r.is_public,
    view_count: r.view_count,
    share_count: r.share_count,
    created_at: r.created_at,
    author_username: r.author_username,
    fighter_a: {
      id: r.a_id,
      slug: r.a_slug,
      name_en: r.a_name,
      photo_url: r.a_photo,
      photo_thumbnail_url: r.a_thumb,
      country_code: r.a_country,
      vertex_score: r.a_vertex,
    },
    fighter_b: {
      id: r.b_id,
      slug: r.b_slug,
      name_en: r.b_name,
      photo_url: r.b_photo,
      photo_thumbnail_url: r.b_thumb,
      country_code: r.b_country,
      vertex_score: r.b_vertex,
    },
  };
}

export type UserSimulationRow = {
  id: string;
  created_at: string;
  result: SimulationResult;
  a_name: string;
  b_name: string;
};

export async function listUserSimulations(
  userProfileId: string,
  limit = 20,
): Promise<UserSimulationRow[]> {
  if (!UUID_RE.test(userProfileId)) return [];
  const rows = await db.execute<UserSimulationRow>(sql`
    SELECT
      s.id::text AS id,
      s.created_at::text AS created_at,
      s.result,
      fa.name_en AS a_name,
      fb.name_en AS b_name
    FROM simulation s
    JOIN fighter fa ON fa.id = s.fighter_a_id
    JOIN fighter fb ON fb.id = s.fighter_b_id
    WHERE s.user_id = ${userProfileId}::uuid
    ORDER BY s.created_at DESC
    LIMIT ${limit}
  `);
  return rows as unknown as UserSimulationRow[];
}
