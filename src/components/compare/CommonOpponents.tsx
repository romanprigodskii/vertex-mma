import Link from "next/link";

import type { CommonOpponentBout, CommonOpponentEntry } from "@/lib/compare-fighters";
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

function resultClass(result: CommonOpponentBout["result"]): string {
  switch (result) {
    case "W":
      return "text-streak-win";
    case "L":
      return "text-streak-loss";
    default:
      return "text-foreground-muted";
  }
}

function BoutLine({
  label,
  bout,
}: {
  label: string;
  bout: CommonOpponentBout;
}) {
  const method = bout.method ? METHOD_SHORT[bout.method] ?? bout.method : null;
  const t = formatRoundTime(bout.time_finished_seconds);
  const finishDetail = bout.round_finished
    ? `R${bout.round_finished}${t ? ` · ${t}` : ""}`
    : null;
  return (
    <div className="grid grid-cols-[60px_auto_1fr] items-baseline gap-2 font-sans text-[12px] text-foreground-muted sm:grid-cols-[80px_auto_1fr] sm:gap-3">
      <span className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        {label}
      </span>
      <span className={cn("font-display tabular text-sm tracking-wider", resultClass(bout.result))}>
        {bout.result}
      </span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        {method ? <span>{method}</span> : null}
        {finishDetail ? (
          <>
            <span aria-hidden className="text-foreground-subtle/40">·</span>
            <span className="font-mono tabular text-foreground-subtle">
              {finishDetail}
            </span>
          </>
        ) : null}
        <span aria-hidden className="text-foreground-subtle/40">·</span>
        <Link
          href={`/events/${bout.event_slug}`}
          prefetch={false}
          className="truncate text-foreground hover:text-primary transition-colors"
        >
          {bout.event_name}
        </Link>
        <span aria-hidden className="text-foreground-subtle/40">·</span>
        <span className="font-mono tabular text-foreground-subtle">
          {bout.event_date.slice(0, 10)}
        </span>
      </span>
    </div>
  );
}

interface CommonOpponentsProps {
  entries: CommonOpponentEntry[];
  fighterAName: string;
  fighterBName: string;
}

export function CommonOpponents({
  entries,
  fighterAName,
  fighterBName,
}: CommonOpponentsProps) {
  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-foreground/10 bg-background-elevated/30 px-6 py-10 text-center">
        <p className="font-sans text-sm text-foreground-muted">
          No common UFC opponents between {fighterAName} and {fighterBName}.
        </p>
      </div>
    );
  }

  return (
    <ul className="mx-auto flex max-w-3xl flex-col gap-4">
      {entries.map((e) => (
        <li
          key={e.opponent_slug}
          className="rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-3"
        >
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <Link
              href={`/fighters/${e.opponent_slug}`}
              prefetch={false}
              className="font-display text-lg uppercase tracking-tight text-foreground hover:text-primary transition-colors sm:text-xl"
            >
              {e.opponent_name}
            </Link>
            {e.opponent_nickname ? (
              <span className="truncate font-sans text-[12px] italic text-foreground-subtle">
                &ldquo;{e.opponent_nickname}&rdquo;
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <BoutLine label={fighterAName.split(" ")[0]} bout={e.a_bout} />
            <BoutLine label={fighterBName.split(" ")[0]} bout={e.b_bout} />
          </div>
        </li>
      ))}
    </ul>
  );
}
