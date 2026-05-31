import { getLocale, getTranslations } from "next-intl/server";
import { ChevronRight } from "lucide-react";

import { Link } from "@/i18n/navigation";
import { priceToDecimalOdds } from "@/lib/lmsr";
import { marketHasOdds } from "@/lib/market-odds";
import type { EventMarketsGroup } from "@/lib/markets";

const TYPE_ORDER: Record<string, number> = {
  winner: 0,
  method: 1,
  round: 2,
  distance: 3,
  prop: 4,
};

export async function EventMarketsAccordion({
  events,
}: {
  events: EventMarketsGroup[];
}) {
  const t = await getTranslations("markets");
  const tWeight = await getTranslations("weight");
  const locale = await getLocale();
  const dateFmt = locale === "ru" ? "ru-RU" : "en-US";

  if (events.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
        <p className="font-display text-xl uppercase tracking-tight text-foreground break-words sm:text-2xl">
          {t("noOpenMarkets")}
        </p>
        <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
          {t("noOpenMarketsHint")}
        </p>
        <Link
          href="/events"
          className="mt-6 inline-block rounded-sm border border-foreground/15 px-4 py-2 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
        >
          {t("browseUpcoming")} →
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {events.map((event, idx) => (
        <details
          key={event.event_id}
          // First event open by default so the page lands on something
          // actionable; the rest stay collapsed.
          open={idx === 0}
          className="group overflow-hidden rounded-md border border-foreground/10 bg-background-elevated/30"
        >
          <summary className="cursor-pointer list-none px-4 py-3 hover:bg-foreground/[0.04] sm:flex sm:items-baseline sm:justify-between sm:gap-3">
            <div className="flex min-w-0 items-baseline gap-3 sm:flex-1">
              <ChevronRight
                className="h-4 w-4 shrink-0 text-foreground-muted transition-transform group-open:rotate-90"
                aria-hidden
              />
              <h3 className="truncate font-display text-lg uppercase tracking-tight text-foreground">
                {event.event_short_name ?? event.event_name}
              </h3>
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 pl-7 font-mono text-[11px] tabular text-foreground-subtle sm:mt-0 sm:shrink-0 sm:justify-end sm:pl-0">
              <span className="whitespace-nowrap">
                {new Date(event.event_date).toLocaleDateString(dateFmt, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <span aria-hidden>·</span>
              <span className="whitespace-nowrap">{t("boutCount", { count: event.bouts.length })}</span>
              <span aria-hidden>·</span>
              <span className="whitespace-nowrap">{t("marketCount", { count: event.total_markets })}</span>
            </div>
          </summary>

          <div className="flex flex-col gap-4 border-t border-foreground/10 px-4 py-4">
            {event.bouts.map((bout) => {
              const tag = bout.is_main_event
                ? t("main")
                : bout.is_co_main_event
                  ? t("coMain")
                  : null;
              const weight = tWeight.has(bout.weight_class)
                ? tWeight(bout.weight_class)
                : bout.weight_class.replace(/_/g, " ");
              return (
                <BoutMarketsBlock
                  key={bout.bout_id}
                  bout={bout}
                  tag={tag}
                  weight={weight}
                  titleLabel={t("title")}
                  typeLabel={(type) =>
                    t.has(`type_${type}`) ? t(`type_${type}`) : type
                  }
                  noOutcomesLabel={t("noOutcomes")}
                  oddsComingSoonLabel={t("oddsComingSoon")}
                />
              );
            })}
          </div>
        </details>
      ))}
    </div>
  );
}

function BoutMarketsBlock({
  bout,
  tag,
  weight,
  titleLabel,
  typeLabel,
  noOutcomesLabel,
  oddsComingSoonLabel,
}: {
  bout: EventMarketsGroup["bouts"][number];
  tag: string | null;
  weight: string;
  titleLabel: string;
  typeLabel: (type: string) => string;
  noOutcomesLabel: string;
  oddsComingSoonLabel: string;
}) {
  const ordered = [...bout.markets].sort(
    (a, b) =>
      (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99),
  );
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="min-w-0 font-display text-base uppercase tracking-tight text-foreground">
          {bout.fighter_a_name}{" "}
          <span className="mx-1.5 align-middle font-sans text-[0.55em] font-medium normal-case text-foreground-subtle">vs</span>{" "}
          {bout.fighter_b_name}
        </h4>
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {tag ? `${tag} · ` : ""}
          {weight}
          {bout.is_title_fight ? ` · ${titleLabel}` : ""}
        </p>
      </div>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {ordered.map((m) => (
          <li key={m.id}>
            <Link
              href={`/markets/${m.id}`}
              prefetch={false}
              className="flex items-center justify-between gap-3 rounded-sm border border-foreground/10 bg-foreground/[0.02] px-3 py-2 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.05]"
            >
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {typeLabel(m.type)}
                </p>
                <TopOutcomePreview
                  outcomes={m.outcomes}
                  totalVolume={m.total_volume}
                  noOutcomesLabel={noOutcomesLabel}
                  oddsComingSoonLabel={oddsComingSoonLabel}
                />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TopOutcomePreview({
  outcomes,
  totalVolume,
  noOutcomesLabel,
  oddsComingSoonLabel,
}: {
  outcomes: Array<{
    label: string;
    order_index: number;
    current_price: number;
  }>;
  totalVolume: number;
  noOutcomesLabel: string;
  oddsComingSoonLabel: string;
}) {
  if (!outcomes || outcomes.length === 0) {
    return (
      <p className="mt-1 font-sans text-xs text-foreground-subtle">
        {noOutcomesLabel}
      </p>
    );
  }
  // Don't render the LMSR cold-start template as if it were a real line.
  if (!marketHasOdds(outcomes, totalVolume)) {
    return (
      <p className="mt-1 font-sans text-xs text-foreground-subtle">
        {oddsComingSoonLabel}
      </p>
    );
  }
  const top = [...outcomes].sort(
    (a, b) => b.current_price - a.current_price,
  )[0];
  const label =
    top.label.length > 24 ? `${top.label.slice(0, 22)}…` : top.label;
  return (
    <div className="mt-1 flex items-baseline justify-between gap-2">
      <span className="truncate font-sans text-sm text-foreground">
        {label}
      </span>
      <span className="shrink-0 font-mono text-xs tabular">
        <span className="text-foreground">
          {(top.current_price * 100).toFixed(0)}%
        </span>
        <span className="ml-1.5 text-foreground-subtle">
          {priceToDecimalOdds(top.current_price)}x
        </span>
      </span>
    </div>
  );
}
