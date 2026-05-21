import * as React from "react";
import Link from "next/link";
import { Heart, Lock } from "lucide-react";

import { resolveThemeColor, resolveThemeFont } from "@/lib/card-theme";
import type { FightCardListItem } from "@/lib/fight-cards";
import { cn } from "@/lib/utils";

export function FightCardGridCard({ card }: { card: FightCardListItem }) {
  const accent = resolveThemeColor(card.theme_color).accent;
  const font = resolveThemeFont(card.title_font);

  return (
    <Link
      href={`/cards/${card.slug}`}
      prefetch={false}
      className="block overflow-hidden rounded-md border border-foreground/10 bg-background-elevated/30 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.04]"
      style={{ "--card-accent": accent } as React.CSSProperties}
    >
      <div className="h-1 w-full bg-[var(--card-accent)]" />
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <h3
            className={cn(
              "text-lg uppercase leading-tight tracking-tight text-foreground line-clamp-2",
              font.className,
            )}
          >
            {card.title}
          </h3>
          {!card.is_public ? (
            <span
              className="mt-0.5 inline-flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle"
              title="Private"
            >
              <Lock className="h-3 w-3" /> Private
            </span>
          ) : null}
        </div>

        {card.headliner ? (
          <p className="mt-2 font-mono text-[11px] uppercase tracking-widest">
            <span className="text-foreground">{card.headliner.fighter_a}</span>
            <span className="text-[var(--card-accent)]"> vs </span>
            <span className="text-foreground">{card.headliner.fighter_b}</span>
          </p>
        ) : (
          <p className="mt-2 font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
            Empty card
          </p>
        )}
        {card.subtitle ? (
          <p className="mt-1.5 font-sans text-sm text-foreground-muted line-clamp-1">
            {card.subtitle}
          </p>
        ) : null}

        <div className="mt-3 flex items-center justify-between gap-2 font-mono text-[11px] tabular text-foreground-subtle">
          <span className="truncate">by @{card.author_username}</span>
          <span className="flex shrink-0 items-center gap-2">
            <span>
              {card.bout_count} bout{card.bout_count === 1 ? "" : "s"}
            </span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <Heart className="h-3 w-3" />
              {card.like_count}
            </span>
          </span>
        </div>
      </div>
    </Link>
  );
}
