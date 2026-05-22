import Link from "next/link";

import { priceToDecimalOdds } from "@/lib/lmsr";

/**
 * One Fonbet-style odds tile — an outcome label and its decimal odds.
 * Clicking it lands on the market's bet page with this outcome preselected.
 */
export function OddsTile({
  marketId,
  outcomeId,
  label,
  price,
}: {
  marketId: string;
  outcomeId: string;
  label: string;
  price: number;
}) {
  return (
    <Link
      href={`/markets/${marketId}?outcome=${outcomeId}`}
      prefetch={false}
      className="flex h-full items-center justify-between gap-3 rounded-sm border border-foreground/10 bg-foreground/[0.03] px-3 py-2 transition-colors hover:border-primary/45 hover:bg-foreground/[0.06]"
    >
      <span className="min-w-0 truncate font-sans text-xs text-foreground-muted">
        {label}
      </span>
      <span className="shrink-0 font-mono text-sm font-semibold tabular text-foreground">
        {priceToDecimalOdds(price)}
      </span>
    </Link>
  );
}
