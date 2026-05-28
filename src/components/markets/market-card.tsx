import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";
import { priceToDecimalOdds } from "@/lib/lmsr";
import type { MarketCardOutcome, MarketListItem } from "@/lib/markets";

function lastName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts[parts.length - 1] ?? full;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const METHOD_SHORT = ["KO", "Sub", "Dec"];

export async function MarketCard({ market }: { market: MarketListItem }) {
  const t = await getTranslations("markets");
  const typeLabel = t.has(`type_${market.type}`)
    ? t(`type_${market.type}`)
    : market.type;
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
          {typeLabel}
        </span>
      </div>
      <h3 className="mt-2 font-display text-lg uppercase tracking-tight text-foreground">
        {market.fighter_a_name}{" "}
        <span className="mx-1.5 align-middle font-sans text-[0.55em] font-medium normal-case text-foreground-subtle">vs</span>{" "}
        {market.fighter_b_name}
      </h3>

      <MarketBody market={market} favoriteLabel={t("favorite")} plusMore={(n) => t("plusMore", { n })} />

      <p className="mt-3 font-mono text-[10px] tabular text-foreground-subtle">
        {t("volTraders", {
          vol: market.total_volume.toLocaleString(),
          count: market.unique_traders,
        })}
      </p>
    </Link>
  );
}

function MarketBody({
  market,
  favoriteLabel,
  plusMore,
}: {
  market: MarketListItem;
  favoriteLabel: string;
  plusMore: (n: number) => string;
}) {
  if (market.type === "method") {
    const aOutcomes = market.outcomes.filter((o) => o.order_index < 3);
    const bOutcomes = market.outcomes.filter((o) => o.order_index >= 3);
    return (
      <div className="mt-3 grid grid-cols-2 gap-2">
        <MethodColumn name={market.fighter_a_name} outcomes={aOutcomes} />
        <MethodColumn name={market.fighter_b_name} outcomes={bOutcomes} />
      </div>
    );
  }
  if (market.type === "round") {
    return (
      <RoundCompact
        outcomes={market.outcomes}
        favoriteLabel={favoriteLabel}
        plusMore={plusMore}
      />
    );
  }
  if (market.type === "distance" || market.type === "prop") {
    return <BinaryCompact outcomes={market.outcomes} />;
  }

  // winner (default)
  const a = market.outcomes.find((o) => o.order_index === 0);
  const b = market.outcomes.find((o) => o.order_index === 1);
  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      <WinnerCell name={lastName(market.fighter_a_name)} price={a?.current_price ?? 0.5} />
      <WinnerCell name={lastName(market.fighter_b_name)} price={b?.current_price ?? 0.5} />
    </div>
  );
}

function WinnerCell({ name, price }: { name: string; price: number }) {
  return (
    <div className="rounded-sm bg-foreground/[0.04] px-2 py-1.5">
      <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        {name}
      </p>
      <p className="font-display text-base tabular text-foreground">
        {(price * 100).toFixed(0)}%
      </p>
      <p className="font-mono text-[10px] tabular text-foreground-subtle">
        {priceToDecimalOdds(price)}x
      </p>
    </div>
  );
}

function MethodColumn({
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
            <span className="text-right">
              <span className="font-display text-xs tabular text-foreground">
                {(o.current_price * 100).toFixed(0)}%
              </span>
              <span className="ml-1.5 font-mono text-[9px] tabular text-foreground-subtle">
                {priceToDecimalOdds(o.current_price)}x
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BinaryCompact({ outcomes }: { outcomes: MarketCardOutcome[] }) {
  const sorted = [...outcomes].sort((a, b) => a.order_index - b.order_index);
  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      {sorted.slice(0, 2).map((o) => (
        <div
          key={o.order_index}
          className="rounded-sm bg-foreground/[0.04] px-2 py-1.5"
        >
          <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
            {truncate(o.label, 18)}
          </p>
          <p className="font-display text-base tabular text-foreground">
            {(o.current_price * 100).toFixed(0)}%
          </p>
          <p className="font-mono text-[10px] tabular text-foreground-subtle">
            {priceToDecimalOdds(o.current_price)}x
          </p>
        </div>
      ))}
    </div>
  );
}

function RoundCompact({
  outcomes,
  favoriteLabel,
  plusMore,
}: {
  outcomes: MarketCardOutcome[];
  favoriteLabel: string;
  plusMore: (n: number) => string;
}) {
  if (outcomes.length === 0) return null;
  const top = [...outcomes].sort(
    (a, b) => b.current_price - a.current_price,
  )[0];
  return (
    <div className="mt-3 rounded-sm bg-foreground/[0.04] px-2 py-1.5">
      <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        {favoriteLabel} · {top.label}
      </p>
      <p className="font-display text-base tabular text-foreground">
        {(top.current_price * 100).toFixed(0)}%
        <span className="ml-1.5 font-mono text-[10px] tabular text-foreground-subtle">
          {priceToDecimalOdds(top.current_price)}x
        </span>
        <span className="ml-2 font-mono text-[10px] text-foreground-subtle">
          {plusMore(outcomes.length - 1)}
        </span>
      </p>
    </div>
  );
}
