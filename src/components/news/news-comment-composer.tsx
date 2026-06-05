"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import { postCommentAction } from "@/app/[locale]/news/[id]/actions";
import { safeHttpUrl } from "@/components/news/safe-url";
import type { CommentAuthorSnapshot } from "@/lib/news-comments";
import { cn } from "@/lib/utils";

const MAX_LEN = 2000;

/** Maps addNewsComment's machine error codes to localized message keys so RU
 *  users never see an English sentence (the server returns codes, not copy). */
const COMMENT_ERROR_KEYS: Record<string, string> = {
  ARTICLE_UNAVAILABLE: "commentErrorUnavailable",
  BAD_REPLY: "commentErrorReply",
  REPLY_MISSING: "commentErrorReply",
  EMPTY: "commentErrorEmpty",
  TOO_LONG: "commentErrorTooLong",
  SIGN_IN: "commentErrorSignIn",
  RATE_LIMITED: "commentErrorRateLimited",
};

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
  // Raw <img> (not next/image) so any avatar host works without a next.config
  // allowlist — matching the profile page — plus a scheme guard for safety.
  const avatar = safeHttpUrl(author.avatarUrl);
  return (
    <span
      className="inline-flex shrink-0 overflow-hidden rounded-sm bg-background-overlay"
      style={{ width: size, height: size }}
    >
      {avatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatar}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
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
  const t = useTranslations("news");
  const [body, setBody] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [posted, setPosted] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const postedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  React.useEffect(
    () => () => {
      if (postedTimer.current) clearTimeout(postedTimer.current);
    },
    [],
  );

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
        const key = COMMENT_ERROR_KEYS[result.error];
        setError(key ? t(key) : t("couldntPost"));
        return;
      }
      setBody("");
      // Explicit confirmation: the new comment otherwise only appears via the
      // server revalidation, which on a slow link reads as "did it post?".
      setPosted(true);
      if (postedTimer.current) clearTimeout(postedTimer.current);
      postedTimer.current = setTimeout(() => setPosted(false), 3000);
      onCancel?.();
    } catch {
      setError(t("couldntPost"));
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
          onChange={(e) => {
            setBody(e.target.value.slice(0, MAX_LEN));
            if (posted) setPosted(false);
          }}
          placeholder={parentId ? t("writeReply") : t("addToConversation")}
          aria-label={parentId ? t("writeReply") : t("addToConversation")}
          rows={compact ? 2 : 3}
          className="w-full resize-y rounded-md border border-foreground/15 bg-background-base px-3 py-2 font-sans text-sm text-foreground outline-none focus:border-primary/60"
          disabled={submitting}
        />
        {error ? (
          <p className="font-sans text-xs text-danger">{error}</p>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          {posted ? (
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-streak-win">
              ✓ {t("posted")}
            </span>
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-foreground-muted">
              {remaining < 100
                ? t("charsLeft", { n: remaining })
                : t("beCivil")}
            </span>
          )}
          <div className="flex gap-2">
            {onCancel ? (
              <button
                type="button"
                onClick={onCancel}
                disabled={submitting}
                className="rounded-sm border border-foreground/15 px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-foreground-muted transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
              >
                {t("cancel")}
              </button>
            ) : null}
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-sm bg-primary px-3.5 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting
                ? t("posting")
                : parentId
                  ? t("replyAction")
                  : t("postComment")}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
