import "server-only";

import { revalidatePath } from "next/cache";
import { and, asc, desc, eq, inArray, isNull, gt, sql } from "drizzle-orm";

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
  const topIds = new Set<string>();
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
      topIds.add(node.id);
    }
  }

  const byOldest = (a: CommentNode, b: CommentNode) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

  for (const [parentId, bucket] of replyBuckets) {
    // Replies oldest-first so the conversation reads top → bottom.
    bucket.sort(byOldest);
    const parent = topIds.has(parentId) ? byId.get(parentId) : undefined;
    if (parent) {
      parent.replies = bucket;
    } else {
      // The parent was soft-deleted (filtered out of `rows` by the isNull
      // guard above), so these still-live replies would otherwise vanish
      // silently — their bucket was keyed on a comment that never made it into
      // `tops`. Re-parent them to top level instead: the comments stay visible
      // and the thread stays flat at depth 1.
      tops.push(...bucket);
    }
  }

  // Promoting orphans may have appended them out of order; restore newest-first
  // to match the descending order the query produced for the original tops.
  tops.sort((a, b) => byOldest(b, a));

  // Count what's actually rendered rather than raw `rows`: with the orphan
  // re-parenting above the two now agree, but deriving the total from the tree
  // keeps the "Comments · N" header honest if that ever drifts again.
  const total = tops.reduce((sum, t) => sum + 1 + t.replies.length, 0);

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
        deletedAt: newsComment.deletedAt,
      })
      .from(newsComment)
      .where(eq(newsComment.id, parentId))
      .limit(1);
    if (parent.length === 0) return { ok: false, error: "REPLY_MISSING" };
    // Don't let a reply attach to a soft-deleted comment: it would be hidden
    // from the thread (or re-parented to top level) on the next render, so the
    // reply reads as lost. REPLY_MISSING already maps to the client's "the
    // comment you're replying to was deleted" copy.
    if (parent[0].deletedAt) return { ok: false, error: "REPLY_MISSING" };
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

/** True only for Postgres "undefined_table" (SQLSTATE 42P01) — the expected
 *  error before the news_comment_flag table has been pushed. node-postgres
 *  surfaces the SQLSTATE on `error.code`; a message match is kept as a
 *  belt-and-braces fallback. Any OTHER error (FK violation, connection drop,
 *  constraint bug) must propagate, not be masked as a successful report. */
function isUndefinedTableError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code === "42P01") return true;
  return Boolean(
    e?.message &&
      /news_comment_flag/.test(e.message) &&
      /relation|table|exist/i.test(e.message),
  );
}

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

  // Validate the target BEFORE consuming the rate limiter. A self-report, or a
  // report of a since-deleted / non-existent comment, is a benign no-op and
  // shouldn't burn the reporter's cooldown — otherwise their next legitimate
  // report gets a spurious "Slow down".
  const rows = await db
    .select({ userProfileId: newsComment.userProfileId })
    .from(newsComment)
    .where(eq(newsComment.id, commentId))
    .limit(1);
  if (rows.length === 0) return { ok: false, error: "Not found" };
  if (rows[0].userProfileId === user.userProfileId) {
    return { ok: false, error: "Can't report your own comment" };
  }

  if (!allowAction(`flag:${user.userProfileId}`, FLAG_COOLDOWN_MS)) {
    return { ok: false, error: "Slow down" };
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
  } catch (err) {
    // The ONLY benign failure is the flag table not being pushed yet — mask
    // just that as a soft success so the UI still acknowledges the report. A
    // genuine failure (FK violation, connection drop) must surface instead of
    // telling the reader "Reported" on a report that never landed.
    if (!isUndefinedTableError(err)) {
      return { ok: false, error: "Report failed" };
    }
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

  await db
    .update(newsComment)
    .set({ deletedAt: new Date() })
    .where(eq(newsComment.id, commentId));

  revalidatePath(`/news/${rows[0].newsItemId}`);
  return { ok: true };
}

// asc, isNull imported above to avoid unused warning during incremental builds.
void asc;
