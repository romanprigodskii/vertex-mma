import type { Metadata } from "next";
import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { SimulationBoutCard } from "@/components/simulation/simulation-bout-card";
import { Link } from "@/i18n/navigation";
import {
  getUpcomingSimulationIndex,
  summarizeSimulationIndex,
} from "@/lib/simulation-index";

export const dynamic = "force-dynamic";

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

export default async function SimulationIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("simulationIndex");
  const localeStr = await getLocale();

  const events = await getUpcomingSimulationIndex();
  const summary = summarizeSimulationIndex(events);

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
              <div className="flex flex-col items-start sm:items-end gap-1">
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {t("modelVersion", { version: summary.modelVersion })}
                </p>
                <p className="font-display text-2xl tabular text-foreground">
                  {summary.totalBouts.toLocaleString()}
                </p>
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {t("totalBouts", { count: summary.totalBouts })}
                </p>
              </div>
            ) : null}
          </header>

          {/* Quick stats strip */}
          {summary.totalBouts > 0 ? (
            <ul className="mb-8 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <li className="rounded-md border border-foreground/10 bg-background-elevated/30 px-3 py-3 sm:px-4">
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {t("statEvents")}
                </p>
                <p className="mt-1 font-display text-2xl tabular text-foreground">
                  {summary.totalEvents}
                </p>
              </li>
              <li className="rounded-md border border-foreground/10 bg-background-elevated/30 px-3 py-3 sm:px-4">
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {t("statHighConfidence")}
                </p>
                <p className="mt-1 font-display text-2xl tabular text-streak-win">
                  {summary.highConfidence}
                </p>
              </li>
              <li className="rounded-md border border-foreground/10 bg-background-elevated/30 px-3 py-3 sm:px-4">
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {t("statWithEdge")}
                </p>
                <p className="mt-1 font-display text-2xl tabular text-primary">
                  {summary.withMarketEdge}
                </p>
              </li>
            </ul>
          ) : null}

          {/* Empty state */}
          {events.length === 0 ? (
            <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-4 py-12 text-center sm:px-6 sm:py-16">
              <p className="font-display text-xl uppercase tracking-tight text-foreground break-words sm:text-2xl">
                {t("emptyTitle")}
              </p>
              <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
                {t("emptyLead")}
              </p>
              <Link
                href="/events"
                className="mt-6 inline-block rounded-sm border border-foreground/15 px-4 py-2 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
              >
                {t("emptyCta")} →
              </Link>
            </div>
          ) : (
            <div className="flex flex-col gap-8">
              {events.map((ev) => (
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
