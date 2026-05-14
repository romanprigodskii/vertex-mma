import Link from "next/link";

import type { FightHistoryEntry } from "@/lib/fighter-detail";
import { abbreviateMethod } from "@/lib/method";
import { isCuratedTitleFight } from "@/lib/title-fights";
import { cn } from "@/lib/utils";

function formatRoundTime(sec: number | null): string {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function resultClass(result: FightHistoryEntry["result"]): string {
  switch (result) {
    case "W":
      return "text-streak-win";
    case "L":
      return "text-streak-loss";
    default:
      return "text-foreground-muted";
  }
}

interface FightHistoryRowProps {
  entry: FightHistoryEntry;
}

export function FightHistoryRow({ entry }: FightHistoryRowProps) {
  const date = entry.event_date.slice(0, 10);
  const methodLabel = abbreviateMethod(entry.method_resolved ?? entry.method);
  // Method is "inferred" when the raw column was NULL but we resolved from
  // round-stats. Slight visual hint so the user knows it's a best guess.
  const methodInferred =
    entry.method == null && entry.method_resolved != null;
  const time = formatRoundTime(entry.time_finished_seconds);
  const finishDetail = entry.round_finished
    ? `R${entry.round_finished}${time ? ` · ${time}` : ""}`
    : null;
  // Source of truth: curated list, not `bout.is_title_fight` (scraper flags
  // entire main cards — see src/lib/title-fights.ts).
  const isTitle = isCuratedTitleFight(entry.bout_id);

  return (
    <li
      className={cn(
        "grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-1",
        "border-b border-foreground/[0.06] px-2 py-3",
        "transition-colors duration-150 hover:bg-foreground/[0.03]",
        "sm:grid-cols-[minmax(0,260px)_minmax(0,1fr)_auto] sm:gap-x-4",
      )}
    >
      {/* Event + date → /events/{slug}#bout-{id}: lands on event with the bout
          row briefly highlighted (BoutAnchorHighlight from Wave 3B.3). */}
      <Link
        href={`/events/${entry.event_slug}#bout-${entry.bout_id}`}
        prefetch={false}
        title={entry.event_name}
        className="col-span-2 flex min-w-0 items-baseline gap-2 sm:col-span-1 sm:flex-col sm:gap-0.5"
      >
        <span className="truncate font-sans text-sm text-foreground hover:text-primary transition-colors">
          {entry.event_name}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular text-foreground-muted">
          {date}
        </span>
      </Link>

      {/* Opponent */}
      <div className="col-span-2 flex min-w-0 flex-wrap items-baseline gap-x-1.5 sm:col-span-1">
        <span className="shrink-0 font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
          vs
        </span>
        <Link
          href={`/fighters/${entry.opponent_slug}`}
          prefetch={false}
          title={entry.opponent_name}
          className="min-w-0 truncate font-sans text-sm text-foreground hover:text-primary transition-colors"
        >
          {entry.opponent_name}
        </Link>
        {isTitle ? (
          <span
            className="shrink-0 rounded-sm border border-primary/35 bg-primary/10 px-1.5 py-0.5 font-sans text-[9px] uppercase tracking-widest text-primary"
            aria-label="Title fight"
          >
            Title
          </span>
        ) : null}
      </div>

      {/* Result · method · round/time */}
      <div
        className={cn(
          "col-span-2 flex shrink-0 items-baseline justify-end gap-1.5 font-sans text-sm tabular sm:col-span-1",
          resultClass(entry.result),
        )}
      >
        <span className="font-display text-base tracking-wider">
          {entry.result}
        </span>
        <span className="text-foreground-subtle/40">·</span>
        <span
          className={cn(
            "font-sans text-foreground",
            methodInferred && "italic text-foreground-muted",
          )}
          title={methodInferred ? "Method inferred from round stats" : undefined}
        >
          {methodLabel}
        </span>
        {finishDetail ? (
          <>
            <span className="text-foreground-subtle/40">·</span>
            <span className="text-foreground-muted">{finishDetail}</span>
          </>
        ) : null}
      </div>
    </li>
  );
}
