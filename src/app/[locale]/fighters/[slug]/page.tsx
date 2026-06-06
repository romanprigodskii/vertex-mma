import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ArrowLeftRight, ChevronLeft, ChevronRight, Sparkles } from "lucide-react";

import { Link } from "@/i18n/navigation";

import { CircleScore, OctagonScore } from "@/components/fighter/ScoreShapes";
import { CareerOverview } from "@/components/fighter/detail/CareerOverview";
import { CareerTimeline } from "@/components/fighter/detail/CareerTimeline";
import { FightHistoryList } from "@/components/fighter/detail/FightHistoryList";
import { FighterHero } from "@/components/fighter/detail/FighterHero";
import { OtherDivisions } from "@/components/fighter/detail/OtherDivisions";
import { PeakVertex } from "@/components/fighter/detail/PeakVertex";
import { PhysicalInfo } from "@/components/fighter/detail/PhysicalInfo";
import { RadarChart } from "@/components/fighter/detail/RadarChart";
import { RoundByRoundChart } from "@/components/fighter/detail/RoundByRoundChart";
import { ScoreBreakdown } from "@/components/fighter/detail/ScoreBreakdown";
import { SectionHeader } from "@/components/fighter/detail/SectionHeader";
import { SimilarFighters } from "@/components/fighter/detail/SimilarFighters";
import { StrikingHeatmap } from "@/components/fighter/detail/StrikingHeatmap";
import { UpcomingBouts } from "@/components/fighter/detail/UpcomingBouts";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { NewsRow } from "@/components/news/news-row";
import { CHAMPION_BY_SLUG } from "@/lib/champions";
import { computeAttributes } from "@/lib/fighter-attributes";
import {
  buildScoreBreakdown,
  buildTimelineBouts,
  getDivisionalScores,
  getFightHistory,
  getFighterBoutRounds,
  getFighterBySlug,
  getGlobalScoreComponents,
  getUpcomingBouts,
} from "@/lib/fighter-detail";
import { listNewsForFighter } from "@/lib/news";
import { getPeakVertex } from "@/lib/score-history";
import { getSimilarFighters } from "@/lib/similar-fighters";
import { headlineScore } from "@/lib/vertex-tier";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string; locale: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug, locale } = await params;
  const tFighter = await getTranslations({ locale, namespace: "fighter" });
  const tWeight = await getTranslations({ locale, namespace: "weight" });
  const fighter = await getFighterBySlug(slug);
  if (!fighter) {
    return {
      title: tFighter("notFoundTitle"),
      description: tFighter("notFoundDesc"),
    };
  }
  const recordSuffix = `${fighter.wins_total}-${fighter.losses_total}${
    fighter.draws_total > 0 ? `-${fighter.draws_total}` : ""
  }`;
  const division =
    fighter.weight_class_primary && tWeight.has(fighter.weight_class_primary)
      ? tWeight(fighter.weight_class_primary)
      : tFighter("metaTitleFallback");
  return {
    title: `${fighter.name_en} · ${division}`,
    description: tFighter("metaDescription", {
      name: fighter.name_en,
      record: recordSuffix,
    }),
    openGraph: {
      title: tFighter("ogTitle", { name: fighter.name_en }),
      description: tFighter("ogDescription", { name: fighter.name_en }),
      images: fighter.photo_url ? [fighter.photo_url] : [],
      type: "profile",
    },
  };
}

function Section({
  label,
  explainer,
  children,
  className,
}: {
  label: string;
  explainer?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <Container size="xl">
        <SectionHeader label={label} explainer={explainer} />
        {children}
      </Container>
    </section>
  );
}

export default async function FighterDetailPage({ params }: PageProps) {
  const { slug, locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("fighter");
  const radarLabels = {
    striking: t("attribute.striking"),
    grappling: t("attribute.grappling"),
    defense: t("attribute.defense"),
    cardio: t("attribute.cardio"),
    power: t("attribute.power"),
    activity: t("attribute.activity"),
  };
  const fighter = await getFighterBySlug(slug);
  if (!fighter) notFound();

  const [
    boutRounds,
    history,
    upcomingBouts,
    similar,
    divisionalScores,
    globalComponents,
    peakVertex,
    fighterNews,
  ] = await Promise.all([
    getFighterBoutRounds(fighter.id),
    getFightHistory(fighter.id),
    getUpcomingBouts(fighter.id),
    getSimilarFighters(fighter),
    getDivisionalScores(fighter.id),
    getGlobalScoreComponents(fighter.id),
    getPeakVertex(fighter.id),
    listNewsForFighter(fighter.id, 6),
  ]);

  const championEntry = CHAMPION_BY_SLUG.get(slug) ?? null;
  const attributes = computeAttributes(fighter);
  // A 0–2 bout fighter still yields a confident-looking radar from
  // computeAttributes; flag it so the chart renders a low-confidence treatment
  // and the caption says so, rather than implying more certainty than exists.
  const radarLowConfidence = fighter.ufc_total < 3;
  const timelineBouts = buildTimelineBouts(history, boutRounds);

  // Wave 14B.2: hero score uses the per-division score when the fighter
  // has an in_active_ranking row for their current_division. Falls back
  // to the global vertex_score when no such row exists (e.g., <3 bouts
  // in the new division after a move) so freshly promoted champions and
  // un-divisional rows still see their global rating up top.
  const activeDivisionalRow = fighter.current_division
    ? divisionalScores.find(
        (d) =>
          d.division === fighter.current_division && d.in_active_ranking,
      ) ?? null
    : null;
  // Canonical headline (see headlineScore): active fighters headline their
  // current score (divisional for the active division, else global); retired/
  // released/inactive headline all-time, so a stale `vertex_score` never
  // surfaces a Current octagon for a retired fighter. basis === "all_time"
  // (retired, or an active fighter with no current score) → no octagon, the
  // all-time circle stands alone (the Wave 29 layout below).
  const heroHeadline = headlineScore({
    rosterStatus: fighter.roster_status,
    divisionalScore: activeDivisionalRow?.vertex_score ?? null,
    vertexScore: fighter.vertex_score,
    vertexScoreAllTime: fighter.vertex_score_all_time,
  });
  const heroCurrentScore =
    heroHeadline.basis === "all_time" ? null : heroHeadline.value;
  // Sidebar list — every divisional row OTHER than the one driving the
  // hero. When activeDivisionalRow is null (fallback case) we include
  // all divisional rows.
  const otherDivisionRows = activeDivisionalRow
    ? divisionalScores.filter(
        (d) => d.division !== activeDivisionalRow.division,
      )
    : divisionalScores;

  // Wave 17: breakdown follows the hero — divisional row when one drives
  // the hero, global otherwise. Returns null when both inputs are null
  // (≤2 UFC bouts → fighter has no row in either source).
  const breakdown = buildScoreBreakdown(activeDivisionalRow, globalComponents);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        {/* Back link */}
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href="/fighters"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted transition-colors hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              {t("backToRoster")}
            </Link>
          </Container>
        </div>

        <FighterHero fighter={fighter} championEntry={championEntry} />

        <Container size="xl" className="pt-8">
          {heroCurrentScore != null ? (
            <div className="flex items-center justify-center gap-3 sm:gap-6">
              <Link
                href={`/fighters/${slug}/score-history?mode=current`}
                prefetch={false}
                aria-label={t("openCurrentHistoryScore", {
                  score: heroCurrentScore,
                })}
                className="group block rounded-full outline-none ring-offset-2 ring-offset-background-base transition-transform hover:scale-[1.02] focus-visible:ring-2 focus-visible:ring-primary"
              >
                {/* Decorative — the link's aria-label already names the control
                    and its score, so the inner shape is hidden to avoid a
                    redundant second screen-reader announcement. */}
                <span aria-hidden className="contents">
                  <OctagonScore
                    score={heroCurrentScore}
                    scoreMode="current"
                    fighter={{
                      slug: fighter.slug,
                      // Wave 14B.2: classify the hero tier using the
                      // divisional score (when available) so the colour
                      // ring and number always agree. all_time stays global.
                      vertexScore: heroCurrentScore,
                      vertexScoreAllTime: fighter.vertex_score_all_time,
                      ufcBouts: fighter.ufc_total,
                    }}
                    label={t("currentVertex")}
                  />
                </span>
              </Link>
              <Link
                href={`/fighters/${slug}/score-history?mode=all_time`}
                prefetch={false}
                aria-label={
                  fighter.vertex_score_all_time != null
                    ? t("openAllTimeHistoryScore", {
                        score: fighter.vertex_score_all_time,
                      })
                    : t("openAllTimeHistory")
                }
                className="group block rounded-full outline-none ring-offset-2 ring-offset-background-base transition-transform hover:scale-[1.02] focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span aria-hidden className="contents">
                  <CircleScore
                    score={fighter.vertex_score_all_time}
                    scoreMode="all_time"
                    fighter={{
                      slug: fighter.slug,
                      vertexScore: fighter.vertex_score,
                      vertexScoreAllTime: fighter.vertex_score_all_time,
                      ufcBouts: fighter.ufc_total,
                    }}
                    label={t("allTimeVertex")}
                  />
                </span>
              </Link>
            </div>
          ) : (
            // Wave 29: retired (or <5-bout) fighter — All-Time is the
            // primary identity; skip the empty Current octagon entirely.
            <div className="flex items-center justify-center">
              <Link
                href={`/fighters/${slug}/score-history?mode=all_time`}
                prefetch={false}
                aria-label={
                  fighter.vertex_score_all_time != null
                    ? t("openAllTimeHistoryScore", {
                        score: fighter.vertex_score_all_time,
                      })
                    : t("openAllTimeHistory")
                }
                className="group block rounded-full outline-none ring-offset-2 ring-offset-background-base transition-transform hover:scale-[1.02] focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span aria-hidden className="contents">
                  <CircleScore
                    score={fighter.vertex_score_all_time}
                    scoreMode="all_time"
                    fighter={{
                      slug: fighter.slug,
                      vertexScore: fighter.vertex_score,
                      vertexScoreAllTime: fighter.vertex_score_all_time,
                      ufcBouts: fighter.ufc_total,
                    }}
                    label={t("allTimeVertexShort")}
                  />
                </span>
              </Link>
            </div>
          )}
          {otherDivisionRows.length > 0 ? (
            <div className="mt-6">
              <OtherDivisions
                rows={otherDivisionRows}
                currentDivision={fighter.current_division}
              />
            </div>
          ) : null}
          {peakVertex ? (
            <div className="mt-6">
              <PeakVertex info={peakVertex} />
            </div>
          ) : null}
        </Container>

        {/* Quick-action CTAs */}
        <Container size="xl" className="pt-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <Link
              href={`/fighters/compare?a=${slug}`}
              prefetch={false}
              className="group flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-foreground/15 bg-foreground/[0.02] px-4 py-3 transition-colors hover:border-foreground/35 hover:bg-foreground/[0.05]"
            >
              <span className="flex min-w-0 items-center gap-2 font-sans text-[11px] uppercase tracking-[0.22em] text-foreground-muted">
                <ArrowLeftRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {t("compareWith")}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 font-sans text-xs text-foreground transition-transform group-hover:translate-x-0.5">
                <span>{t("openCompare")}</span>
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </span>
            </Link>
            <Link
              href={`/fighters/${slug}/card`}
              prefetch={false}
              className="group flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-foreground/15 bg-foreground/[0.02] px-4 py-3 transition-colors hover:border-foreground/35 hover:bg-foreground/[0.05]"
            >
              <span className="flex min-w-0 items-center gap-2 font-sans text-[11px] uppercase tracking-[0.22em] text-foreground-muted">
                <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {t("collectibleCardCta")}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 font-sans text-xs text-foreground transition-transform group-hover:translate-x-0.5">
                <span>{t("openCard")}</span>
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </span>
            </Link>
          </div>
        </Container>

        {upcomingBouts.length > 0 ? (
          <Section
            label={t("upcomingBouts")}
            explainer={t("upcomingBoutsExplainer")}
            className="mt-16 sm:mt-20"
          >
            <div className="mx-auto max-w-3xl">
              <UpcomingBouts bouts={upcomingBouts} />
            </div>
          </Section>
        ) : null}

        <Section
          label={t("careerTimeline")}
          explainer={t("careerTimelineExplainer")}
          className="mt-16 sm:mt-20"
        >
          <CareerTimeline bouts={timelineBouts} />
        </Section>

        <Section
          label={t("keyStats")}
          explainer={t("keyStatsExplainer")}
          className="mt-16 sm:mt-20"
        >
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-16">
            <div className="flex flex-col items-center lg:items-start">
              <RadarChart
                attributes={attributes}
                labels={radarLabels}
                ariaLabel={t("radarAria")}
                lowConfidence={radarLowConfidence}
              />
              <p className="mt-4 max-w-sm text-center font-sans text-[11px] text-foreground-subtle lg:text-left">
                {radarLowConfidence
                  ? t("radarLowConfidence")
                  : t("keyStatsCaveat")}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <div>
                <h3 className="mb-3 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
                  {t("physical")}
                </h3>
                <PhysicalInfo fighter={fighter} />
              </div>
              <div>
                <h3 className="mb-3 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
                  {t("careerOverview")}
                </h3>
                <CareerOverview fighter={fighter} />
              </div>
            </div>
          </div>
          {breakdown ? (
            <ScoreBreakdown
              data={breakdown}
              divisionalStatus={activeDivisionalRow?.divisional_status ?? null}
            />
          ) : null}
        </Section>

        <Section
          label={t("strikingHeatmap")}
          explainer={t("strikingHeatmapExplainer")}
          className="mt-16 sm:mt-20"
        >
          <StrikingHeatmap boutRounds={boutRounds} />
        </Section>

        <Section
          label={t("roundAverages")}
          explainer={t("roundAveragesExplainer")}
          className="mt-16 sm:mt-20"
        >
          <RoundByRoundChart boutRounds={boutRounds} />
        </Section>

        <Section
          label={t("fightHistory")}
          explainer={t("fightHistoryExplainer")}
          className="mt-16 sm:mt-20"
        >
          <FightHistoryList history={history} />
        </Section>

        {fighterNews.length > 0 ? (
          <Section
            label={t("inTheNews")}
            explainer={t("inTheNewsExplainer")}
            className="mt-16 sm:mt-20"
          >
            <ul className="mx-auto flex max-w-3xl flex-col gap-3">
              {fighterNews.map((item) => (
                <li key={item.id}>
                  <NewsRow item={item} />
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section
          label={t("similarFighters")}
          explainer={t("similarFightersExplainer")}
          className="mt-16 pb-20 sm:mt-20"
        >
          <SimilarFighters fighters={similar} />
        </Section>
      </main>
      <Footer />
    </>
  );
}
