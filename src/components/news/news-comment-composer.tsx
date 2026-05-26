"use client";

import * as React from "react";
import Image from "next/image";

import { postCommentAction } from "@/app/news/[id]/actions";
import type { CommentAuthorSnapshot } from "@/lib/news-comments";
import { cn } from "@/lib/utils";

const MAX_LEN = 2000;

const TIER_STYLE: Record<string, string> = {
  bronze: "border-tier-bronze/40 text-tier-bronze bg-tier-bronze/[0.08]",
  silver: "border-tier-silver/40 text-tier-silver bg-tier-silver/[0.08]",
  gold: "border-tier-gold/40 text-tier-gold bg-tier-gold/[0.08]",
  diamond:
    "border-tier-diamond/40 text-tier-diamond bg-tier-diamond/[0.08]",
  champion:
    "border-tier-champion/40 text-tier-champion bg-tier-champion/[0.08]",
};

export function CommenterAvatar({
  author,
  size = 36,
}: {
  author: Pick<CommentAuthorSnapshot, "username" | "displayName" | "avatarUrl">;
  size?: number;
}) {
  const initials = (author.displayName ?? author.username)
    .split(/[\s_]+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span
      className="inline-flex shrink-0 overflow-hidden rounded-sm bg-background-overlay"
      style={{ width: size, height: size }}
    >
      {author.avatarUrl ? (
        <Image
          src={author.avatarUrl}
          alt=""
          width={size}
          height={size}
          className="h-full w-full object-cover"
        />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center font-display text-foreground"
          style={{ fontSize: Math.round(size * 0.42) }}
        >
          {initials}
        </span>
      )}
    </span>
  );
}

export function TierBadge({ tier }: { tier: string }) {
  const style = TIER_STYLE[tier] ?? TIER_STYLE.bronze;
  return (
    <span
      className={cn(
        "rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em]",
        style,
      )}
    >
      {tier}
    </span>
  );
}

interface CommentComposerProps {
  newsItemId: string;
  parentId: string | null;
  author: CommentAuthorSnapshot;
  onCancel?: () => void;
  autoFocus?: boolean;
  compact?: boolean;
}

export function CommentComposer({
  newsItemId,
  parentId,
  author,
  onCancel,
  autoFocus,
  compact,
}: CommentComposerProps) {
  const [body, setBody] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  React.useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  const remaining = MAX_LEN - body.length;
  const trimmed = body.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await postCommentAction({
        newsItemId,
        parentId,
        body: trimmed,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBody("");
      onCancel?.();
    } catch {
      setError("Couldn't post. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        "flex gap-3 rounded-md border border-foreground/10 bg-background-elevated/30 p-4",
        compact && "p-3",
      )}
    >
      <CommenterAvatar author={author} size={compact ? 28 : 36} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, MAX_LEN))}
          placeholder={
            parentId ? "Write a reply…" : "Add to the conversation…"
          }
          rows={compact ? 2 : 3}
          className="w-full resize-y rounded-md border border-foreground/15 bg-background-base px-3 py-2 font-sans text-sm text-foreground outline-none focus:border-primary/60"
          disabled={submitting}
        />
        {error ? (
          <p className="font-sans text-xs text-danger">{error}</p>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-foreground-subtle">
            {remaining < 100
              ? `${remaining} chars left`
              : "Be civil · Markdown not yet"}
          </span>
          <div className="flex gap-2">
            {onCancel ? (
              <button
                type="button"
                onClick={onCancel}
                disabled={submitting}
                className="rounded-sm border border-foreground/15 px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-foreground-muted transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
              >
                Cancel
              </button>
            ) : null}
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-sm bg-primary px-3.5 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Posting…" : parentId ? "Reply" : "Post"}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
