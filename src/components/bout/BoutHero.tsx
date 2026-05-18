import Link from "next/link";

import { FighterAvatar } from "@/components/fighter/FighterAvatar";
import type { BoutDetail, BoutDetailFighter } from "@/lib/bout-detail";
import { getCountryFlag } from "@/lib/fighter-helpers";
import { abbreviateMethod } from "@/lib/method";
import { isCuratedTitleFight } from "@/lib/title-fights";
import { cn } from "@/lib/utils";

import { formatTime } from "./StatRow";

interface BoutHeroProps {
  bout: BoutDetail;
  weightLabel: string;
}

function formatEventDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function BoutHero({ bout, weightLabel }: BoutHeroProps) {
  const winnerId = bout.winner_id;
  const aWon = winnerId === bout.fighter_a.id;
  const bWon = winnerId === bout.fighter_b.id;
  const isCompleted = bout.status === "completed";
  const isDraw = isCompleted && !winnerId && bout.method !== "no_contest";
  const isNc = bout.method === "no_contest";

  const methodLabel = abbreviateMethod(bout.method);
  const finishDetail =
    isCompleted && bout.round_finished
      ? `R${bout.round_finished}${
          bout.time_finished_seconds != null
            ? ` · ${formatTime(bout.time_finished_seconds)}`
            : ""
        }`
      : null;

  const placement = bout.is_main_event
    ? "Main event"
    : bout.is_co_main_event
      ? "Co-main"
      : null;
  const isTitle = isCuratedTitleFight(bout.id);
  const dateStr = formatEventDate(bout.event.date);
  const location = [bout.event.venue, bout.event.location_city]
    .filter((v): v is string => Boolean(v))
    .join(", ");

  return (
    <section className="border-b border-foreground/10">
      <div className="py-8 md:py-10">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
          Bout
          {placement ? (
            <>
              <span className="mx-2 text-foreground-subtle/50">·</span>
              <span className="text-primary">{placement}</span>
            </>
          ) : null}
          <span className="mx-2 text-foreground-subtle/50">·</span>
          <span>{weightLabel}</span>
          <span className="mx-2 text-foreground-subtle/50">·</span>
          <span>{bout.scheduled_rounds} rounds</span>
          {isTitle ? (
            <>
              <span className="mx-2 text-foreground-subtle/50">·</span>
              <span className="rounded-sm border border-primary/35 bg-primary/10 px-1.5 py-0.5 text-primary">
                Title
              </span>
            </>
          ) : null}
        </p>

        <Link
          href={`/events/${bout.event.slug}`}
          prefetch={false}
          className="mt-4 inline-block font-display uppercase tracking-tight text-foreground leading-[0.95] hover:text-primary transition-colors"
          style={{ fontSize: "clamp(28px, 4vw, 56px)" }}
        >
          {bout.event.short_name || bout.event.name}
        </Link>

        <p className="mt-2 font-sans text-[11px] uppercase tracking-[0.22em] text-foreground-muted">
          <span className="font-mono tabular text-foreground">{dateStr}</span>
          {location ? (
            <>
              <span className="mx-2 text-foreground-subtle/50">·</span>
              <span>{location}</span>
            </>
          ) : null}
        </p>

        <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
          <FighterSide
            fighter={bout.fighter_a}
            won={aWon}
            isDraw={isDraw}
            isNc={isNc}
            align="left"
          />
          <div className="text-center">
            <p className="font-display text-3xl uppercase tracking-widest text-foreground-subtle">
              vs
            </p>
            {isCompleted ? (
              <div className="mt-2 space-y-0.5">
                <p className="font-sans text-xs uppercase tracking-widest text-foreground-muted">
                  {isNc
                    ? "No contest"
                    : isDraw
                      ? `Draw${methodLabel !== "—" ? ` · ${methodLabel}` : ""}`
                      : methodLabel}
                </p>
                {finishDetail ? (
                  <p className="font-mono tabular text-xs text-foreground-subtle">
                    {finishDetail}
                  </p>
                ) : null}
                {bout.method_detail ? (
                  <p className="mt-2 font-mono italic text-[11px] text-foreground-subtle">
                    {bout.method_detail}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-2 font-sans text-xs uppercase tracking-widest text-foreground-subtle">
                {bout.status}
              </p>
            )}
          </div>
          <FighterSide
            fighter={bout.fighter_b}
            won={bWon}
            isDraw={isDraw}
            isNc={isNc}
            align="right"
          />
        </div>
      </div>
    </section>
  );
}

function FighterSide({
  fighter,
  won,
  isDraw,
  isNc,
  align,
}: {
  fighter: BoutDetailFighter;
  won: boolean;
  isDraw: boolean;
  isNc: boolean;
  align: "left" | "right";
}) {
  const flag = getCountryFlag(fighter.country_code);
  return (
    <Link
      href={`/fighters/${fighter.slug}`}
      prefetch={false}
      className={cn(
        "group flex items-center gap-4 rounded-sm px-2 py-1 transition-colors hover:bg-foreground/[0.03]",
        align === "right" ? "sm:flex-row-reverse sm:text-right" : "",
      )}
    >
      <FighterAvatar
        name={fighter.name_en}
        photoUrl={fighter.photo_thumbnail_url ?? fighter.photo_url}
        size="2xl"
        imageSizes="140px"
        priority
      />
      <div className={cn("flex flex-col gap-0.5 min-w-0")}>
        <span
          className={cn(
            "font-display text-2xl uppercase leading-tight tracking-tight sm:text-3xl",
            won
              ? "text-streak-win"
              : isNc || isDraw
                ? "text-foreground-muted"
                : "text-foreground",
          )}
        >
          {fighter.name_en}
        </span>
        {fighter.nickname ? (
          <span className="truncate font-sans text-xs italic text-foreground-muted">
            &ldquo;{fighter.nickname}&rdquo;
          </span>
        ) : null}
        <span
          className={cn(
            "flex items-center gap-1.5 font-sans text-[11px] uppercase tracking-widest text-foreground-subtle",
            align === "right" ? "sm:justify-end" : "",
          )}
        >
          <span aria-hidden className="text-[13px] leading-none">
            {flag}
          </span>
          <span>{fighter.country_code ?? "—"}</span>
          {won ? <span className="text-streak-win">· Winner</span> : null}
        </span>
      </div>
    </Link>
  );
}
