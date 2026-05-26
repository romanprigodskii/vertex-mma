import Link from "next/link";

import type { RecentFormEntry } from "@/lib/compare-fighters";
import { cn } from "@/lib/utils";

interface RecentFormProps {
  fighterAName: string;
  fighterBName: string;
  recentA: RecentFormEntry[];
  recentB: RecentFormEntry[];
}

function resultClass(r: RecentFormEntry["result"]): string {
  switch (r) {
    case "W":
      return "bg-streak-win/15 border-streak-win/40 text-streak-win";
    case "L":
      return "bg-streak-loss/15 border-streak-loss/40 text-streak-loss";
    case "D":
      return "bg-foreground/10 border-foreground/30 text-foreground-muted";
    case "NC":
      return "bg-foreground/5 border-foreground/20 text-foreground-subtle";
  }
}

function ResultRow({
  name,
  recent,
}: {
  name: string;
  recent: RecentFormEntry[];
}) {
  if (recent.length === 0) {
    return (
      <article>
        <p className="mb-2 font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
          {name}
        </p>
        <p className="font-sans text-xs text-foreground-subtle">
          No recent bouts
        </p>
      </article>
    );
  }
  const wins = recent.filter((r) => r.result === "W").length;
  const losses = recent.filter((r) => r.result === "L").length;
  return (
    <article>
      <p className="mb-2 font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
        {name}
        <span className="ml-2 font-mono normal-case text-foreground-subtle">
          {wins}-{losses} last {recent.length}
        </span>
      </p>
      <ol className="flex gap-1.5">
        {recent.map((r) => (
          <li key={r.bout_id}>
            <Link
              href={`/bouts/${r.bout_id}`}
              prefetch={false}
              title={`${r.result} vs ${r.opponent_name} (${r.event_date.slice(0, 10)})`}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-sm border font-display text-sm tabular transition-colors hover:opacity-80",
                resultClass(r.result),
              )}
            >
              {r.result}
            </Link>
          </li>
        ))}
      </ol>
    </article>
  );
}

export function RecentForm({
  fighterAName,
  fighterBName,
  recentA,
  recentB,
}: RecentFormProps) {
  return (
    <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2 sm:gap-8">
      <ResultRow name={fighterAName} recent={recentA} />
      <ResultRow name={fighterBName} recent={recentB} />
    </div>
  );
}
