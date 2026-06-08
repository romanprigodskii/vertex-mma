"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { Heart } from "lucide-react";

import { toggleLikeAction } from "@/app/[locale]/cards/actions";
import { ShareButton } from "@/components/share/share-button";
import { Link, getPathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

interface Props {
  cardId: string;
  slug: string;
  title: string;
  initialLiked: boolean;
  initialLikeCount: number;
  isSignedIn: boolean;
}

const BTN =
  "inline-flex items-center gap-1.5 rounded-sm border px-3 py-1.5 font-sans text-sm transition-colors";

export function FightCardActions({
  cardId,
  slug,
  title,
  initialLiked,
  initialLikeCount,
  isSignedIn,
}: Props) {
  const t = useTranslations("cards");
  const locale = useLocale();
  const [liked, setLiked] = React.useState(initialLiked);
  const [count, setCount] = React.useState(initialLikeCount);
  const [pending, setPending] = React.useState(false);

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
          title={t("signInToLike")}
        >
          <Heart className="h-4 w-4" aria-hidden />
          <span className="tabular">{count}</span>
        </Link>
      )}

      <ShareButton
        url={getPathname({ href: `/cards/${slug}`, locale })}
        ogImageUrl={`/api/og/cards/${slug}`}
        title={title}
        filename={`vertexmma-card-${slug}`}
        label={t("share")}
      />
    </div>
  );
}
