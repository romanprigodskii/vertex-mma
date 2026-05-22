import { ChevronRight } from "lucide-react";

import { OddsTile } from "@/components/markets/odds-tile";
import type { MarketCardOutcome } from "@/lib/markets";

const TYPE_LABEL: Record<string, string> = {
  winner: "Winner",
  method: "Method",
  round: "Round",
  distance: "Distance",
  prop: "Prop",
};

/**
 * One collapsible market — a `<details>` section whose body is the market's
 * outcomes as odds tiles. Pure CSS toggle, no client JS.
 */
export function MarketSection({
  market,
  defaultOpen = true,
}: {
  market: {
    id: string;
    type: string;
    question: string;
    outcomes: MarketCardOutcome[];
  };
  defaultOpen?: boolean;
}) {
  const outcomes = [...market.outcomes].sort(
    (a, b) => a.order_index - b.order_index,
  );
  if (outcomes.length === 0) return null;

  return (
    <details
      open={defaultOpen}
      className="group/section border-t border-foreground/[0.07] first:border-t-0"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-2.5">
        <span className="flex shrink-0 items-center gap-2">
          <ChevronRight
            className="h-3.5 w-3.5 text-foreground-subtle transition-transform group-open/section:rotate-90"
            aria-hidden
          />
          <span className="font-sans text-xs font-medium uppercase tracking-widest text-foreground">
            {TYPE_LABEL[market.type] ?? market.type}
          </span>
        </span>
        <span className="min-w-0 truncate font-sans text-[11px] text-foreground-subtle">
          {market.question}
        </span>
      </summary>
      <ul className="grid grid-cols-1 gap-1.5 pb-3 sm:grid-cols-2">
        {outcomes.map((o) => (
          <li key={o.id}>
            <OddsTile
              marketId={market.id}
              outcomeId={o.id}
              label={o.label}
              price={o.current_price}
            />
          </li>
        ))}
      </ul>
    </details>
  );
}
