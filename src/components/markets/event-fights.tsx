import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { MarketSection } from "@/components/markets/market-section";
import { OddsTile } from "@/components/markets/odds-tile";
import type { EventMarketsGroup } from "@/lib/markets";

const TYPE_ORDER: Record<string, number> = {
  method: 0,
  round: 1,
  distance: 2,
  prop: 3,
};

function lastName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts[parts.length - 1] ?? full;
}

/**
 * Fonbet-style markets list: events → fights. Each fight collapsed shows
 * just the winner odds; expanding it reveals every other market as a
 * collapsible section. All native `<details>` — no client JS.
 */
export function EventFights({ events }: { events: EventMarketsGroup[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
        <p className="font-display text-2xl uppercase tracking-tight text-foreground">
          No open markets
        </p>
        <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
          Markets are generated automatically when the UFC schedules
          upcoming bouts. Check back when the next card is announced.
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
          open={idx === 0}
          className="group/event overflow-hidden rounded-md border border-foreground/10 bg-background-elevated/30"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 hover:bg-foreground/[0.04]">
            <div className="flex min-w-0 flex-1 items-baseline gap-3">
              <ChevronRight
                className="h-4 w-4 shrink-0 text-foreground-muted transition-transform group-open/event:rotate-90"
                aria-hidden
              />
              <h2 className="truncate font-display text-lg uppercase tracking-tight text-foreground">
                {event.event_short_name ?? event.event_name}
              </h2>
            </div>
            <span className="shrink-0 font-mono text-[11px] tabular text-foreground-subtle">
              {new Date(event.event_date).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}
              {" · "}
              {event.bouts.length} fight{event.bouts.length === 1 ? "" : "s"}
            </span>
          </summary>
          <div className="flex flex-col border-t border-foreground/10">
            {event.bouts.map((bout) => (
              <FightRow key={bout.bout_id} bout={bout} />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function FightRow({ bout }: { bout: EventMarketsGroup["bouts"][number] }) {
  const winner = bout.markets.find((m) => m.type === "winner");
  const others = bout.markets
    .filter((m) => m.type !== "winner")
    .sort((a, b) => (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99));
  const wA = winner?.outcomes.find((o) => o.order_index === 0);
  const wB = winner?.outcomes.find((o) => o.order_index === 1);
  const tag = bout.is_main_event
    ? "Main"
    : bout.is_co_main_event
      ? "Co-main"
      : null;

  return (
    <details className="group/fight border-t border-foreground/[0.07] first:border-t-0">
      <summary className="flex cursor-pointer list-none flex-col gap-2 px-4 py-3 hover:bg-foreground/[0.03] sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ChevronRight
            className="h-3.5 w-3.5 shrink-0 text-foreground-subtle transition-transform group-open/fight:rotate-90"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="truncate font-display text-sm uppercase tracking-tight text-foreground sm:text-base">
              {bout.fighter_a_name}{" "}
              <span className="text-foreground-subtle">vs</span>{" "}
              {bout.fighter_b_name}
            </p>
            <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
              {tag ? `${tag} · ` : ""}
              {bout.weight_class.replace(/_/g, " ")}
              {" · "}
              {bout.is_main_event || bout.is_title_fight ? "5R" : "3R"}
              {bout.is_title_fight ? " · Title" : ""}
              {others.length > 0 ? ` · +${others.length} more` : ""}
            </p>
          </div>
        </div>
        {winner && wA && wB ? (
          <div className="grid shrink-0 grid-cols-2 gap-1.5 sm:w-[260px]">
            <OddsTile
              marketId={winner.id}
              outcomeId={wA.id}
              label={lastName(bout.fighter_a_name)}
              price={wA.current_price}
            />
            <OddsTile
              marketId={winner.id}
              outcomeId={wB.id}
              label={lastName(bout.fighter_b_name)}
              price={wB.current_price}
            />
          </div>
        ) : null}
      </summary>
      <div className="border-t border-foreground/[0.06] bg-background-base/30 px-4">
        {others.map((m) => (
          <MarketSection key={m.id} market={m} defaultOpen={false} />
        ))}
        <Link
          href={`/markets/fight/${bout.bout_id}`}
          prefetch={false}
          className="flex items-center gap-1 border-t border-foreground/[0.07] py-2.5 font-sans text-xs text-primary hover:underline"
        >
          Full fight page
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </details>
  );
}
