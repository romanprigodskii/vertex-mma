import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { NewsSidebarSearch } from "@/components/news/news-sidebar-search";
import type { UpcomingEventSidebar } from "@/lib/event-detail";
import type { NewsFeedItem } from "@/lib/news";

function formatEventDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, Math.round((now - then) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;
  return formatEventDate(iso);
}

function daysUntil(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffDay = Math.round((then - now) / 86_400_000);
  if (diffDay <= 0) return "today";
  if (diffDay === 1) return "tomorrow";
  return `${diffDay} days out`;
}

function Widget({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-foreground/10 bg-background-elevated/60 p-4">
      <p className="mb-3 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-foreground-subtle">
        {label}
      </p>
      {children}
    </section>
  );
}

function NextEventWidget({ event }: { event: UpcomingEventSidebar }) {
  const matchup =
    event.main_event_fighter_a && event.main_event_fighter_b
      ? `${event.main_event_fighter_a} vs ${event.main_event_fighter_b}`
      : null;
  return (
    <Link
      href={`/events/${event.slug}`}
      prefetch={false}
      className="group block"
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary">
        {event.promotion} · {formatEventDate(event.date).toUpperCase()}
      </span>
      <h4 className="mt-1.5 font-display text-2xl uppercase leading-[1.05] tracking-tight text-foreground">
        {event.short_name ?? event.name}
      </h4>
      {matchup ? (
        <p className="mt-2 text-sm leading-snug text-foreground">
          {matchup}
          {event.main_event_weight_class ? (
            <span className="mt-1 block text-xs text-foreground-muted">
              {event.main_event_weight_class
                .replace(/_/g, " ")
                .replace(/\b\w/g, (c) => c.toUpperCase())}{" "}
              · Main event
            </span>
          ) : null}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-2 font-mono text-[11px] tabular-nums text-foreground-muted">
        <span>{event.bout_count} fights</span>
        <span aria-hidden>·</span>
        <span>{daysUntil(event.date)}</span>
      </div>
      <span className="mt-3 inline-flex items-center gap-1 text-sm text-primary group-hover:underline">
        View card <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </span>
    </Link>
  );
}

function LatestNewsWidget({ items }: { items: NewsFeedItem[] }) {
  if (items.length === 0) {
    return (
      <p className="font-sans text-xs text-foreground-subtle">
        No other stories yet.
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {items.map((item, i) => (
        <li
          key={item.id}
          className={
            i === 0
              ? "pb-3"
              : "border-t border-foreground/10 py-3 last:pb-0"
          }
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-foreground-subtle">
            {item.source_name} · {formatRelative(item.published_at)}
          </span>
          <Link
            href={`/news/${item.id}`}
            prefetch={false}
            className="mt-1 block text-[13px] leading-snug text-foreground hover:text-primary"
          >
            {item.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function NewsSidebar({
  nextEvent,
  latestNews,
}: {
  nextEvent: UpcomingEventSidebar | null;
  latestNews: NewsFeedItem[];
}) {
  return (
    <aside className="flex flex-col gap-4 lg:sticky lg:top-8">
      {nextEvent ? (
        <Widget label="Next event">
          <NextEventWidget event={nextEvent} />
        </Widget>
      ) : null}
      <Widget label="Latest news">
        <LatestNewsWidget items={latestNews} />
      </Widget>
      <Widget label="Find a fighter">
        <NewsSidebarSearch />
      </Widget>
    </aside>
  );
}
