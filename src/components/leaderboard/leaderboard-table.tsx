import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";
import { formatNumber } from "@/lib/format";
import type { LeaderboardRow, LeaderboardSort } from "@/lib/leaderboard";
import { cn } from "@/lib/utils";

interface Props {
  rows: LeaderboardRow[];
  activeSort: LeaderboardSort;
}

const SORT_KEYS: LeaderboardSort[] = ["profit", "volume", "achievements"];

// Compact very large metrics ("1.2M", "12M", "3.4B") so a champion's 7+ figure
// net worth or coins-lost total can't dominate the row and crowd the name
// column on narrow screens. Deterministic — no locale-dependent Intl
// formatting — so SSR and the first client render produce identical strings,
// mirroring formatNumber's hydration-safety guarantee.
function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs < 1_000_000) return formatNumber(n);
  const sign = n < 0 ? "-" : "";
  // Round-aware B/M boundary: 999.5M+ must render as "1B", never "1000M".
  const useB = abs >= 999_500_000;
  const base = useB ? 1_000_000_000 : 1_000_000;
  const suffix = useB ? "B" : "M";
  const scaled = abs / base;
  const str =
    scaled >= 10
      ? String(Math.round(scaled))
      : scaled.toFixed(1).replace(/\.0$/, "");
  return `${sign}${str}${suffix}`;
}

export async function LeaderboardTable({ rows, activeSort }: Props) {
  const t = await getTranslations("leaderboard");
  return (
    <div>
      <nav
        className="mb-6 flex gap-1 overflow-x-auto border-b border-foreground/10"
        aria-label={t("navLabel")}
      >
        {SORT_KEYS.map((key) => (
          <Link
            key={key}
            href={`/leaderboard?sort=${key}`}
            aria-current={activeSort === key ? "page" : undefined}
            className={cn(
              "px-3 py-2 font-sans text-sm uppercase tracking-widest transition-colors",
              activeSort === key
                ? "border-b-2 border-foreground text-foreground"
                : "border-b-2 border-transparent text-foreground-muted hover:text-foreground",
            )}
            title={t(`sort_${key}_hint`)}
          >
            {t(`sort_${key}`)}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
          <p className="font-display text-xl uppercase tracking-tight text-foreground break-words sm:text-2xl">
            {t("emptyTitle")}
          </p>
          <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
            {t("emptyLead")}
          </p>
          <Link
            href="/markets"
            className="mt-6 inline-block rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
          >
            {t("browseMarkets")} →
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((r) => (
            <li key={r.user_id}>
              <Link
                href={`/profile/${r.username}`}
                prefetch={false}
                className="grid grid-cols-[2rem_2.25rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-foreground/10 bg-background-elevated/30 px-2.5 py-2.5 transition-colors hover:bg-foreground/[0.04] sm:grid-cols-[2.5rem_2.5rem_minmax(0,1fr)_auto] sm:gap-3 sm:px-3"
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
                  <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                    @{r.username} · {r.tier.toUpperCase()}
                    {activeSort !== "achievements"
                      ? ` · ${r.achievement_count} ${t("achShort")}`
                      : ""}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {activeSort === "volume" ? (
                    <p
                      className="font-display text-base tabular text-foreground sm:text-lg"
                      title={formatNumber(r.total_lost)}
                    >
                      {formatCompact(r.total_lost)}
                    </p>
                  ) : activeSort === "achievements" ? (
                    <p className="font-display text-base tabular text-foreground sm:text-lg">
                      {formatNumber(r.achievement_count)}
                    </p>
                  ) : (
                    <p
                      className={cn(
                        "font-display text-base tabular sm:text-lg",
                        r.profit > 0
                          ? "text-streak-win"
                          : r.profit < 0
                            ? "text-streak-loss"
                            : "text-foreground",
                      )}
                      title={formatNumber(r.profit)}
                    >
                      {r.profit > 0 ? "+" : ""}
                      {formatCompact(r.profit)}
                    </p>
                  )}
                  <p className="font-mono text-[10px] tabular text-foreground-subtle">
                    {t("betCount", { count: r.bet_count })}
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
