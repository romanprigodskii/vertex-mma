import Link from "next/link";

import type { LeaderboardRow, LeaderboardSort } from "@/lib/leaderboard";
import { cn } from "@/lib/utils";

interface Props {
  rows: LeaderboardRow[];
  activeSort: LeaderboardSort;
}

const SORTS: Array<{ key: LeaderboardSort; label: string; hint: string }> = [
  { key: "profit", label: "Profit", hint: "Net coins won minus lost" },
  { key: "volume", label: "Volume", hint: "Total coins wagered" },
  {
    key: "achievements",
    label: "Achievements",
    hint: "Most achievements unlocked",
  },
];

export function LeaderboardTable({ rows, activeSort }: Props) {
  return (
    <div>
      <nav
        className="mb-6 flex gap-1 border-b border-foreground/10"
        role="tablist"
      >
        {SORTS.map((s) => (
          <Link
            key={s.key}
            href={`/leaderboard?sort=${s.key}`}
            className={cn(
              "px-3 py-2 font-sans text-sm uppercase tracking-widest transition-colors",
              activeSort === s.key
                ? "border-b-2 border-foreground text-foreground"
                : "border-b-2 border-transparent text-foreground-muted hover:text-foreground",
            )}
            title={s.hint}
          >
            {s.label}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="py-12 text-center font-sans text-sm text-foreground-muted">
          No data yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((r) => (
            <li key={r.user_id}>
              <Link
                href={`/profile/${r.username}`}
                prefetch={false}
                className="grid grid-cols-[2.5rem_2.5rem_1fr_auto] items-center gap-3 rounded-md border border-foreground/10 bg-background-elevated/30 px-3 py-2.5 transition-colors hover:bg-foreground/[0.04]"
              >
                <span className="font-display text-xl tabular text-foreground-subtle">
                  #{r.rank}
                </span>
                {r.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.avatar_url}
                    alt={r.username}
                    className="h-9 w-9 rounded-full object-cover"
                  />
                ) : (
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 font-display text-xs uppercase text-primary">
                    {r.username.slice(0, 2)}
                  </span>
                )}
                <div className="min-w-0">
                  <p className="truncate font-sans text-sm text-foreground">
                    {r.display_name || r.username}
                  </p>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                    @{r.username} · {r.tier.toUpperCase()} ·{" "}
                    {r.achievement_count} ach
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {activeSort === "volume" ? (
                    <p className="font-display text-lg tabular text-foreground">
                      {r.total_lost.toLocaleString()}
                    </p>
                  ) : activeSort === "achievements" ? (
                    <p className="font-display text-lg tabular text-foreground">
                      {r.achievement_count}
                    </p>
                  ) : (
                    <p
                      className={cn(
                        "font-display text-lg tabular",
                        r.profit > 0
                          ? "text-streak-win"
                          : r.profit < 0
                            ? "text-streak-loss"
                            : "text-foreground",
                      )}
                    >
                      {r.profit > 0 ? "+" : ""}
                      {r.profit.toLocaleString()}
                    </p>
                  )}
                  <p className="font-mono text-[10px] tabular text-foreground-subtle">
                    {r.bet_count} bet{r.bet_count === 1 ? "" : "s"}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
