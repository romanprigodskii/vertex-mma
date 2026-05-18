import Link from "next/link";

import type { MarketListItem } from "@/lib/markets";

function lastName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts[parts.length - 1] ?? full;
}

export function MarketCard({ market }: { market: MarketListItem }) {
  return (
    <Link
      href={`/markets/${market.id}`}
      prefetch={false}
      className="block rounded-md border border-foreground/10 bg-background-elevated/30 p-4 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.04]"
    >
      <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        {market.event_name}
      </p>
      <h3 className="mt-2 font-display text-lg uppercase tracking-tight text-foreground">
        {market.fighter_a_name}{" "}
        <span className="text-foreground-subtle">vs</span>{" "}
        {market.fighter_b_name}
      </h3>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-sm bg-foreground/[0.04] px-2 py-1.5">
          <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
            {lastName(market.fighter_a_name)}
          </p>
          <p className="font-display text-base tabular text-foreground">
            {(market.outcome_a_price * 100).toFixed(0)}%
          </p>
        </div>
        <div className="rounded-sm bg-foreground/[0.04] px-2 py-1.5">
          <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
            {lastName(market.fighter_b_name)}
          </p>
          <p className="font-display text-base tabular text-foreground">
            {(market.outcome_b_price * 100).toFixed(0)}%
          </p>
        </div>
      </div>
      <p className="mt-3 font-mono text-[10px] tabular text-foreground-subtle">
        Vol {market.total_volume.toLocaleString()} ·{" "}
        {market.unique_traders} trader
        {market.unique_traders === 1 ? "" : "s"}
      </p>
    </Link>
  );
}
