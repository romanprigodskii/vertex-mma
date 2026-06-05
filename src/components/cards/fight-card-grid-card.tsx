import * as React from "react";
import { useTranslations } from "next-intl";
import { Heart, Lock } from "lucide-react";

import { Link } from "@/i18n/navigation";
import { resolveThemeColor, resolveThemeFont } from "@/lib/card-theme";
import type { FightCardListItem } from "@/lib/fight-cards";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export function FightCardGridCard({ card }: { card: FightCardListItem }) {
  const t = useTranslations("cards");
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
              title={t("private")}
            >
              <Lock className="h-3 w-3" /> {t("private")}
            </span>
          ) : null}
        </div>

        {card.bout_count === 0 ? (
          <p className="mt-2 font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
            {t("emptyCard")}
          </p>
        ) : (
          <p className="mt-2 font-mono text-[11px] uppercase tracking-widest">
            <span className="text-foreground">
              {card.headliner?.fighter_a ?? t("tbd")}
            </span>
            <span className="text-[var(--card-accent)]"> {t("vsConnector")} </span>
            <span className="text-foreground">
              {card.headliner?.fighter_b ?? t("tbd")}
            </span>
          </p>
        )}
        {card.subtitle ? (
          <p className="mt-1.5 font-sans text-sm text-foreground-muted line-clamp-1">
            {card.subtitle}
          </p>
        ) : null}

        <div className="mt-3 flex items-center justify-between gap-2 font-mono text-[11px] tabular text-foreground-subtle">
          <span className="truncate">{t("byUser")} @{card.author_username}</span>
          <span className="flex shrink-0 items-center gap-2">
            <span>{t("boutCount", { count: card.bout_count })}</span>
            <span aria-hidden>·</span>
            {/* Read-only stat — the interactive like button lives on the card
                detail page. Labelled for screen readers; icon is decorative. */}
            <span
              className="inline-flex items-center gap-1"
              aria-label={t("likesCount", { count: card.like_count })}
            >
              <Heart className="h-3 w-3" aria-hidden />
              <span className="tabular">{formatNumber(card.like_count)}</span>
            </span>
          </span>
        </div>
      </div>
    </Link>
  );
}
