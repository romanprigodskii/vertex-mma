import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { priceToDecimalOdds } from "@/lib/lmsr";
import type { EventMarketsGroup } from "@/lib/markets";

const TYPE_LABEL: Record<string, string> = {
  winner: "Winner",
  method: "Method",
  round: "Round",
  distance: "Distance",
  prop: "Prop",
};

const TYPE_ORDER: Record<string, number> = {
  winner: 0,
  method: 1,
  round: 2,
  distance: 3,
  prop: 4,
};

export function EventMarketsAccordion({
  events,
}: {
  events: EventMarketsGroup[];
}) {
  if (events.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
        <p className="font-sans font-bold text-2xl uppercase tracking-tight text-foreground">
          No open markets
        </p>
        <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
          New markets get generated automatically when the UFC schedules upcoming
          bouts. Check back when the next card is announced.
        </p>
        <Link
          href="/events"
          className="mt-6 inline-block rounded-sm border border-foreground/15 px-4 py-2 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
        >
          Browse upcoming events →
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
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 hover:bg-foreground/[0.04]">
            <div className="flex min-w-0 flex-1 items-baseline gap-3">
              <ChevronRight
                className="h-4 w-4 shrink-0 text-foreground-muted transition-transform group-open:rotate-90"
                aria-hidden
              />
              <h3 className="truncate font-sans font-bold text-lg uppercase tracking-tight text-foreground">
                {event.event_short_name ?? event.event_name}
              </h3>
            </div>
            <div className="shrink-0 text-right font-mono text-[11px] tabular text-foreground-subtle">
              <span>
                {new Date(event.event_date).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <span className="mx-2">·</span>
              <span>
                {event.bouts.length} bout
                {event.bouts.length === 1 ? "" : "s"}
              </span>
              <span className="mx-2">·</span>
              <span>{event.total_markets} markets</span>
            </div>
          </summary>

          <div className="flex flex-col gap-4 border-t border-foreground/10 px-4 py-4">
            {event.bouts.map((bout) => (
              <BoutMarketsBlock key={bout.bout_id} bout={bout} />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function BoutMarketsBlock({
  bout,
}: {
  bout: EventMarketsGroup["bouts"][number];
}) {
  const ordered = [...bout.markets].sort(
    (a, b) =>
      (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99),
  );
  const tag = bout.is_main_event
    ? "Main"
    : bout.is_co_main_event
      ? "Co-main"
      : null;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h4 className="font-sans font-bold text-base uppercase tracking-tight text-foreground">
          {bout.fighter_a_name}{" "}
          <span className="text-foreground-subtle">vs</span>{" "}
          {bout.fighter_b_name}
        </h4>
        <p className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {tag ? `${tag} · ` : ""}
          {bout.weight_class.replace(/_/g, " ")}
          {bout.is_title_fight ? " · Title" : ""}
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
                  {TYPE_LABEL[m.type] ?? m.type}
                </p>
                <TopOutcomePreview outcomes={m.outcomes} />
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
}: {
  outcomes: Array<{
    label: string;
    order_index: number;
    current_price: number;
  }>;
}) {
  if (!outcomes || outcomes.length === 0) {
    return (
      <p className="mt-1 font-sans text-xs text-foreground-subtle">
        No outcomes
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
