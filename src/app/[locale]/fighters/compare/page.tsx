import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { CommonOpponents } from "@/components/compare/CommonOpponents";
import { CompareForecast } from "@/components/compare/CompareForecast";
import { CompareHero } from "@/components/compare/CompareHero";
import { CompareSection } from "@/components/compare/CompareSection";
import {
  AttributesTable,
  FinishingCompare,
  GrapplingCompare,
  StrikingCompare,
} from "@/components/compare/CompareStatGroups";
import { FighterPicker } from "@/components/compare/FighterPicker";
import { HeadToHead } from "@/components/compare/HeadToHead";
import { OverlapRadar } from "@/components/compare/OverlapRadar";
import { RecentForm } from "@/components/compare/RecentForm";
import { ScoreCompare } from "@/components/compare/ScoreCompare";
import { TaleOfTheTape } from "@/components/compare/TaleOfTheTape";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Link } from "@/i18n/navigation";
import { CHAMPION_BY_SLUG } from "@/lib/champions";
import {
  getCommonOpponents,
  getHeadToHeadBouts,
  getRecentForm,
} from "@/lib/compare-fighters";
import { estimateWinProbability } from "@/lib/compare-prediction";
import { computeAttributes } from "@/lib/fighter-attributes";
import {
  buildScoreBreakdown,
  getDivisionalScores,
  getFighterBySlug,
  getGlobalScoreComponents,
  type FighterDivisionalScoreRow,
} from "@/lib/fighter-detail";
import { headlineScore } from "@/lib/vertex-tier";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "compare" });
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    openGraph: {
      title: t("ogTitle"),
      description: t("metaDescription"),
      type: "website",
    },
  };
}

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readSlug(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string | null {
  const v = params[key];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export default async function ComparePage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("compare");
  const sp = await searchParams;
  const slugA = readSlug(sp, "a");
  const slugB = readSlug(sp, "b");

  const [fighterA, fighterB] = await Promise.all([
    slugA ? getFighterBySlug(slugA) : Promise.resolve(null),
    slugB ? getFighterBySlug(slugB) : Promise.resolve(null),
  ]);

  // Empty-state shell — at least one slot empty/invalid.
  if (!fighterA || !fighterB) {
    return (
      <>
        <Navbar />
        <main className="flex-1">
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

          <section className="border-b border-foreground/10">
            <Container size="xl" className="py-10 md:py-14">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
                {t("kicker")}
              </p>
              <h1 className="mt-3 font-display uppercase tracking-tight text-foreground text-h1">
                {t("heading")}
              </h1>
              <p className="mt-4 max-w-xl font-sans text-sm text-foreground-muted">
                {t("lead")}
              </p>
            </Container>
          </section>

          <section className="py-10 md:py-16">
            <Container size="xl">
              <FighterPicker
                initialA={{
                  slug: fighterA?.slug ?? slugA ?? null,
                  name: fighterA?.name_en ?? null,
                }}
                initialB={{
                  slug: fighterB?.slug ?? slugB ?? null,
                  name: fighterB?.name_en ?? null,
                }}
              />
              {(slugA && !fighterA) || (slugB && !fighterB) ? (
                <p className="mt-6 text-center font-sans text-xs text-foreground-subtle">
                  {slugA && !fighterA
                    ? t("notInRoster", { slug: slugA }) + " "
                    : ""}
                  {slugB && !fighterB ? t("notInRoster", { slug: slugB }) : ""}
                </p>
              ) : null}
            </Container>
          </section>
        </main>
        <Footer />
      </>
    );
  }

  const championA = CHAMPION_BY_SLUG.get(fighterA.slug) ?? null;
  const championB = CHAMPION_BY_SLUG.get(fighterB.slug) ?? null;
  const attributesA = computeAttributes(fighterA);
  const attributesB = computeAttributes(fighterB);

  const [
    common,
    headToHead,
    recentA,
    recentB,
    globalA,
    globalB,
    divScoresA,
    divScoresB,
  ] = await Promise.all([
    getCommonOpponents(fighterA.id, fighterB.id),
    getHeadToHeadBouts(fighterA.id, fighterB.id),
    getRecentForm(fighterA.id, 5),
    getRecentForm(fighterB.id, 5),
    getGlobalScoreComponents(fighterA.id),
    getGlobalScoreComponents(fighterB.id),
    getDivisionalScores(fighterA.id),
    getDivisionalScores(fighterB.id),
  ]);

  // Mirror the profile hero: the active-division divisional row (if any)
  // drives the headline + breakdown so compare shows the SAME number the
  // profile does. headlineScore then applies the active/retired rule.
  const findActiveDiv = (
    currentDivision: string | null,
    rows: FighterDivisionalScoreRow[],
  ): FighterDivisionalScoreRow | null =>
    currentDivision
      ? rows.find(
          (d) => d.division === currentDivision && d.in_active_ranking,
        ) ?? null
      : null;
  const activeDivA = findActiveDiv(fighterA.current_division, divScoresA);
  const activeDivB = findActiveDiv(fighterB.current_division, divScoresB);
  const headlineA = headlineScore({
    rosterStatus: fighterA.roster_status,
    divisionalScore: activeDivA?.vertex_score ?? null,
    vertexScore: fighterA.vertex_score,
    vertexScoreAllTime: fighterA.vertex_score_all_time,
  });
  const headlineB = headlineScore({
    rosterStatus: fighterB.roster_status,
    divisionalScore: activeDivB?.vertex_score ?? null,
    vertexScore: fighterB.vertex_score,
    vertexScoreAllTime: fighterB.vertex_score_all_time,
  });

  // Free, lightweight win-probability teaser. It MUST read the same resolved
  // headline numbers the hero / ScoreCompare display — headlineScore returns
  // the active-division current score for active fighters and all-time for
  // retired, so feeding the raw global columns let the teaser favour the
  // fighter the panel right below shows as weaker. Pass the headline values
  // directly so the forecast and the displayed scores can never diverge. The
  // full AI simulation (method / rounds / Monte-Carlo / "why") stays paid.
  const rawForecast = estimateWinProbability(
    { allTime: headlineA.value, current: headlineA.value },
    { allTime: headlineB.value, current: headlineB.value },
  );
  const forecast = rawForecast
    ? {
        ...rawForecast,
        // estimateWinProbability defaults basis to "all_time" when both slots
        // are set; relabel it from the headline modes so the footnote matches
        // (both retired → all-time, otherwise current).
        basis:
          headlineA.scoreMode === "all_time" &&
          headlineB.scoreMode === "all_time"
            ? ("all_time" as const)
            : ("current" as const),
      }
    : null;

  const breakdownA = buildScoreBreakdown(
    headlineA.basis === "divisional" ? activeDivA : null,
    globalA,
  );
  const breakdownB = buildScoreBreakdown(
    headlineB.basis === "divisional" ? activeDivB : null,
    globalB,
  );

  return (
    <>
      <Navbar />
      <main className="flex-1">
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

        <section className="pt-6 md:pt-8">
          <Container size="xl" className="mb-8 md:mb-12">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              {t("kicker")}
            </p>
            <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
              {t("heading")}
            </h1>
          </Container>

          <CompareHero
            a={fighterA}
            b={fighterB}
            championA={championA}
            championB={championB}
          />
        </section>

        {forecast ? (
          <CompareSection
            label={t("forecast")}
            explainer={t("forecastExplainer")}
          >
            <CompareForecast
              fighterAName={fighterA.name_en}
              fighterBName={fighterB.name_en}
              probA={forecast.probA}
              probB={forecast.probB}
              scoreA={forecast.scoreA}
              scoreB={forecast.scoreB}
              basis={forecast.basis}
            />
          </CompareSection>
        ) : null}

        <CompareSection
          label={t("taleOfTheTape")}
          explainer={t("taleOfTheTapeExplainer")}
        >
          <TaleOfTheTape a={fighterA} b={fighterB} />
        </CompareSection>

        <CompareSection
          label={t("attributes")}
          explainer={t("attributesExplainer")}
        >
          <div className="flex flex-col items-center gap-8">
            <OverlapRadar
              fighterA={{ name: fighterA.name_en, attributes: attributesA }}
              fighterB={{ name: fighterB.name_en, attributes: attributesB }}
            />
            <AttributesTable
              attributesA={attributesA}
              attributesB={attributesB}
            />
          </div>
        </CompareSection>

        <CompareSection
          label={t("scoreBreakdown")}
          explainer={t("scoreBreakdownExplainer")}
        >
          <ScoreCompare
            fighterAName={fighterA.name_en}
            fighterBName={fighterB.name_en}
            breakdownA={breakdownA}
            breakdownB={breakdownB}
            scoreA={headlineA.value}
            scoreModeA={headlineA.scoreMode}
            scoreB={headlineB.value}
            scoreModeB={headlineB.scoreMode}
          />
        </CompareSection>

        <CompareSection
          label={t("recentForm")}
          explainer={t("recentFormExplainer")}
        >
          <RecentForm
            fighterAName={fighterA.name_en}
            fighterBName={fighterB.name_en}
            recentA={recentA}
            recentB={recentB}
          />
        </CompareSection>

        <CompareSection
          label={t("striking")}
          explainer={t("strikingExplainer")}
        >
          <StrikingCompare a={fighterA} b={fighterB} />
        </CompareSection>

        <CompareSection
          label={t("grappling")}
          explainer={t("grapplingExplainer")}
        >
          <GrapplingCompare a={fighterA} b={fighterB} />
        </CompareSection>

        <CompareSection
          label={t("finishing")}
          explainer={t("finishingExplainer")}
        >
          <FinishingCompare a={fighterA} b={fighterB} />
        </CompareSection>

        <CompareSection
          label={t("commonOpponents")}
          explainer={t("commonOpponentsExplainer")}
          meta={
            common.length > 0
              ? t("sharedCount", { n: common.length })
              : null
          }
        >
          <CommonOpponents
            entries={common}
            fighterAName={fighterA.name_en}
            fighterBName={fighterB.name_en}
          />
        </CompareSection>

        <CompareSection
          label={t("headToHead")}
          explainer={t("headToHeadExplainer")}
          className="pb-16 sm:pb-20"
        >
          <HeadToHead
            bouts={headToHead}
            fighterAName={fighterA.name_en}
            fighterBName={fighterB.name_en}
          />
        </CompareSection>
      </main>
      <Footer />
    </>
  );
}
