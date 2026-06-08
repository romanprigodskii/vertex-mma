import type { Metadata } from "next";
import {
  getLocale,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Link, redirect } from "@/i18n/navigation";
import { type EventListFilter, listEvents } from "@/lib/event-detail";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "eventsList" });
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
  };
}

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ filter?: string }>;
}

function parseFilter(raw: string | undefined): EventListFilter {
  if (raw === "past" || raw === "all") return raw;
  return "upcoming";
}

const TAB_KEYS: EventListFilter[] = ["upcoming", "past", "all"];

const STATUS_KEY: Record<string, string> = {
  completed: "statusCompleted",
  upcoming: "statusUpcoming",
  in_progress: "statusInProgress",
  cancelled: "statusCancelled",
  postponed: "statusPostponed",
};

// Tab-aware empty state: a quiet "Upcoming" period shouldn't read like a
// broken/empty site, so each tab gets its own copy plus a pointer to a tab
// that's more likely to have rows. "all" has nowhere else to send people.
const EMPTY_COPY: Record<
  EventListFilter,
  {
    titleKey: string;
    hintKey: string;
    cta: { href: string; labelKey: string } | null;
  }
> = {
  upcoming: {
    titleKey: "emptyUpcomingTitle",
    hintKey: "emptyUpcomingHint",
    cta: { href: "/events?filter=past", labelKey: "emptyCtaPast" },
  },
  past: {
    titleKey: "emptyPastTitle",
    hintKey: "emptyPastHint",
    cta: { href: "/events", labelKey: "emptyCtaUpcoming" },
  },
  all: { titleKey: "emptyAllTitle", hintKey: "emptyAllHint", cta: null },
};

export default async function EventsListPage({
  params,
  searchParams,
}: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("eventsList");
  const activeLocale = await getLocale();
  const sp = await searchParams;
  // Canonicalize the default view to bare /events so the Upcoming tab has a
  // single URL that matches its own href — old ?filter=upcoming shares don't
  // linger as a non-canonical duplicate of /events.
  if (sp.filter === "upcoming") redirect({ href: "/events", locale });
  const filter = parseFilter(sp.filter);
  // Provisional events auto-created from news (no bouts yet) otherwise render
  // as a broken "0 bouts" card. There's no "card TBA" message key, so drop
  // them here — the list only shows events that have a real bout card.
  // Filtering before the empty check keeps the tab-aware empty state correct
  // when every row gets dropped.
  const events = (await listEvents(filter, 60)).filter((e) => e.bout_count > 0);
  const emptyCopy = EMPTY_COPY[filter];
  const dateFmt = activeLocale === "ru" ? "ru-RU" : "en-US";

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <header className="mb-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              {t("kicker")}
            </p>
            <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
              {t("heading")}
            </h1>
            <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
              {t("lead")}
            </p>
          </header>

          <nav
            className="mb-6 flex gap-1 border-b border-foreground/10"
            aria-label={t("navLabel")}
          >
            {TAB_KEYS.map((key) => (
              <Link
                key={key}
                href={key === "upcoming" ? "/events" : `/events?filter=${key}`}
                aria-current={filter === key ? "page" : undefined}
                className={cn(
                  "px-3 py-2 font-sans text-sm uppercase tracking-widest transition-colors",
                  filter === key
                    ? "border-b-2 border-foreground text-foreground"
                    : "border-b-2 border-transparent text-foreground-muted hover:text-foreground",
                )}
              >
                {t(`tabs.${key}`)}
              </Link>
            ))}
          </nav>

          {events.length === 0 ? (
            <div className="rounded-md border border-dashed border-foreground/10 bg-background-elevated/30 px-6 py-16 text-center">
              <p className="font-display text-lg uppercase tracking-tight text-foreground">
                {t(emptyCopy.titleKey)}
              </p>
              <p className="mx-auto mt-2 max-w-sm font-sans text-sm text-foreground-muted">
                {t(emptyCopy.hintKey)}
              </p>
              {emptyCopy.cta ? (
                <Link
                  href={emptyCopy.cta.href}
                  className="mt-4 inline-block font-sans text-xs uppercase tracking-widest text-primary transition-colors hover:text-primary/80"
                >
                  {t(emptyCopy.cta.labelKey)}
                </Link>
              ) : null}
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {events.map((e) => {
                const dateLabel = new Date(e.date).toLocaleDateString(dateFmt, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                });
                const sub = [e.venue, e.location_city]
                  .filter(Boolean)
                  .join(" · ");
                const statusKey = STATUS_KEY[e.status];
                const statusLabel = statusKey ? t(statusKey) : e.status;
                return (
                  <li key={e.id}>
                    <Link
                      href={`/events/${e.slug}`}
                      prefetch={false}
                      className="block rounded-md border border-foreground/10 bg-background-elevated/30 p-4 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.04]"
                    >
                      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-foreground-subtle">
                        {e.promotion.toUpperCase()} · {dateLabel}
                      </p>
                      <h3 className="mt-2 font-display text-lg uppercase tracking-tight text-foreground line-clamp-2">
                        {e.short_name || e.name}
                      </h3>
                      {sub ? (
                        <p
                          title={sub}
                          className="mt-1 truncate font-sans text-xs text-foreground-muted"
                        >
                          {sub}
                        </p>
                      ) : null}
                      <p className="mt-3 font-mono text-[10px] tabular text-foreground-subtle">
                        {t("boutCount", { count: e.bout_count })}
                        {e.status === "upcoming" ? "" : ` · ${statusLabel}`}
                      </p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}
