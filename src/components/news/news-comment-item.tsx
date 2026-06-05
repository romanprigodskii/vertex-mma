"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowBigUp, ArrowBigDown, Flag, MoreHorizontal } from "lucide-react";

import {
  deleteCommentAction,
  reportCommentAction,
  voteCommentAction,
} from "@/app/[locale]/news/[id]/actions";
import {
  CommenterAvatar,
  CommentComposer,
  TierBadge,
} from "@/components/news/news-comment-composer";
import { useMounted } from "@/hooks/use-mounted";
import type { CommentNode, CommentAuthorSnapshot } from "@/lib/news-comments";
import { cn } from "@/lib/utils";

function useRelativeTime() {
  const t = useTranslations("news");
  const locale = useLocale();
  return React.useCallback(
    (iso: string): string => {
      const then = new Date(iso).getTime();
      const diffMs = Math.max(0, Date.now() - then);
      const minutes = Math.round(diffMs / 60_000);
      if (minutes < 1) return t("justNow");
      if (minutes < 60) return t("minutesAgo", { n: minutes });
      const hours = Math.round(minutes / 60);
      if (hours < 24) return t("hoursAgo", { n: hours });
      const days = Math.round(hours / 24);
      if (days < 7) return t("daysAgo", { n: days });
      return new Date(iso).toLocaleDateString(
        locale === "ru" ? "ru-RU" : "en-US",
        { month: "short", day: "numeric" },
      );
    },
    [t, locale],
  );
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
  const t = useTranslations("news");
  const relativeTime = useRelativeTime();
  const mounted = useMounted();
  const [replying, setReplying] = React.useState(false);
  const [deleted, setDeleted] = React.useState(false);
  const [reported, setReported] = React.useState(false);
  const [up, setUp] = React.useState(comment.upvotes);
  const [down, setDown] = React.useState(comment.downvotes);
  const [userVote, setUserVote] = React.useState(comment.userVote);
  const [voting, setVoting] = React.useState(false);
  const isOwner = currentAuthor?.userProfileId === comment.author.userProfileId;
  const canReply = Boolean(currentAuthor);
  const canVote = Boolean(currentAuthor);

  async function onVote(dir: 1 | -1) {
    if (!canVote || voting) return;
    setVoting(true);
    const res = await voteCommentAction({ commentId: comment.id, dir });
    setVoting(false);
    if (res.ok) {
      setUp(res.upvotes);
      setDown(res.downvotes);
      setUserVote(res.userVote);
    }
  }
  const canModerate = Boolean(currentAuthor?.isStaff);
  const canDelete = isOwner || canModerate;
  const canReport = Boolean(currentAuthor) && !isOwner;

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
          <span
            className="font-mono text-[11px] text-foreground-subtle"
            suppressHydrationWarning
          >
            {mounted ? relativeTime(comment.createdAt) : null}
          </span>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words font-sans text-sm leading-[1.55] text-foreground/90">
          {comment.body}
        </p>
        <div className="mt-1.5 flex items-center gap-3 font-mono text-[11px] tracking-wide text-foreground-subtle">
          <button
            type="button"
            onClick={() => onVote(1)}
            disabled={!canVote || voting}
            aria-pressed={userVote === 1}
            className={cn(
              "inline-flex items-center gap-1 transition-colors hover:text-foreground disabled:hover:text-foreground-subtle",
              userVote === 1 && "text-primary",
            )}
            aria-label={t("upvote")}
          >
            <ArrowBigUp
              className={cn("h-3.5 w-3.5", userVote === 1 && "fill-current")}
            />{" "}
            {up}
          </button>
          <button
            type="button"
            onClick={() => onVote(-1)}
            disabled={!canVote || voting}
            aria-pressed={userVote === -1}
            className={cn(
              "inline-flex items-center gap-1 transition-colors hover:text-foreground disabled:hover:text-foreground-subtle",
              userVote === -1 && "text-streak-loss",
            )}
            aria-label={t("downvote")}
          >
            <ArrowBigDown
              className={cn("h-3.5 w-3.5", userVote === -1 && "fill-current")}
            />{" "}
            {down}
          </button>
          {canReply && !isReply ? (
            <button
              type="button"
              onClick={() => setReplying((v) => !v)}
              className="transition-colors hover:text-foreground"
            >
              {replying ? t("cancel") : t("replyAction")}
            </button>
          ) : null}
          {canReport ? (
            reported ? (
              <span className="ml-auto inline-flex items-center gap-1 text-foreground-subtle">
                <Flag className="h-3.5 w-3.5" />
                {t("reported")}
              </span>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  if (!confirm(t("reportConfirm"))) return;
                  const result = await reportCommentAction({
                    commentId: comment.id,
                  });
                  if (result.ok) setReported(true);
                }}
                className="ml-auto inline-flex items-center gap-1 transition-colors hover:text-foreground"
                aria-label={t("reportAction")}
              >
                <Flag className="h-3.5 w-3.5" />
                <span>{t("reportAction")}</span>
              </button>
            )
          ) : null}
          {canDelete ? (
            <button
              type="button"
              onClick={async () => {
                if (!confirm(t("deleteConfirm"))) return;
                const result = await deleteCommentAction({
                  commentId: comment.id,
                });
                if (result.ok) setDeleted(true);
              }}
              className={cn(
                "inline-flex items-center transition-colors hover:text-foreground",
                canReport ? "" : "ml-auto",
              )}
              aria-label={!isOwner && canModerate ? t("removeAction") : t("deleteAction")}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
              <span className="ml-1">
                {!isOwner && canModerate ? t("removeAction") : t("deleteAction")}
              </span>
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
