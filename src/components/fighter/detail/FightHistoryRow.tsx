import Link from "next/link";

import type { FightHistoryEntry } from "@/lib/fighter-detail";
import { cn } from "@/lib/utils";

const METHOD_SHORT: Record<string, string> = {
  ko: "KO",
  tko: "TKO",
  submission: "Sub",
  decision_unanimous: "U-Dec",
  decision_split: "S-Dec",
  decision_majority: "M-Dec",
  draw: "Draw",
  no_contest: "NC",
  dq: "DQ",
};

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
  const methodLabel = entry.method
    ? METHOD_SHORT[entry.method] ?? entry.method
    : null;
  const time = formatRoundTime(entry.time_finished_seconds);
  const finishDetail = entry.round_finished
    ? `R${entry.round_finished}${time ? ` · ${time}` : ""}`
    : null;

  return (
    <li
      className={cn(
        "grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3 gap-y-1",
        "border-b border-foreground/[0.06] px-2 py-3",
        "transition-colors duration-150 hover:bg-foreground/[0.03]",
        "sm:grid-cols-[140px_minmax(0,1fr)_auto] sm:gap-x-4",
      )}
    >
      {/* Event + date */}
      <Link
        href={`/events/${entry.event_slug}`}
        prefetch={false}
        className="col-span-3 flex min-w-0 items-baseline gap-2 sm:col-span-1 sm:flex-col sm:gap-0.5"
      >
        <span className="truncate font-sans text-sm text-foreground hover:text-primary transition-colors">
          {entry.event_name}
        </span>
        <span className="font-mono text-[11px] tabular text-foreground-muted">
          {date}
        </span>
      </Link>

      {/* Opponent */}
      <div className="min-w-0 flex flex-wrap items-baseline gap-x-1.5">
        <span className="font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
          vs
        </span>
        <Link
          href={`/fighters/${entry.opponent_slug}`}
          prefetch={false}
          className="truncate font-sans text-sm text-foreground hover:text-primary transition-colors"
        >
          {entry.opponent_name}
        </Link>
        {entry.is_title_fight ? (
          <span className="ml-1 rounded-sm bg-primary/15 px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-widest text-primary">
            Title
          </span>
        ) : null}
      </div>

      {/* Result */}
      <div
        className={cn(
          "flex shrink-0 items-baseline justify-end gap-1.5 font-sans text-sm tabular",
          resultClass(entry.result),
        )}
      >
        <span className="font-display text-base tracking-wider">
          {entry.result}
        </span>
        {methodLabel ? (
          <span className="text-foreground-muted">· {methodLabel}</span>
        ) : null}
        {finishDetail ? (
          <span className="text-foreground-subtle">· {finishDetail}</span>
        ) : null}
      </div>
    </li>
  );
}
