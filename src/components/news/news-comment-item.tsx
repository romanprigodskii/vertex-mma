"use client";

import * as React from "react";
import { ArrowBigUp, ArrowBigDown, MoreHorizontal } from "lucide-react";

import { deleteCommentAction } from "@/app/[locale]/news/[id]/actions";
import {
  CommenterAvatar,
  CommentComposer,
  TierBadge,
} from "@/components/news/news-comment-composer";
import type { CommentNode, CommentAuthorSnapshot } from "@/lib/news-comments";
import { cn } from "@/lib/utils";

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Math.max(0, Date.now() - then);
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

interface CommentItemProps {
  comment: CommentNode;
  newsItemId: string;
  currentAuthor: CommentAuthorSnapshot | null;
  /** Replies are rendered nested; passing this skips the inset for the
   *  nested case where the parent has already shifted us. */
  isReply?: boolean;
}

export function CommentItem({
  comment,
  newsItemId,
  currentAuthor,
  isReply = false,
}: CommentItemProps) {
  const [replying, setReplying] = React.useState(false);
  const [deleted, setDeleted] = React.useState(false);
  const isOwner = currentAuthor?.userProfileId === comment.author.userProfileId;
  const canReply = Boolean(currentAuthor);

  if (deleted) return null;

  return (
    <article className={cn("flex gap-3", isReply && "")}>
      <CommenterAvatar
        author={{
          username: comment.author.username,
          displayName: comment.author.displayName,
          avatarUrl: comment.author.avatarUrl,
        }}
        size={isReply ? 30 : 36}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline flex-wrap gap-2">
          <span className="font-sans text-sm font-semibold text-foreground">
            {comment.author.displayName ?? comment.author.username}
          </span>
          <TierBadge tier={comment.author.tier} />
          <span className="font-mono text-[11px] text-foreground-subtle">
            {relativeTime(comment.createdAt)}
          </span>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words font-sans text-sm leading-[1.55] text-foreground/90">
          {comment.body}
        </p>
        <div className="mt-1.5 flex items-center gap-3 font-mono text-[11px] tracking-wide text-foreground-subtle">
          <button
            type="button"
            className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
            aria-label="Upvote"
          >
            <ArrowBigUp className="h-3.5 w-3.5" /> {comment.upvotes}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
            aria-label="Downvote"
          >
            <ArrowBigDown className="h-3.5 w-3.5" /> {comment.downvotes}
          </button>
          {canReply && !isReply ? (
            <button
              type="button"
              onClick={() => setReplying((v) => !v)}
              className="transition-colors hover:text-foreground"
            >
              {replying ? "Cancel" : "Reply"}
            </button>
          ) : null}
          {isOwner ? (
            <button
              type="button"
              onClick={async () => {
                if (!confirm("Delete this comment?")) return;
                const result = await deleteCommentAction({
                  commentId: comment.id,
                });
                if (result.ok) setDeleted(true);
              }}
              className="ml-auto inline-flex items-center transition-colors hover:text-foreground"
              aria-label="More"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
              <span className="ml-1">Delete</span>
            </button>
          ) : null}
        </div>

        {replying && currentAuthor ? (
          <div className="mt-3">
            <CommentComposer
              newsItemId={newsItemId}
              parentId={comment.id}
              author={currentAuthor}
              compact
              autoFocus
              onCancel={() => setReplying(false)}
            />
          </div>
        ) : null}

        {comment.replies.length > 0 ? (
          <div className="mt-4 flex flex-col gap-4 border-l border-foreground/10 pl-4">
            {comment.replies.map((r) => (
              <CommentItem
                key={r.id}
                comment={r}
                newsItemId={newsItemId}
                currentAuthor={currentAuthor}
                isReply
              />
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}
