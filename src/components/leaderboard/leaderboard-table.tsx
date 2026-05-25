import Link from "next/link";

import { formatNumber } from "@/lib/format";
import type { LeaderboardRow, LeaderboardSort } from "@/lib/leaderboard";
import { cn, formatCoins } from "@/lib/utils";

interface Props {
  rows: LeaderboardRow[];
  activeSort: LeaderboardSort;
}

const SORTS: Array<{
  key: LeaderboardSort;
  label: string;
  hint: string;
  /** Right-column header label shown above the active metric. */
  metricHeader: string;
}> = [
  {
    key: "profit",
    label: "Profit",
    hint: "Net coins won minus lost",
    metricHeader: "Profit",
  },
  {
    key: "volume",
    label: "Volume",
    hint: "Total coins wagered",
    metricHeader: "Volume",
  },
  {
    key: "achievements",
    label: "Achievements",
    hint: "Most achievements unlocked",
    metricHeader: "Achievements",
  },
];

// Grid template shared between header row and body rows so columns line up.
// rank · avatar · identity (flex) · metric (right) · bets (right).
const ROW_GRID =
  "grid grid-cols-[3rem_2.75rem_minmax(0,1fr)_8rem_4rem] items-center gap-4 px-3";

export function LeaderboardTable({ rows, activeSort }: Props) {
  const active = SORTS.find((s) => s.key === activeSort) ?? SORTS[0];
  const showSecondaryBets = activeSort !== "achievements";

  return (
    <div>
      <nav
        className="mb-6 flex gap-1 border-b border-edge"
        role="tablist"
      >
        {SORTS.map((s) => (
          <Link
            key={s.key}
            href={`/leaderboard?sort=${s.key}`}
            className={cn(
              "type-label px-3 py-2 text-sm transition-colors",
              activeSort === s.key
                ? "border-b-2 border-fg/60 text-fg"
                : "border-b-2 border-transparent text-fg-muted hover:text-fg",
            )}
            title={s.hint}
          >
            {s.label}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-fg/15 bg-surface-elevated/20 px-6 py-16 text-center">
          <p className="type-display text-2xl text-fg">
            No bettors with activity yet
          </p>
          <p className="mx-auto mt-3 max-w-md type-body text-sm text-fg-muted">
            Place a bet on any open market and land on the leaderboard the
            moment it settles.
          </p>
          <Link
            href="/markets"
            className="mt-6 inline-block rounded-sm bg-accent type-label px-4 py-2 text-sm text-accent-foreground hover:bg-accent-hover"
          >
            Browse markets →
          </Link>
        </div>
      ) : (
        <div>
          {/* Column header row — same grid template as body rows so the
              labels sit directly above their columns. */}
          <div
            className={cn(
              ROW_GRID,
              "border-b border-fg/15 py-2 type-meta text-[10px] text-fg-subtle",
            )}
          >
            <span className="text-right">Rank</span>
            <span aria-hidden />
            <span>User</span>
            <span className="text-right">{active.metricHeader}</span>
            <span className="text-right">
              {showSecondaryBets ? "Bets" : ""}
            </span>
          </div>

          <ul className="flex flex-col">
            {rows.map((r) => (
              <li key={r.user_id} className="border-b border-fg/[0.08]">
                <Link
                  href={`/profile/${r.username}`}
                  prefetch={false}
                  className={cn(
                    ROW_GRID,
                    "py-2.5 transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.03]",
                  )}
                >
                  <span className="text-right type-display text-xl tabular text-fg-subtle">
                    #{r.rank}
                  </span>
                  {r.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={r.avatar_url}
                      alt=""
                      className="h-9 w-9 rounded-full object-cover"
                    />
                  ) : (
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/15 type-display text-xs text-accent">
                      {r.username.slice(0, 2)}
                    </span>
                  )}
                  <div className="min-w-0">
                    <p className="truncate type-body text-sm text-fg">
                      {r.display_name || r.username}
                    </p>
                    <p className="flex items-center gap-1.5 truncate type-meta text-[10px] text-fg-subtle">
                      <span className="truncate">@{r.username}</span>
                      <span aria-hidden className="text-fg-subtle/50">
                        ·
                      </span>
                      <TierChip tier={r.tier} />
                      {activeSort !== "achievements" ? (
                        <>
                          <span aria-hidden className="text-fg-subtle/50">
                            ·
                          </span>
                          <span className="shrink-0">
                            {r.achievement_count} ach
                          </span>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <span className="text-right type-display text-lg tabular">
                    {activeSort === "profit" ? (
                      <SignedMetric value={r.profit} />
                    ) : activeSort === "volume" ? (
                      <span className="text-fg">
                        {formatCoins(r.total_lost)}
                      </span>
                    ) : (
                      <span className="text-fg">
                        {formatNumber(r.achievement_count)}
                      </span>
                    )}
                  </span>
                  <span className="text-right type-num text-[10px] text-fg-subtle">
                    {showSecondaryBets
                      ? `${r.bet_count} bet${r.bet_count === 1 ? "" : "s"}`
                      : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Profit/loss number with a reserved-width sign slot so +12,450, −3,200,
 *  and 0 all share the same digit-rail when right-aligned. The sign sits
 *  in its own 1ch inline-block so the leading digit lines up regardless of
 *  glyph width for `+`, `−`, or the figure-space fallback used for zero. */
function SignedMetric({ value }: { value: number }) {
  if (value === 0) {
    return (
      <span className="text-fg">
        <span aria-hidden className="inline-block w-[1ch]">
          {" "}
        </span>
        0
      </span>
    );
  }
  const isPositive = value > 0;
  return (
    <span className={isPositive ? "text-profit" : "text-loss"}>
      <span aria-hidden className="inline-block w-[1ch] text-center">
        {isPositive ? "+" : "−"}
      </span>
      <span className="sr-only">{isPositive ? "plus " : "minus "}</span>
      {formatCoins(Math.abs(value))}
    </span>
  );
}

/** Small mono chip for the user's account tier — quiet 1px edge, no
 *  invented per-tier colour (the tier vocabulary is account-tier, not
 *  fighter-tier, so no shared palette to reach for). */
function TierChip({ tier }: { tier: string }) {
  return (
    <span className="shrink-0 rounded-sm border border-fg/15 bg-surface-elevated/40 px-1 py-px type-meta text-[9px] text-fg-muted">
      {tier}
    </span>
  );
}
