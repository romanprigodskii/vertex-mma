import "server-only";

import { revalidatePath } from "next/cache";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  newsComment,
  newsCommentFlag,
  newsCommentVote,
} from "@/lib/db/schema/news";
import { userProfile } from "@/lib/db/schema/users";
import { COOLDOWN_MS, allowAction } from "@/lib/rate-limit";

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
      // Scope to THIS article's comments — without the inArray we'd fetch the
      // viewer's entire site-wide vote history on every article view.
      const votes = await db
        .select({ commentId: newsCommentVote.commentId, dir: newsCommentVote.dir })
        .from(newsCommentVote)
        .where(
          and(
            eq(newsCommentVote.userProfileId, currentUserProfileId),
            inArray(
              newsCommentVote.commentId,
              rows.map((r) => r.id),
            ),
          ),
        );
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

  // Count only what actually renders: top-level comments plus the replies we
  // attach to a surviving parent. A reply whose parent was soft-deleted (and so
  // dropped from `rows`) is orphaned — it renders nowhere, so counting it would
  // push the header tally above the visible thread.
  let total = tops.length;
  for (const top of tops) {
    const replies = replyBuckets.get(top.id) ?? [];
    // Replies oldest-first so the conversation reads top → bottom.
    replies.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    top.replies = replies;
    total += replies.length;
  }

  return { comments: tops, total };
}

const RATE_LIMIT_SECONDS = 10;

/** Cooldown between comment reports from one user. The DB unique index caps it
 *  to one row per (user, comment); this stops a single account firing
 *  reportCommentAction at every comment to flood the moderation queue. */
const FLAG_COOLDOWN_MS = 3_000;

/** `error` is a stable MACHINE CODE (e.g. "RATE_LIMITED"), not a user-facing
 *  sentence — the client maps it to localized copy (see `commentError*` keys). */
export type AddCommentResult =
  | { ok: true; commentId: string }
  | { ok: false; error: string };

export async function addNewsComment(opts: {
  newsItemId: string;
  parentId: string | null;
  body: string;
}): Promise<AddCommentResult> {
  if (!UUID_RE.test(opts.newsItemId)) {
    return { ok: false, error: "ARTICLE_UNAVAILABLE" };
  }
  if (opts.parentId !== null && !UUID_RE.test(opts.parentId)) {
    return { ok: false, error: "BAD_REPLY" };
  }

  const trimmed = opts.body.trim();
  if (trimmed.length === 0) return { ok: false, error: "EMPTY" };
  if (trimmed.length > 2000) return { ok: false, error: "TOO_LONG" };

  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "SIGN_IN" };

  // Atomic rate-limit. The old guard SELECTed for a recent comment and only
  // then inserted — a TOCTOU window where two concurrent posts both read "none
  // recent" and both wrote. allowAction is a compare-and-set on a process-local
  // map, so concurrent posts from one account can't both pass.
  if (!allowAction(`comment:${user.userProfileId}`, RATE_LIMIT_SECONDS * 1000)) {
    return { ok: false, error: "RATE_LIMITED" };
  }

  // Only published articles accept comments. Without this, a signed-in user who
  // guesses a news_item UUID could seed comments on items still in the
  // moderation queue (pending) or deliberately hidden (rejected).
  const article = (await db.execute<{ status: string }>(sql`
    SELECT status::text AS status FROM news_item
    WHERE id = ${opts.newsItemId}::uuid
    LIMIT 1
  `)) as unknown as Array<{ status: string }>;
  if (
    article.length === 0 ||
    (article[0].status !== "approved" && article[0].status !== "auto_approved")
  ) {
    return { ok: false, error: "ARTICLE_UNAVAILABLE" };
  }

  // Flatten reply-of-reply: if the parent has its own parent, attach to the
  // top-level instead. Keeps the thread at depth 1.
  let parentId = opts.parentId;
  if (parentId) {
    const parent = await db
      .select({
        parentId: newsComment.parentId,
        newsItemId: newsComment.newsItemId,
        deletedAt: newsComment.deletedAt,
      })
      .from(newsComment)
      .where(eq(newsComment.id, parentId))
      .limit(1);
    if (parent.length === 0 || parent[0].deletedAt) {
      return { ok: false, error: "REPLY_MISSING" };
    }
    // The parent must belong to THIS article. Without this a crafted request
    // could reply to a comment on a different article, creating a reply that
    // orphans — its parent never appears in this article's thread.
    if (parent[0].newsItemId !== opts.newsItemId) {
      return { ok: false, error: "BAD_REPLY" };
    }
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
  if (!allowAction(`flag:${user.userProfileId}`, FLAG_COOLDOWN_MS)) {
    return { ok: false, error: "Slow down" };
  }

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
  if (!allowAction(`vote:${user.userProfileId}`, COOLDOWN_MS.vote)) {
    return { ok: false, error: "Slow down — wait a moment" };
  }

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
    const result = await db.transaction(async (tx) => {
      // Lock the comment row so two concurrent votes (or a vote racing a
      // delete) can't each read a stale vote set and write back a count that
      // clobbers the other — the read-modify-write below must be serialized.
      await tx.execute(
        sql`SELECT 1 FROM news_comment WHERE id = ${commentId}::uuid FOR UPDATE`,
      );

      const existing = await tx
        .select({ dir: newsCommentVote.dir })
        .from(newsCommentVote)
        .where(where)
        .limit(1);

      let userVote: number;
      if (existing.length === 0) {
        await tx
          .insert(newsCommentVote)
          .values({ commentId, userProfileId: user.userProfileId, dir });
        userVote = dir;
      } else if (existing[0].dir === dir) {
        await tx.delete(newsCommentVote).where(where);
        userVote = 0;
      } else {
        await tx.update(newsCommentVote).set({ dir }).where(where);
        userVote = dir;
      }

      const agg = (await tx.execute<{ up: number; down: number }>(sql`
        SELECT
          COUNT(*) FILTER (WHERE dir = 1)::int AS up,
          COUNT(*) FILTER (WHERE dir = -1)::int AS down
        FROM news_comment_vote WHERE comment_id = ${commentId}::uuid
      `)) as unknown as Array<{ up: number; down: number }>;
      const counts = agg[0] ?? { up: 0, down: 0 };
      await tx
        .update(newsComment)
        .set({ upvotes: counts.up, downvotes: counts.down })
        .where(eq(newsComment.id, commentId));

      return { up: counts.up, down: counts.down, userVote };
    });

    // No revalidatePath on votes: the client updates its local count from this
    // return value. Revalidating would re-render the whole article RSC tree
    // (body, fighters, related, sidebar) on every single up/down tap.
    return {
      ok: true,
      upvotes: result.up,
      downvotes: result.down,
      userVote: result.userVote,
    };
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

  // Cascade the soft-delete to direct replies. A reply's parent is always a
  // top-level comment (reply-of-reply is flattened on insert), so retiring a
  // top-level comment must also retire its replies — otherwise they survive
  // with a now-hidden parent and render nowhere (orphaned), while still
  // inflating the count. For a reply (which has no children) the parentId match
  // selects nothing, so only it is removed.
  await db
    .update(newsComment)
    .set({ deletedAt: new Date() })
    .where(
      and(
        isNull(newsComment.deletedAt),
        or(
          eq(newsComment.id, commentId),
          eq(newsComment.parentId, commentId),
        ),
      ),
    );

  revalidatePath(`/news/${rows[0].newsItemId}`);
  return { ok: true };
}

// asc, isNull imported above to avoid unused warning during incremental builds.
void asc;
