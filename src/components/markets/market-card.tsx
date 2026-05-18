import Link from "next/link";

import type { MarketCardOutcome, MarketListItem } from "@/lib/markets";

function lastName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts[parts.length - 1] ?? full;
}

const METHOD_SHORT = ["KO", "Sub", "Dec"];

export function MarketCard({ market }: { market: MarketListItem }) {
  const isMethod = market.type === "method";
  const aOutcomes = market.outcomes.filter(
    (o) => o.order_index < (isMethod ? 3 : 1),
  );
  const bOutcomes = market.outcomes.filter(
    (o) => o.order_index >= (isMethod ? 3 : 1),
  );

  return (
    <Link
      href={`/markets/${market.id}`}
      prefetch={false}
      className="block rounded-md border border-foreground/10 bg-background-elevated/30 p-4 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.04]"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {market.event_name}
        </p>
        <span className="shrink-0 rounded-sm border border-foreground/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-foreground-muted">
          {isMethod ? "Method" : "Winner"}
        </span>
      </div>
      <h3 className="mt-2 font-display text-lg uppercase tracking-tight text-foreground">
        {market.fighter_a_name}{" "}
        <span className="text-foreground-subtle">vs</span>{" "}
        {market.fighter_b_name}
      </h3>

      {isMethod ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <FighterColumn
            name={market.fighter_a_name}
            outcomes={aOutcomes}
          />
          <FighterColumn
            name={market.fighter_b_name}
            outcomes={bOutcomes}
          />
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-sm bg-foreground/[0.04] px-2 py-1.5">
            <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
              {lastName(market.fighter_a_name)}
            </p>
            <p className="font-display text-base tabular text-foreground">
              {((aOutcomes[0]?.current_price ?? 0.5) * 100).toFixed(0)}%
            </p>
          </div>
          <div className="rounded-sm bg-foreground/[0.04] px-2 py-1.5">
            <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
              {lastName(market.fighter_b_name)}
            </p>
            <p className="font-display text-base tabular text-foreground">
              {((bOutcomes[0]?.current_price ?? 0.5) * 100).toFixed(0)}%
            </p>
          </div>
        </div>
      )}

      <p className="mt-3 font-mono text-[10px] tabular text-foreground-subtle">
        Vol {market.total_volume.toLocaleString()} ·{" "}
        {market.unique_traders} trader
        {market.unique_traders === 1 ? "" : "s"}
      </p>
    </Link>
  );
}

function FighterColumn({
  name,
  outcomes,
}: {
  name: string;
  outcomes: MarketCardOutcome[];
}) {
  return (
    <div className="rounded-sm bg-foreground/[0.04] px-2 py-1.5">
      <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        {lastName(name)}
      </p>
      <div className="mt-1 flex flex-col gap-0.5">
        {outcomes.map((o, i) => (
          <div
            key={o.order_index}
            className="flex items-baseline justify-between"
          >
            <span className="font-mono text-[9px] uppercase tracking-widest text-foreground-subtle">
              {METHOD_SHORT[i]}
            </span>
            <span className="font-display text-xs tabular text-foreground">
              {(o.current_price * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
