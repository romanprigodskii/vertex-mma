import "server-only";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { cleanNewsTitle } from "@/lib/news";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strip HTML entities the same way the public feed does — kept local to avoid
 *  exporting the private helper from news.ts. Mirrors news.ts decodeEntities. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "’")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#x?[0-9a-f]+;/gi, (m) => {
      const isHex = /&#x/i.test(m);
      const code = parseInt(m.replace(/&#x?|;/gi, ""), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    });
}

function moderationSnippet(body: string | null): string | null {
  if (!body) return null;
  const t = decodeEntities(body).trim();
  if (!t) return null;
  if (t.length <= 480) return t;
  const cut = t.slice(0, 480);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 240 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

export type PendingNewsItem = {
  id: string;
  url: string;
  title: string;
  snippet: string | null;
  published_at: string;
  classification: string;
  confidence: number | null;
  source_name: string;
  is_trusted: boolean;
  image_url: string | null;
};

type PendingRow = {
  id: string;
  url: string;
  title: string;
  body: string | null;
  published_at: string;
  classification: string | null;
  confidence: number | null;
  source_name: string;
  is_trusted: boolean;
  image_url: string | null;
};

/** Pending news awaiting a staff decision, newest first. Staff-only; returns
 *  empty for non-staff so callers never leak the moderation queue. Shows the
 *  English title and the rephrased body when one exists (falling back to the
 *  raw body) — pending items usually aren't rephrased or translated yet. */
export async function getPendingNewsItems(
  limit = 100,
  offset = 0,
): Promise<PendingNewsItem[]> {
  const user = await getCurrentUser();
  if (!user?.isStaff) return [];

  const rows = (await db.execute<PendingRow>(sql`
    SELECT
      ni.id::text AS id,
      ni.url,
      ni.title,
      COALESCE(ni.body_rephrased, ni.body) AS body,
      ni.published_at::text AS published_at,
      ni.classification::text AS classification,
      ni.confidence,
      ns.name AS source_name,
      ns.is_trusted,
      ni.image_url
    FROM news_item ni
    JOIN news_source ns ON ns.id = ni.source_id
    WHERE ni.status = 'pending'
    ORDER BY ni.published_at DESC
    LIMIT ${Math.min(300, Math.max(1, limit))}
    OFFSET ${Math.max(0, offset)}
  `)) as unknown as PendingRow[];

  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    title: cleanNewsTitle(decodeEntities(r.title)),
    snippet: moderationSnippet(r.body),
    published_at: r.published_at,
    classification: r.classification ?? "general_news",
    confidence: r.confidence,
    source_name: r.source_name,
    is_trusted: r.is_trusted,
    image_url: r.image_url ?? null,
  }));
}

/** Count of items in the pending queue. Staff-only (0 otherwise). */
export async function getPendingNewsCount(): Promise<number> {
  const user = await getCurrentUser();
  if (!user?.isStaff) return 0;
  const rows = (await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count FROM news_item WHERE status = 'pending'
  `)) as unknown as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

export type ModerationResult = { ok: boolean; error?: string };

/**
 * Staff decision on a pending news item. 'approve' publishes it (the rephrase
 * + RU-translate cron pick it up on the next run, the same path auto-approved
 * items take); 'reject' hides it permanently. Idempotent: only transitions
 * rows still in 'pending', so a double-click is a harmless no-op.
 */
export async function moderateNewsItem(
  id: string,
  decision: "approve" | "reject",
): Promise<ModerationResult> {
  if (!UUID_RE.test(id)) return { ok: false, error: "Bad id" };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Sign in" };
  if (!user.isStaff) return { ok: false, error: "Staff only" };

  const status = decision === "approve" ? "approved" : "rejected";
  try {
    await db.execute(sql`
      UPDATE news_item
      SET status = ${status}::news_status
      WHERE id = ${id}::uuid AND status = 'pending'
    `);
  } catch {
    return { ok: false, error: "Update failed" };
  }

  revalidatePath("/admin/news");
  if (decision === "approve") revalidatePath("/news");
  return { ok: true };
}
