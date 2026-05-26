import "server-only";

import { revalidatePath } from "next/cache";
import { and, asc, desc, eq, isNull, gt } from "drizzle-orm";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { newsComment } from "@/lib/db/schema/news";
import { userProfile } from "@/lib/db/schema/users";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CommentAuthor = {
  userProfileId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  tier: string;
};

export type CommentNode = {
  id: string;
  body: string;
  upvotes: number;
  downvotes: number;
  createdAt: string;
  author: CommentAuthor;
  replies: CommentNode[];
};

export async function listCommentsForNews(
  newsItemId: string,
): Promise<{ comments: CommentNode[]; total: number }> {
  if (!UUID_RE.test(newsItemId)) return { comments: [], total: 0 };

  // news_comment table is created by Wave 6 push; before that the page still
  // renders with an empty thread instead of crashing.
  let rows: Array<{
    id: string;
    parentId: string | null;
    body: string;
    upvotes: number;
    downvotes: number;
    createdAt: Date;
    deletedAt: Date | null;
    userProfileId: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    tier: string;
  }>;
  try {
    rows = await db
      .select({
        id: newsComment.id,
        parentId: newsComment.parentId,
        body: newsComment.body,
        upvotes: newsComment.upvotes,
        downvotes: newsComment.downvotes,
        createdAt: newsComment.createdAt,
        deletedAt: newsComment.deletedAt,
        userProfileId: userProfile.id,
        username: userProfile.username,
        displayName: userProfile.displayName,
        avatarUrl: userProfile.avatarUrl,
        tier: userProfile.tier,
      })
      .from(newsComment)
      .innerJoin(userProfile, eq(userProfile.id, newsComment.userProfileId))
      .where(
        and(
          eq(newsComment.newsItemId, newsItemId),
          isNull(newsComment.deletedAt),
        ),
      )
      .orderBy(desc(newsComment.createdAt));
  } catch {
    return { comments: [], total: 0 };
  }

  const byId = new Map<string, CommentNode>();
  const tops: CommentNode[] = [];
  const replyBuckets = new Map<string, CommentNode[]>();

  for (const r of rows) {
    const node: CommentNode = {
      id: r.id,
      body: r.body,
      upvotes: r.upvotes,
      downvotes: r.downvotes,
      createdAt: r.createdAt.toISOString(),
      author: {
        userProfileId: r.userProfileId,
        username: r.username,
        displayName: r.displayName,
        avatarUrl: r.avatarUrl,
        tier: r.tier,
      },
      replies: [],
    };
    byId.set(node.id, node);
    if (r.parentId) {
      const bucket = replyBuckets.get(r.parentId) ?? [];
      bucket.push(node);
      replyBuckets.set(r.parentId, bucket);
    } else {
      tops.push(node);
    }
  }

  for (const top of tops) {
    const replies = replyBuckets.get(top.id) ?? [];
    // Replies oldest-first so the conversation reads top → bottom.
    replies.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    top.replies = replies;
  }

  return { comments: tops, total: rows.length };
}

const RATE_LIMIT_SECONDS = 10;

export type AddCommentResult =
  | { ok: true; commentId: string }
  | { ok: false; error: string };

export async function addNewsComment(opts: {
  newsItemId: string;
  parentId: string | null;
  body: string;
}): Promise<AddCommentResult> {
  if (!UUID_RE.test(opts.newsItemId)) {
    return { ok: false, error: "Bad article" };
  }
  if (opts.parentId !== null && !UUID_RE.test(opts.parentId)) {
    return { ok: false, error: "Bad reply target" };
  }

  const trimmed = opts.body.trim();
  if (trimmed.length === 0) return { ok: false, error: "Empty comment" };
  if (trimmed.length > 2000)
    return { ok: false, error: "Too long (2000 char max)" };

  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Sign in to comment" };

  const recent = await db
    .select({ id: newsComment.id })
    .from(newsComment)
    .where(
      and(
        eq(newsComment.userProfileId, user.userProfileId),
        gt(
          newsComment.createdAt,
          new Date(Date.now() - RATE_LIMIT_SECONDS * 1000),
        ),
      ),
    )
    .limit(1);
  if (recent.length > 0) {
    return { ok: false, error: "Slow down — wait a few seconds" };
  }

  // Flatten reply-of-reply: if the parent has its own parent, attach to the
  // top-level instead. Keeps the thread at depth 1.
  let parentId = opts.parentId;
  if (parentId) {
    const parent = await db
      .select({ parentId: newsComment.parentId })
      .from(newsComment)
      .where(eq(newsComment.id, parentId))
      .limit(1);
    if (parent.length === 0) return { ok: false, error: "Reply target missing" };
    if (parent[0].parentId) parentId = parent[0].parentId;
  }

  const inserted = await db
    .insert(newsComment)
    .values({
      newsItemId: opts.newsItemId,
      userProfileId: user.userProfileId,
      parentId,
      body: trimmed,
    })
    .returning({ id: newsComment.id });

  revalidatePath(`/news/${opts.newsItemId}`);
  return { ok: true, commentId: inserted[0].id };
}

export type CommentAuthorSnapshot = {
  userProfileId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  tier: string;
};

/** Wrapper around getCurrentUser that returns only the bits the composer
 *  needs. Returns null when signed-out. */
export async function getCommentAuthor(): Promise<CommentAuthorSnapshot | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  return {
    userProfileId: user.userProfileId,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    tier: user.tier,
  };
}

export async function softDeleteComment(commentId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (!UUID_RE.test(commentId)) return { ok: false, error: "Bad id" };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Sign in" };

  const rows = await db
    .select({ userProfileId: newsComment.userProfileId, newsItemId: newsComment.newsItemId })
    .from(newsComment)
    .where(eq(newsComment.id, commentId))
    .limit(1);
  if (rows.length === 0) return { ok: false, error: "Not found" };
  if (rows[0].userProfileId !== user.userProfileId) {
    return { ok: false, error: "Not your comment" };
  }

  await db
    .update(newsComment)
    .set({ deletedAt: new Date() })
    .where(eq(newsComment.id, commentId));

  revalidatePath(`/news/${rows[0].newsItemId}`);
  return { ok: true };
}

// asc, isNull imported above to avoid unused warning during incremental builds.
void asc;
