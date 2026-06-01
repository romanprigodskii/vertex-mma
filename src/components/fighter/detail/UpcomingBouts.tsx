"use client";

import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import type { FighterUpcomingBout } from "@/lib/fighter-detail";
import { cn } from "@/lib/utils";

interface UpcomingBoutsProps {
  bouts: FighterUpcomingBout[];
}

export function UpcomingBouts({ bouts }: UpcomingBoutsProps) {
  const t = useTranslations("fighter");
  const tWeight = useTranslations("weight");

  if (bouts.length === 0) return null;

  return (
    <ul className="flex flex-col">
      {bouts.map((bout) => {
        const date = bout.event_date.slice(0, 10);
        const weightLabel =
          bout.weight_class && tWeight.has(bout.weight_class)
            ? tWeight(bout.weight_class)
            : null;
        return (
          <li
            key={bout.bout_id}
            className={cn(
              "group relative",
              "grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-1",
              "border-b border-foreground/[0.06] px-2 py-3",
              "transition-colors duration-150 hover:bg-foreground/[0.03]",
              "sm:grid-cols-[minmax(0,260px)_minmax(0,1fr)_auto] sm:gap-x-4",
            )}
          >
            {/* Row background routes to the event page. */}
            <Link
              href={`/events/${bout.event_slug}`}
              prefetch={false}
              aria-label={t("boutVsAt", {
                opponent: bout.opponent_name,
                event: bout.event_name,
              })}
              className="absolute inset-0 z-0"
            />

            {/* Event + date → event page. */}
            <div className="relative z-10 col-span-2 flex min-w-0 items-baseline gap-2 pr-2 sm:col-span-1 sm:flex-col sm:items-start sm:gap-0.5 sm:pr-3">
              <Link
                href={`/events/${bout.event_slug}`}
                prefetch={false}
                title={bout.event_name}
                className="line-clamp-2 min-w-0 break-words font-sans text-sm text-foreground transition-colors hover:text-primary"
              >
                {bout.event_name}
              </Link>
              <span className="shrink-0 font-mono text-[11px] tabular text-foreground-muted">
                {date}
              </span>
            </div>

            {/* Opponent → opponent profile, with chips. */}
            <div className="relative z-10 col-span-2 flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1 sm:col-span-1">
              <span className="shrink-0 font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
                vs
              </span>
              <Link
                href={`/fighters/${bout.opponent_slug}`}
                prefetch={false}
                title={bout.opponent_name}
                className="min-w-0 truncate font-sans text-sm text-foreground transition-colors hover:text-primary"
              >
                {bout.opponent_name}
              </Link>
              {bout.is_title_fight ? (
                <span
                  className="shrink-0 rounded-sm border border-primary/35 bg-primary/10 px-1.5 py-0.5 font-sans text-[9px] uppercase tracking-widest text-primary"
                  aria-label={t("titleAria")}
                >
                  {t("titleChip")}
                </span>
              ) : null}
              {bout.is_provisional ? (
                <span
                  className="shrink-0 rounded-sm border border-foreground/20 bg-foreground/[0.04] px-1.5 py-0.5 font-sans text-[9px] uppercase tracking-widest text-foreground-muted"
                  aria-label={t("announcedAria")}
                  title={t("announcedAria")}
                >
                  {t("announcedChip")}
                </span>
              ) : null}
            </div>

            {/* Weight class. */}
            <div className="relative z-10 col-span-2 flex shrink-0 items-baseline justify-end sm:col-span-1">
              {weightLabel ? (
                <span className="font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
                  {weightLabel}
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
