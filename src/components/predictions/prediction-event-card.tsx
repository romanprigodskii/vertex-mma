import Link from "next/link";

import type { PredictionEventListItem } from "@/lib/predictions";

export function PredictionEventCard({
  event,
}: {
  event: PredictionEventListItem;
}) {
  const closesMs = new Date(event.closes_at).getTime();
  const hoursLeft = Math.max(
    0,
    Math.floor((closesMs - Date.now()) / 3_600_000),
  );
  const dateLabel = new Date(event.event_date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <Link
      href={`/predictions/${event.id}`}
      prefetch={false}
      className="block rounded-md border border-foreground/10 bg-background-elevated/30 p-4 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.04]"
    >
      <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        {dateLabel}
      </p>
      <h3 className="mt-2 font-display text-lg uppercase tracking-tight text-foreground line-clamp-2">
        {event.event_name}
      </h3>
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 font-mono text-[11px] tabular text-foreground-subtle">
        <span>{event.bout_count} bouts</span>
        <span>
          {event.total_participants} predicting · closes in {hoursLeft}h
        </span>
      </div>
    </Link>
  );
}
