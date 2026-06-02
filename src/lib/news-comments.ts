import "server-only";

import { revalidatePath } from "next/cache";
import { and, asc, desc, eq, isNull, gt, sql } from "drizzle-orm";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  newsComment,
  newsCommentFlag,
  newsCommentVote,
} from "@/lib/db/schema/news";
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
  /** Current viewer's vote on this comment: 1, -1, or 0 (none / signed out). */
  userVote: number;
  createdAt: string;
  author: CommentAuthor;
  replies: CommentNode[];
};

export async function listCommentsForNews(
  newsItemId: string,
  currentUserProfileId?: string | null,
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

  // The viewer's own votes, so the UI can highlight the active arrow.
  const voteMap = new Map<string, number>();
  if (currentUserProfileId && UUID_RE.test(currentUserProfileId) && rows.length) {
    try {
      const votes = await db
        .select({ commentId: newsCommentVote.commentId, dir: newsCommentVote.dir })
        .from(newsCommentVote)
        .where(eq(newsCommentVote.userProfileId, currentUserProfileId));
      for (const v of votes) voteMap.set(v.commentId, v.dir);
    } catch {
      // Votes table not pushed yet → treat as no votes.
    }
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
      userVote: voteMap.get(r.id) ?? 0,
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
  /** Staff can moderate (delete) any comment, not just their own. */
  isStaff: boolean;
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
    isStaff: user.isStaff,
  };
}

export type FlagCommentResult = { ok: boolean; error?: string };

/**
 * Reader report on a comment. Idempotent per reporter (the unique index makes
 * a repeat report a no-op success). Requires sign-in. Degrades gracefully if
 * the flag table hasn't been pushed yet.
 */
export async function flagComment(
  commentId: string,
  reason?: string | null,
): Promise<FlagCommentResult> {
  if (!UUID_RE.test(commentId)) return { ok: false, error: "Bad id" };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Sign in" };

  // Can't report your own comment.
  const rows = await db
    .select({ userProfileId: newsComment.userProfileId })
    .from(newsComment)
    .where(eq(newsComment.id, commentId))
    .limit(1);
  if (rows.length === 0) return { ok: false, error: "Not found" };
  if (rows[0].userProfileId === user.userProfileId) {
    return { ok: false, error: "Can't report your own comment" };
  }

  const trimmed = reason?.trim().slice(0, 200) || null;
  try {
    await db
      .insert(newsCommentFlag)
      .values({
        commentId,
        userProfileId: user.userProfileId,
        reason: trimmed,
      })
      .onConflictDoNothing({
        target: [newsCommentFlag.commentId, newsCommentFlag.userProfileId],
      });
  } catch {
    // Table not pushed yet, or transient — treat as a soft success so the UI
    // still acknowledges the report rather than erroring at the reader.
    return { ok: true };
  }
  return { ok: true };
}

export type VoteCommentResult =
  | { ok: true; upvotes: number; downvotes: number; userVote: number }
  | { ok: false; error: string };

/**
 * Cast / toggle a vote on a comment. Same direction twice clears it; the
 * opposite flips it. Recomputes the denormalized counts on news_comment from
 * the votes table. Idempotent per (comment, user) via the unique index.
 */
export async function voteComment(
  commentId: string,
  dir: 1 | -1,
): Promise<VoteCommentResult> {
  if (!UUID_RE.test(commentId)) return { ok: false, error: "Bad id" };
  if (dir !== 1 && dir !== -1) return { ok: false, error: "Bad direction" };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Sign in" };

  const rows = await db
    .select({
      newsItemId: newsComment.newsItemId,
      deletedAt: newsComment.deletedAt,
    })
    .from(newsComment)
    .where(eq(newsComment.id, commentId))
    .limit(1);
  if (rows.length === 0 || rows[0].deletedAt) {
    return { ok: false, error: "Not found" };
  }

  const where = and(
    eq(newsCommentVote.commentId, commentId),
    eq(newsCommentVote.userProfileId, user.userProfileId),
  );
  try {
    const existing = await db
      .select({ dir: newsCommentVote.dir })
      .from(newsCommentVote)
      .where(where)
      .limit(1);

    let userVote: number;
    if (existing.length === 0) {
      await db
        .insert(newsCommentVote)
        .values({ commentId, userProfileId: user.userProfileId, dir });
      userVote = dir;
    } else if (existing[0].dir === dir) {
      await db.delete(newsCommentVote).where(where);
      userVote = 0;
    } else {
      await db.update(newsCommentVote).set({ dir }).where(where);
      userVote = dir;
    }

    const agg = (await db.execute<{ up: number; down: number }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE dir = 1)::int AS up,
        COUNT(*) FILTER (WHERE dir = -1)::int AS down
      FROM news_comment_vote WHERE comment_id = ${commentId}::uuid
    `)) as unknown as Array<{ up: number; down: number }>;
    const counts = agg[0] ?? { up: 0, down: 0 };
    await db
      .update(newsComment)
      .set({ upvotes: counts.up, downvotes: counts.down })
      .where(eq(newsComment.id, commentId));

    revalidatePath(`/news/${rows[0].newsItemId}`);
    return { ok: true, upvotes: counts.up, downvotes: counts.down, userVote };
  } catch {
    return { ok: false, error: "Vote failed" };
  }
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
  // Owners delete their own comment; staff (ADMIN_EMAILS) can remove any
  // comment for trust-and-safety.
  if (rows[0].userProfileId !== user.userProfileId && !user.isStaff) {
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
