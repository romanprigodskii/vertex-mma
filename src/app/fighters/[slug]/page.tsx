import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { CareerOverview } from "@/components/fighter/detail/CareerOverview";
import { CareerTimeline } from "@/components/fighter/detail/CareerTimeline";
import { FightHistoryList } from "@/components/fighter/detail/FightHistoryList";
import { FighterHero } from "@/components/fighter/detail/FighterHero";
import { PhysicalInfo } from "@/components/fighter/detail/PhysicalInfo";
import { RadarChart } from "@/components/fighter/detail/RadarChart";
import { RoundByRoundChart } from "@/components/fighter/detail/RoundByRoundChart";
import { SimilarFighters } from "@/components/fighter/detail/SimilarFighters";
import { StrikingHeatmap } from "@/components/fighter/detail/StrikingHeatmap";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { CHAMPION_BY_SLUG } from "@/lib/champions";
import { computeAttributes } from "@/lib/fighter-attributes";
import {
  getFightHistory,
  getFighterBoutRounds,
  getFighterBySlug,
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
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <Container size="xl">
        <header className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
            {title}
          </h2>
          {description ? (
            <p className="font-sans text-[11px] text-foreground-subtle">
              {description}
            </p>
          ) : null}
        </header>
        {children}
      </Container>
    </section>
  );
}

export default async function FighterDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const fighter = await getFighterBySlug(slug);
  if (!fighter) notFound();

  const [boutRounds, history, similar] = await Promise.all([
    getFighterBoutRounds(fighter.id),
    getFightHistory(fighter.id),
    getSimilarFighters(fighter),
  ]);

  const championEntry = CHAMPION_BY_SLUG.get(slug) ?? null;
  const attributes = computeAttributes(fighter);

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

        {/* Collectible card CTA */}
        <Container size="xl" className="pt-6">
          <Link
            href={`/fighters/${slug}/card`}
            prefetch={false}
            className={
              "group flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/[0.04] px-4 py-3 transition-colors hover:border-primary/55 hover:bg-primary/[0.08]"
            }
          >
            <span className="font-sans text-[11px] uppercase tracking-[0.22em] text-primary">
              Collectible holographic card
            </span>
            <span className="flex items-center gap-1.5 font-sans text-xs text-foreground transition-transform group-hover:translate-x-0.5">
              <span>Open card view</span>
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </span>
          </Link>
        </Container>

        <Section title="Key stats" className="py-10 md:py-14">
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-16">
            <div className="flex flex-col items-center lg:items-start">
              <RadarChart attributes={attributes} />
              <p className="mt-4 max-w-sm text-center font-sans text-[11px] text-foreground-subtle lg:text-left">
                Attributes derived from striking/grappling rates, UFC method
                breakdown, and bout count. Fighters with sparse method data
                (older bouts) will read lower on Power and Cardio.
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
        </Section>

        <Section
          title="Striking heatmap"
          description="Aggregated significant strikes by target zone across all recorded rounds."
          className="border-t border-foreground/[0.06] py-10 md:py-14"
        >
          <StrikingHeatmap boutRounds={boutRounds} />
        </Section>

        <Section
          title="Round-by-round averages"
          className="border-t border-foreground/[0.06] py-10 md:py-14"
        >
          <RoundByRoundChart boutRounds={boutRounds} />
        </Section>

        <Section
          title="Career timeline"
          className="border-t border-foreground/[0.06] py-10 md:py-14"
        >
          <CareerTimeline history={history} />
        </Section>

        <Section
          title="Similar fighters"
          description="Cosine similarity over striking + grappling rate vector, same weight class."
          className="border-t border-foreground/[0.06] py-10 md:py-14"
        >
          <SimilarFighters fighters={similar} />
        </Section>

        <Section
          title="Fight history"
          className="border-t border-foreground/[0.06] py-10 pb-16 md:py-14 md:pb-20"
        >
          <FightHistoryList history={history} />
        </Section>
      </main>
      <Footer />
    </>
  );
}
