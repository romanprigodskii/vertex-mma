import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftRight, ChevronLeft, ChevronRight } from "lucide-react";

import { CircleScore, OctagonScore } from "@/components/fighter/ScoreShapes";
import { CareerOverview } from "@/components/fighter/detail/CareerOverview";
import { CareerTimeline } from "@/components/fighter/detail/CareerTimeline";
import { FightHistoryList } from "@/components/fighter/detail/FightHistoryList";
import { FighterHero } from "@/components/fighter/detail/FighterHero";
import { OtherDivisions } from "@/components/fighter/detail/OtherDivisions";
import { PhysicalInfo } from "@/components/fighter/detail/PhysicalInfo";
import { RadarChart } from "@/components/fighter/detail/RadarChart";
import { RoundByRoundChart } from "@/components/fighter/detail/RoundByRoundChart";
import { ScoreBreakdown } from "@/components/fighter/detail/ScoreBreakdown";
import { SectionHeader } from "@/components/fighter/detail/SectionHeader";
import { SimilarFighters } from "@/components/fighter/detail/SimilarFighters";
import { StrikingHeatmap } from "@/components/fighter/detail/StrikingHeatmap";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
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
} from "@/lib/fighter-detail";
import { getSimilarFighters } from "@/lib/similar-fighters";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const fighter = await getFighterBySlug(slug);
  if (!fighter) {
    return {
      title: "Fighter not found",
      description: "This fighter does not exist in the Vertex MMA database.",
    };
  }
  const recordSuffix = `${fighter.wins_total}-${fighter.losses_total}${
    fighter.draws_total > 0 ? `-${fighter.draws_total}` : ""
  }`;
  const division = fighter.weight_class_primary
    ? fighter.weight_class_primary
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : "Fighter";
  return {
    title: `${fighter.name_en} · ${division}`,
    description: `${fighter.name_en} fighter profile — ${recordSuffix} record, fight history, and career analytics.`,
    openGraph: {
      title: `${fighter.name_en} · Vertex MMA`,
      description: `Career stats, fight history, and analytics for ${fighter.name_en}.`,
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
  const { slug } = await params;
  const fighter = await getFighterBySlug(slug);
  if (!fighter) notFound();

  const [boutRounds, history, similar, divisionalScores, globalComponents] =
    await Promise.all([
      getFighterBoutRounds(fighter.id),
      getFightHistory(fighter.id),
      getSimilarFighters(fighter),
      getDivisionalScores(fighter.id),
      getGlobalScoreComponents(fighter.id),
    ]);

  const championEntry = CHAMPION_BY_SLUG.get(slug) ?? null;
  const attributes = computeAttributes(fighter);
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
  const heroCurrentScore =
    activeDivisionalRow?.vertex_score ?? fighter.vertex_score;
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
              Back to roster
            </Link>
          </Container>
        </div>

        <FighterHero fighter={fighter} championEntry={championEntry} />

        <Container size="xl" className="pt-8">
          {heroCurrentScore != null ? (
            <div className="flex items-center justify-center gap-3 sm:gap-6">
              <OctagonScore
                score={heroCurrentScore}
                scoreMode="current"
                fighter={{
                  slug: fighter.slug,
                  // Wave 14B.2: classify the hero tier using the
                  // divisional score (when available) so the colour ring
                  // and number always agree. all_time stays global.
                  vertexScore: heroCurrentScore,
                  vertexScoreAllTime: fighter.vertex_score_all_time,
                  ufcBouts: fighter.ufc_total,
                }}
                label="Current Vertex Score"
              />
              <CircleScore
                score={fighter.vertex_score_all_time}
                scoreMode="all_time"
                fighter={{
                  slug: fighter.slug,
                  vertexScore: fighter.vertex_score,
                  vertexScoreAllTime: fighter.vertex_score_all_time,
                  ufcBouts: fighter.ufc_total,
                }}
                label="All-Time Vertex Score"
              />
            </div>
          ) : (
            // Wave 29: retired (or <5-bout) fighter — All-Time is the
            // primary identity; skip the empty Current octagon entirely.
            <div className="flex items-center justify-center">
              <CircleScore
                score={fighter.vertex_score_all_time}
                scoreMode="all_time"
                fighter={{
                  slug: fighter.slug,
                  vertexScore: fighter.vertex_score,
                  vertexScoreAllTime: fighter.vertex_score_all_time,
                  ufcBouts: fighter.ufc_total,
                }}
                label="Vertex Score · All-Time"
              />
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
        </Container>

        {/* Quick-action CTAs */}
        <Container size="xl" className="pt-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Link
              href={`/fighters/${slug}/card`}
              prefetch={false}
              className="group flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/[0.04] px-4 py-3 transition-colors hover:border-primary/55 hover:bg-primary/[0.08]"
            >
              <span className="font-sans text-[11px] uppercase tracking-[0.22em] text-primary">
                Collectible holographic card
              </span>
              <span className="flex items-center gap-1.5 font-sans text-xs text-foreground transition-transform group-hover:translate-x-0.5">
                <span>Open card view</span>
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </span>
            </Link>
            <Link
              href={`/fighters/compare?a=${slug}`}
              prefetch={false}
              className="group flex flex-wrap items-center justify-between gap-3 rounded-md border border-foreground/15 bg-foreground/[0.02] px-4 py-3 transition-colors hover:border-foreground/35 hover:bg-foreground/[0.05]"
            >
              <span className="flex items-center gap-2 font-sans text-[11px] uppercase tracking-[0.22em] text-foreground-muted">
                <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
                Compare with another fighter
              </span>
              <span className="flex items-center gap-1.5 font-sans text-xs text-foreground transition-transform group-hover:translate-x-0.5">
                <span>Open compare</span>
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </span>
            </Link>
          </div>
        </Container>

        <Section
          label="Career timeline"
          explainer="Each dot is a fight — green wins, red losses, larger dots are title fights. Hover for details, click to open the bout."
          className="mt-16 sm:mt-20"
        >
          <CareerTimeline bouts={timelineBouts} />
        </Section>

        <Section
          label="Key stats"
          explainer="Six attributes derived from striking, grappling, and finishing rates."
          className="mt-16 sm:mt-20"
        >
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-16">
            <div className="flex flex-col items-center lg:items-start">
              <RadarChart attributes={attributes} />
              <p className="mt-4 max-w-sm text-center font-sans text-[11px] text-foreground-subtle lg:text-left">
                Fighters with sparse method data (older bouts) will read lower
                on Power and Cardio.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <div>
                <h3 className="mb-3 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
                  Physical
                </h3>
                <PhysicalInfo fighter={fighter} />
              </div>
              <div>
                <h3 className="mb-3 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
                  Career overview
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
          label="Striking heatmap"
          explainer="Significant strikes by target zone, aggregated across all UFC rounds."
          className="mt-16 sm:mt-20"
        >
          <StrikingHeatmap boutRounds={boutRounds} />
        </Section>

        <Section
          label="Round-by-round averages"
          explainer="Average values per round across the selected fights — toggle metrics below."
          className="mt-16 sm:mt-20"
        >
          <RoundByRoundChart boutRounds={boutRounds} />
        </Section>

        <Section
          label="Fight history"
          explainer="Career UFC bouts in reverse chronological order."
          className="mt-16 sm:mt-20"
        >
          <FightHistoryList history={history} />
        </Section>

        <Section
          label="Similar fighters"
          explainer="Closest stylistic matches by inverse-Euclidean similarity over striking and grappling rates."
          className="mt-16 pb-20 sm:mt-20"
        >
          <SimilarFighters fighters={similar} />
        </Section>
      </main>
      <Footer />
    </>
  );
}
