import Link from "next/link";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { type EventListFilter, listEvents } from "@/lib/event-detail";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "UFC events",
  description: "Upcoming and recent UFC events.",
};

interface PageProps {
  searchParams: Promise<{ filter?: string }>;
}

function parseFilter(raw: string | undefined): EventListFilter {
  if (raw === "past" || raw === "all") return raw;
  return "upcoming";
}

const TABS: Array<{ key: EventListFilter; label: string }> = [
  { key: "upcoming", label: "Upcoming" },
  { key: "past", label: "Past" },
  { key: "all", label: "All" },
];

export default async function EventsListPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const filter = parseFilter(params.filter);
  const events = await listEvents(filter, 60);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <header className="mb-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              UFC
            </p>
            <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
              Events
            </h1>
            <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
              Upcoming bouts, recent results, and every UFC card on record.
            </p>
          </header>

          <nav
            className="mb-6 flex gap-1 border-b border-foreground/10"
            role="tablist"
          >
            {TABS.map((tab) => (
              <Link
                key={tab.key}
                href={
                  tab.key === "upcoming"
                    ? "/events"
                    : `/events?filter=${tab.key}`
                }
                className={cn(
                  "px-3 py-2 font-sans text-sm uppercase tracking-widest transition-colors",
                  filter === tab.key
                    ? "border-b-2 border-foreground text-foreground"
                    : "border-b-2 border-transparent text-foreground-muted hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            ))}
          </nav>

          {events.length === 0 ? (
            <p className="py-12 text-center font-sans text-sm text-foreground-muted">
              No events.
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {events.map((e) => {
                const dateLabel = new Date(e.date).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                });
                const sub = [e.venue, e.location_city]
                  .filter(Boolean)
                  .join(" · ");
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
                        <p className="mt-1 truncate font-sans text-xs text-foreground-muted">
                          {sub}
                        </p>
                      ) : null}
                      <p className="mt-3 font-mono text-[10px] tabular text-foreground-subtle">
                        {e.bout_count} bout
                        {e.bout_count === 1 ? "" : "s"} · {e.status}
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
