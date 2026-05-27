import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { PredictionEventCard } from "@/components/predictions/prediction-event-card";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listOpenPredictionEvents } from "@/lib/predictions";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "predictions" });
  return { title: t("metaTitle"), description: t("metaDescription") };
}

export default async function PredictionsListPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("predictions");
  const [events, user] = await Promise.all([
    listOpenPredictionEvents(20),
    getCurrentUser(),
  ]);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <header className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
                {t("kicker")}
              </p>
              <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
                {t("heading")}
              </h1>
              <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
                {t("lead")}
              </p>
            </div>
            {user ? (
              <Link
                href="/me/predictions"
                className="rounded-sm border border-foreground/15 px-4 py-2 font-display text-sm uppercase tracking-widest text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
              >
                {t("myPredictions")}
              </Link>
            ) : (
              <Link
                href="/signin?next=/predictions"
                className="rounded-sm border border-foreground/15 px-4 py-2 font-display text-sm uppercase tracking-widest text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
              >
                {t("signInToPredict")}
              </Link>
            )}
          </header>

          {events.length === 0 ? (
            <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
              <p className="font-display text-2xl uppercase tracking-tight text-foreground">
                {t("emptyTitle")}
              </p>
              <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
                {t("emptyLead")}
              </p>
              <Link
                href="/events"
                className="mt-6 inline-block rounded-sm border border-foreground/15 px-4 py-2 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
              >
                {t("browseUpcoming")} →
              </Link>
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {events.map((e) => (
                <li key={e.id}>
                  <PredictionEventCard event={e} />
                </li>
              ))}
            </ul>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}
