import { getLocale, getTranslations } from "next-intl/server";
import { ArrowRight } from "lucide-react";

import { NewsSidebarSearch } from "@/components/news/news-sidebar-search";
import { Link } from "@/i18n/navigation";
import type { UpcomingEventSidebar } from "@/lib/event-detail";
import type { NewsFeedItem } from "@/lib/news";

function formatEventDate(iso: string, locale: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(locale === "ru" ? "ru-RU" : "en-US", {
    month: "short",
    day: "numeric",
  });
}

interface NewsSidebarLabels {
  short: { min: (n: number) => string; hr: (n: number) => string; day: (n: number) => string };
  justNow: string;
  today: string;
  tomorrow: string;
  daysOut: (n: number) => string;
  mainEventLabel: string;
  fightCount: (n: number) => string;
  viewCard: string;
  noOther: string;
  nextEventLabel: string;
  latestNewsLabel: string;
  findFighter: string;
}

function formatRelative(iso: string, labels: NewsSidebarLabels, locale: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, Math.round((now - then) / 1000));
  if (diffSec < 60) return labels.justNow;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return labels.short.min(diffMin);
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return labels.short.hr(diffHr);
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return labels.short.day(diffDay);
  return formatEventDate(iso, locale);
}

function daysUntil(iso: string, labels: NewsSidebarLabels): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffDay = Math.round((then - now) / 86_400_000);
  if (diffDay <= 0) return labels.today;
  if (diffDay === 1) return labels.tomorrow;
  return labels.daysOut(diffDay);
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

function NextEventWidget({
  event,
  labels,
  locale,
}: {
  event: UpcomingEventSidebar;
  labels: NewsSidebarLabels;
  locale: string;
}) {
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
        {event.promotion} · {formatEventDate(event.date, locale).toUpperCase()}
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
              · {labels.mainEventLabel}
            </span>
          ) : null}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-2 font-mono text-[11px] tabular-nums text-foreground-muted">
        <span>{labels.fightCount(event.bout_count)}</span>
        <span aria-hidden>·</span>
        <span>{daysUntil(event.date, labels)}</span>
      </div>
      <span className="mt-3 inline-flex items-center gap-1 text-sm text-primary group-hover:underline">
        {labels.viewCard} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </span>
    </Link>
  );
}

function LatestNewsWidget({
  items,
  labels,
  locale,
}: {
  items: NewsFeedItem[];
  labels: NewsSidebarLabels;
  locale: string;
}) {
  if (items.length === 0) {
    return (
      <p className="font-sans text-xs text-foreground-subtle">
        {labels.noOther}
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
            {item.source_name} · {formatRelative(item.published_at, labels, locale)}
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

export async function NewsSidebar({
  nextEvent,
  latestNews,
}: {
  nextEvent: UpcomingEventSidebar | null;
  latestNews: NewsFeedItem[];
}) {
  const t = await getTranslations("news");
  const locale = await getLocale();
  const labels: NewsSidebarLabels = {
    short: {
      min: (n) => t("shortMinutes", { n }),
      hr: (n) => t("shortHours", { n }),
      day: (n) => t("shortDays", { n }),
    },
    justNow: t("justNow"),
    today: t("today"),
    tomorrow: t("tomorrow"),
    daysOut: (n) => t("daysOut", { n }),
    mainEventLabel: t("mainEventLabel"),
    fightCount: (n) => t("fightCountSidebar", { count: n }),
    viewCard: t("viewCard"),
    noOther: t("noOtherStories"),
    nextEventLabel: t("nextEventLabel"),
    latestNewsLabel: t("latestNewsLabel"),
    findFighter: t("findFighter"),
  };
  return (
    <aside className="flex flex-col gap-4 lg:sticky lg:top-8">
      {nextEvent ? (
        <Widget label={labels.nextEventLabel}>
          <NextEventWidget event={nextEvent} labels={labels} locale={locale} />
        </Widget>
      ) : null}
      <Widget label={labels.latestNewsLabel}>
        <LatestNewsWidget items={latestNews} labels={labels} locale={locale} />
      </Widget>
      <Widget label={labels.findFighter}>
        <NewsSidebarSearch />
      </Widget>
    </aside>
  );
}
