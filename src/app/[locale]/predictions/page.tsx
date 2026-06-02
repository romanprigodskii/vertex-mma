import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { PredictionEventCard } from "@/components/predictions/prediction-event-card";
import { PredictionStandings } from "@/components/predictions/prediction-standings";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getTopPredictors, listOpenPredictionEvents } from "@/lib/predictions";

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
  const [events, user, topPredictors] = await Promise.all([
    listOpenPredictionEvents(20),
    getCurrentUser(),
    getTopPredictors(10),
  ]);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <header className="mb-8 flex flex-col items-start gap-4 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-3">
            <div className="min-w-0 flex-1">
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

          {topPredictors.length > 0 ? (
            <section className="mt-14">
              <h2 className="font-display text-xl uppercase tracking-tight text-foreground">
                {t("topPredictorsHeading")}
              </h2>
              <p className="mt-1 font-sans text-sm text-foreground-muted">
                {t("topPredictorsLead")}
              </p>
              <div className="mt-4 max-w-2xl">
                <PredictionStandings
                  rows={topPredictors.map((p) => ({
                    rank: p.rank,
                    user_id: p.user_id,
                    username: p.username,
                    display_name: p.display_name,
                    avatar_url: p.avatar_url,
                    total_score: p.total_score,
                    correct: p.total_correct,
                    events: p.events_played,
                  }))}
                  currentUserId={user?.userProfileId ?? null}
                  showEvents
                />
              </div>
            </section>
          ) : null}
        </Container>
      </main>
      <Footer />
    </>
  );
}
