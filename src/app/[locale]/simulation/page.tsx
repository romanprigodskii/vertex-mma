import type { Metadata } from "next";
import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { RecentGradedList } from "@/components/simulation/recent-graded-list";
import { SimulationBoutCard } from "@/components/simulation/simulation-bout-card";
import { Link } from "@/i18n/navigation";
import { formatNumber } from "@/lib/format";
import {
  getGradedSimulations,
  summarizeAccuracy,
} from "@/lib/simulation-accuracy";
import {
  getUpcomingSimulationIndex,
  summarizeSimulationIndex,
  type SimulationIndexEvent,
} from "@/lib/simulation-index";

export const dynamic = "force-dynamic";

interface SearchParams {
  // Filter switches passed as URL query — kept simple as string flags
  // so a future Phase 7 can add more (?wc=lightweight etc.) without
  // restructuring this contract.
  confidence?: "all" | "high" | "med_or_high";
  value?: "all" | "yes";
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "simulationIndex" });
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
  };
}

function formatEventDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(locale === "ru" ? "ru-RU" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Apply URL-driven filters to the upcoming events tree. Mutates a
 *  shallow copy so the original cache stays intact for any other
 *  consumer. */
function applyFilters(
  events: SimulationIndexEvent[],
  params: SearchParams,
): SimulationIndexEvent[] {
  const wantHigh = params.confidence === "high";
  const wantMedOrHigh = params.confidence === "med_or_high";
  const wantValue = params.value === "yes";
  if (!wantHigh && !wantMedOrHigh && !wantValue) return events;

  return events
    .map((ev) => ({
      ...ev,
      bouts: ev.bouts.filter((b) => {
        if (wantHigh && b.confidenceLabel !== "high") return false;
        if (wantMedOrHigh && b.confidenceLabel === "low") return false;
        if (wantValue && (b.edgeA == null || Math.abs(b.edgeA) < 0.05)) return false;
        return true;
      }),
    }))
    .filter((ev) => ev.bouts.length > 0);
}

export default async function SimulationIndexPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("simulationIndex");
  const localeStr = await getLocale();
  const sp = await searchParams;
  const confidenceFilter = sp.confidence ?? "all";
  const valueFilter = sp.value ?? "all";

  // Two independent fetches; run in parallel.
  const [allEvents, gradedPicks] = await Promise.all([
    getUpcomingSimulationIndex(),
    getGradedSimulations(60),
  ]);

  const filteredEvents = applyFilters(allEvents, sp);
  const summary = summarizeSimulationIndex(allEvents);
  const accuracy = summarizeAccuracy(gradedPicks);
  const anyFilter = confidenceFilter !== "all" || valueFilter !== "all";

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          {/* Header */}
          <header className="mb-8 flex flex-col items-start gap-4 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-primary">
                {t("kicker")}
              </p>
              <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
                {t("heading")}
              </h1>
              <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
                {t("lead")}
              </p>
            </div>
            {summary.modelVersion ? (
              <div className="flex flex-col items-start gap-1 sm:items-end">
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {t("modelVersion", { version: summary.modelVersion })}
                </p>
                <p className="font-display text-2xl tabular text-foreground">
                  {formatNumber(summary.totalBouts)}
                </p>
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {t("totalBouts", { count: summary.totalBouts })}
                </p>
              </div>
            ) : null}
          </header>

          {/* Quick stats strip. The three upcoming-derived tiles only render
              when there are upcoming bouts — otherwise they would show a row
              of zeros beside a real accuracy %, which reads as broken. The
              accuracy tile stands on its own whenever there's graded history. */}
          {summary.totalBouts > 0 || accuracy.total > 0 ? (
            <ul
              className={`mb-6 grid gap-2 ${
                summary.totalBouts > 0
                  ? "grid-cols-2 sm:grid-cols-4"
                  : "grid-cols-1 sm:max-w-xs"
              }`}
            >
              {summary.totalBouts > 0 ? (
                <>
                  <li className="rounded-md border border-foreground/10 bg-background-elevated/30 px-3 py-3 sm:px-4">
                    <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                      {t("statEvents")}
                    </p>
                    <p className="mt-1 font-display text-2xl tabular text-foreground">
                      {formatNumber(summary.totalEvents)}
                    </p>
                  </li>
                  <li className="rounded-md border border-foreground/10 bg-background-elevated/30 px-3 py-3 sm:px-4">
                    <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                      {t("statHighConfidence")}
                    </p>
                    <p className="mt-1 font-display text-2xl tabular text-streak-win">
                      {formatNumber(summary.highConfidence)}
                    </p>
                  </li>
                  <li className="rounded-md border border-foreground/10 bg-background-elevated/30 px-3 py-3 sm:px-4">
                    <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                      {t("statWithEdge")}
                    </p>
                    <p className="mt-1 font-display text-2xl tabular text-primary">
                      {formatNumber(summary.withMarketEdge)}
                    </p>
                  </li>
                </>
              ) : null}
              <li className="rounded-md border border-foreground/10 bg-background-elevated/30 px-3 py-3 sm:px-4">
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {t("statRecentAccuracy")}
                </p>
                {/* Gate the headline % on a reliable sample (MIN_RELIABLE_GRADED)
                    so a handful of graded picks can't render a misleading 100%;
                    below that we show the running count instead of a rate. */}
                {accuracy.reliable ? (
                  <>
                    <p className="mt-1 font-display text-2xl tabular text-foreground">
                      {Math.round(accuracy.hitRate * 100)}
                      <span className="text-base text-foreground-muted">%</span>
                    </p>
                    <p className="font-mono text-[10px] tabular text-foreground-subtle">
                      {t("statRecentAccuracySub", { n: accuracy.total })}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mt-1 font-display text-2xl tabular text-foreground-subtle">
                      —
                    </p>
                    {accuracy.total > 0 ? (
                      <p className="font-mono text-[10px] tabular text-foreground-subtle">
                        {t("statRecentAccuracySub", { n: accuracy.total })}
                      </p>
                    ) : null}
                  </>
                )}
              </li>
            </ul>
          ) : null}

          {/* Honest framing: the model is ~market-level, not a sharp edge. */}
          {summary.totalBouts > 0 || accuracy.total > 0 ? (
            <p className="mb-6 max-w-2xl font-sans text-[11px] leading-relaxed text-foreground-subtle">
              {t("accuracyCaveat")}
            </p>
          ) : null}

          {/* Filter row */}
          {allEvents.length > 0 ? (
            <div className="mb-6 flex flex-wrap items-baseline gap-x-3 gap-y-2 text-[11px] uppercase tracking-widest">
              <span className="font-mono text-foreground-subtle">
                {t("filterLabel")}
              </span>
              <FilterChip
                href="/simulation"
                active={confidenceFilter === "all" && valueFilter === "all"}
                label={t("filterAll")}
              />
              <FilterChip
                href="/simulation?confidence=high"
                active={confidenceFilter === "high"}
                label={t("filterHighConfidence")}
              />
              <FilterChip
                href="/simulation?confidence=med_or_high"
                active={confidenceFilter === "med_or_high"}
                label={t("filterMedOrHigh")}
              />
              <FilterChip
                href="/simulation?value=yes"
                active={valueFilter === "yes"}
                label={t("filterValue")}
              />
              {anyFilter ? (
                <span className="font-mono text-foreground-subtle">
                  ·{" "}
                  {t("filterCount", {
                    shown: filteredEvents.reduce((n, e) => n + e.bouts.length, 0),
                    total: summary.totalBouts,
                  })}
                </span>
              ) : null}
            </div>
          ) : null}

          {/* Recently graded picks (only when there's history) */}
          {gradedPicks.length > 0 ? (
            <RecentGradedList picks={gradedPicks} limit={10} />
          ) : null}

          {/* Empty state */}
          {filteredEvents.length === 0 ? (
            <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-4 py-12 text-center sm:px-6 sm:py-16">
              <p className="font-display text-xl uppercase tracking-tight text-foreground break-words sm:text-2xl">
                {anyFilter ? t("emptyFilteredTitle") : t("emptyTitle")}
              </p>
              <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
                {anyFilter ? t("emptyFilteredLead") : t("emptyLead")}
              </p>
              {anyFilter ? (
                <Link
                  href="/simulation"
                  className="mt-6 inline-block rounded-sm border border-foreground/15 px-4 py-2 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
                >
                  {t("clearFilters")} →
                </Link>
              ) : (
                <Link
                  href="/events"
                  className="mt-6 inline-block rounded-sm border border-foreground/15 px-4 py-2 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
                >
                  {t("emptyCta")} →
                </Link>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-8">
              {filteredEvents.map((ev) => (
                <section
                  key={ev.eventId}
                  aria-label={ev.eventName}
                  className="flex flex-col gap-3"
                >
                  <header className="flex flex-col gap-1 border-b border-foreground/10 pb-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                    <Link
                      href={`/events/${ev.eventSlug}`}
                      prefetch={false}
                      className="font-display text-xl uppercase tracking-tight text-foreground transition-colors hover:text-primary sm:text-2xl"
                    >
                      {ev.eventName}
                    </Link>
                    <span className="font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
                      {formatEventDate(ev.eventDate, localeStr)}
                      <span aria-hidden className="mx-2">
                        ·
                      </span>
                      {t("boutCount", { count: ev.bouts.length })}
                    </span>
                  </header>

                  <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    {ev.bouts.map((b) => (
                      <li key={b.boutId}>
                        <SimulationBoutCard bout={b} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}

          {/* Disclaimer */}
          <p className="mt-10 max-w-2xl font-sans text-[11px] leading-relaxed text-foreground-subtle">
            {t("disclaimer")}
          </p>
        </Container>
      </main>
      <Footer />
    </>
  );
}

function FilterChip({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className={
        active
          ? "rounded-sm bg-primary/15 px-2 py-1 font-mono text-primary"
          : "rounded-sm border border-foreground/10 px-2 py-1 font-mono text-foreground-muted transition-colors hover:border-primary/40 hover:text-foreground"
      }
    >
      {label}
    </Link>
  );
}
