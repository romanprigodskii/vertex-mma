import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  /** Wave 49: structured payload for client-side localization, or null for
   *  legacy rows (which render from the stored English title/body). */
  params: Record<string, unknown> | null;
  is_read: boolean;
  created_at: string;
};

export async function listNotifications(
  userProfileId: string,
  limit = 50,
): Promise<NotificationRow[]> {
  if (!UUID_RE.test(userProfileId)) return [];
  const rows = await db.execute<NotificationRow>(sql`
    SELECT
      id::text AS id,
      type,
      title,
      body,
      link,
      params,
      is_read,
      created_at::text AS created_at
    FROM notification
    WHERE user_id = ${userProfileId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  return rows as unknown as NotificationRow[];
}

export async function getUnreadCount(userProfileId: string): Promise<number> {
  if (!UUID_RE.test(userProfileId)) return 0;
  const rows = await db.execute<{ c: number }>(sql`
    SELECT COUNT(*)::int AS c FROM notification
    WHERE user_id = ${userProfileId}::uuid AND is_read = FALSE
  `);
  return (rows as unknown as Array<{ c: number }>)[0]?.c ?? 0;
}

export async function listRecentUnread(
  userProfileId: string,
  limit = 5,
): Promise<NotificationRow[]> {
  if (!UUID_RE.test(userProfileId)) return [];
  const rows = await db.execute<NotificationRow>(sql`
    SELECT
      id::text AS id,
      type,
      title,
      body,
      link,
      params,
      is_read,
      created_at::text AS created_at
    FROM notification
    WHERE user_id = ${userProfileId}::uuid AND is_read = FALSE
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  return rows as unknown as NotificationRow[];
}
