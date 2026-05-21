"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Heart, Link2 } from "lucide-react";

import { toggleLikeAction } from "@/app/cards/actions";
import { cn } from "@/lib/utils";

interface Props {
  cardId: string;
  slug: string;
  initialLiked: boolean;
  initialLikeCount: number;
  isSignedIn: boolean;
}

const BTN =
  "inline-flex items-center gap-1.5 rounded-sm border px-3 py-1.5 font-sans text-sm transition-colors";

export function FightCardActions({
  cardId,
  slug,
  initialLiked,
  initialLikeCount,
  isSignedIn,
}: Props) {
  const [liked, setLiked] = React.useState(initialLiked);
  const [count, setCount] = React.useState(initialLikeCount);
  const [pending, setPending] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  async function onLike() {
    if (pending) return;
    setPending(true);
    const prevLiked = liked;
    const prevCount = count;
    // Optimistic — reconciled to server truth on response.
    setLiked(!liked);
    setCount(liked ? count - 1 : count + 1);

    const res = await toggleLikeAction(cardId);
    setPending(false);
    if (res?.error) {
      setLiked(prevLiked);
      setCount(prevCount);
      return;
    }
    if (typeof res.liked === "boolean") setLiked(res.liked);
    if (typeof res.likeCount === "number") setCount(res.likeCount);
  }

  async function onCopy() {
    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}/cards/${slug}`
        : `/cards/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Locked-down browsers — no-op rather than throw.
    }
  }

  return (
    <div className="flex items-center gap-2">
      {isSignedIn ? (
        <button
          type="button"
          onClick={onLike}
          disabled={pending}
          aria-pressed={liked}
          className={cn(
            BTN,
            liked
              ? "border-streak-loss/40 bg-streak-loss/10 text-streak-loss"
              : "border-foreground/15 text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground",
            "disabled:opacity-60",
          )}
        >
          <Heart
            className={cn("h-4 w-4", liked && "fill-current")}
            aria-hidden
          />
          <span className="tabular">{count}</span>
        </button>
      ) : (
        <Link
          href={`/signin?next=/cards/${slug}`}
          className={cn(
            BTN,
            "border-foreground/15 text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground",
          )}
          title="Sign in to like cards"
        >
          <Heart className="h-4 w-4" aria-hidden />
          <span className="tabular">{count}</span>
        </Link>
      )}

      <button
        type="button"
        onClick={onCopy}
        className={cn(
          BTN,
          "border-foreground/15 text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground",
        )}
      >
        {copied ? (
          <Check className="h-4 w-4 text-streak-win" aria-hidden />
        ) : (
          <Link2 className="h-4 w-4" aria-hidden />
        )}
        <span>{copied ? "Link copied" : "Copy link"}</span>
      </button>
    </div>
  );
}
