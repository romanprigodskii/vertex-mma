import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { PredictionForm } from "@/components/predictions/prediction-form";
import { PredictionStandings } from "@/components/predictions/prediction-standings";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import {
  getPredictionEventForUser,
  getPredictionEventStandings,
} from "@/lib/predictions";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id, locale } = await params;
  const t = await getTranslations({ locale, namespace: "predictions" });
  const user = await getCurrentUser();
  const evt = await getPredictionEventForUser(id, user?.userProfileId ?? null);
  if (!evt) return { title: t("notFoundTitle") };
  return {
    title: t("detailMetaTitle", { event: evt.event_name }),
    description: t("detailMetaDescription", { event: evt.event_name }),
  };
}

export default async function PredictionDetailPage({ params }: PageProps) {
  const { id, locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("predictions");
  const localePrefix = locale === "en" ? "" : `/${locale}`;
  const user = await getCurrentUser();
  if (!user) redirect(`${localePrefix}/signin?next=/predictions/${id}`);

  const evt = await getPredictionEventForUser(id, user.userProfileId);
  if (!evt) notFound();

  const standings = await getPredictionEventStandings(evt.id);

  const closed =
    evt.status !== "upcoming" ||
    new Date(evt.closes_at).getTime() <= Date.now();
  const dateLocale = locale === "ru" ? "ru-RU" : "en-US";
  const closesLabel = new Date(evt.closes_at).toLocaleString(dateLocale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href="/predictions"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> {t("allPredictions")}
            </Link>
          </Container>
        </div>

        <Container size="lg" className="py-10 md:py-14">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
            {new Date(evt.event_date).toLocaleDateString(dateLocale, {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
          <h1 className="mt-3 font-display uppercase tracking-tight text-foreground text-h1">
            {evt.event_name}
          </h1>
          <p className="mt-2 font-sans text-sm text-foreground-muted">
            {closed ? t("closed") : t("closesAt", { when: closesLabel })} ·{" "}
            {t("participants", { count: evt.total_participants })}
          </p>

          <div className="mt-8">
            <PredictionForm
              predictionEventId={evt.id}
              bouts={evt.bouts}
              readOnly={closed}
            />
          </div>

          {closed ? (
            <div className="mt-12">
              <h2 className="font-display text-xl uppercase tracking-tight text-foreground">
                {t("standingsHeading")}
              </h2>
              {standings.length === 0 ? (
                <p className="mt-3 rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-4 py-8 text-center font-sans text-sm text-foreground-muted">
                  {t("standingsEmpty")}
                </p>
              ) : (
                <div className="mt-4">
                  <PredictionStandings
                    rows={standings.map((s) => ({
                      rank: s.rank,
                      user_id: s.user_id,
                      username: s.username,
                      display_name: s.display_name,
                      avatar_url: s.avatar_url,
                      total_score: s.total_score,
                      correct: s.correct_winners,
                    }))}
                    currentUserId={user.userProfileId}
                  />
                </div>
              )}
            </div>
          ) : null}
        </Container>
      </main>
      <Footer />
    </>
  );
}
