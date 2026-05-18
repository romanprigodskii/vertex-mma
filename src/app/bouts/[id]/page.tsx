import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { BoutDecisionBanner } from "@/components/bout/BoutDecisionBanner";
import { BoutHero } from "@/components/bout/BoutHero";
import { BoutRoundBreakdown } from "@/components/bout/BoutRoundBreakdown";
import { BoutScorecards } from "@/components/bout/BoutScorecards";
import { BoutStrikeAnalysis } from "@/components/bout/BoutStrikeAnalysis";
import { BoutTotals } from "@/components/bout/BoutTotals";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import {
  computeFighterPositionMap,
  computeFighterStrikeMap,
  getBoutById,
} from "@/lib/bout-detail";
import { WEIGHT_CLASSES } from "@/lib/constants";

export const dynamic = "force-dynamic";

const WEIGHT_LABEL: Record<string, string> = Object.fromEntries(
  WEIGHT_CLASSES.map((w) => [w.id, w.label]),
);
WEIGHT_LABEL["catchweight"] = "Catchweight";
WEIGHT_LABEL["openweight"] = "Openweight";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  const bout = await getBoutById(id);
  if (!bout) return { title: "Bout not found" };
  const title = `${bout.fighter_a.name_en} vs ${bout.fighter_b.name_en}`;
  const eventLabel = bout.event.short_name || bout.event.name;
  const desc = `${title} — ${eventLabel}.`;
  const ogImage = `/api/og/bouts/${bout.id}`;
  return {
    title,
    description: desc,
    openGraph: {
      title,
      description: eventLabel,
      siteName: "Vertex MMA",
      type: "article",
      images: [
        {
          url: ogImage,
          width: 1200,
          height: 630,
          alt: `${title} — fight details`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      images: [ogImage],
    },
  };
}

export default async function BoutDetailPage({ params }: PageProps) {
  const { id } = await params;
  const bout = await getBoutById(id);
  if (!bout) notFound();

  const weightLabel =
    WEIGHT_LABEL[bout.weight_class] ?? bout.weight_class;
  const backHref = `/events/${bout.event.slug}#bout-${bout.id}`;

  // Wave 32: pre-compute every map server-side so the client tabs only
  // toggle visibility — no re-fetch on switch.
  const landedA = computeFighterStrikeMap(bout.rounds, bout.fighter_a.id);
  const landedB = computeFighterStrikeMap(bout.rounds, bout.fighter_b.id);
  // Absorbed by A = strikes LANDED by B against A (and vice versa).
  const absorbedA = computeFighterStrikeMap(bout.rounds, bout.fighter_b.id);
  const absorbedB = computeFighterStrikeMap(bout.rounds, bout.fighter_a.id);
  const positionA = computeFighterPositionMap(bout.rounds, bout.fighter_a.id);
  const positionB = computeFighterPositionMap(bout.rounds, bout.fighter_b.id);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href={backHref}
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted transition-colors hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              Back to event
            </Link>
          </Container>
        </div>

        <Container size="xl">
          <BoutHero bout={bout} weightLabel={weightLabel} />
        </Container>

        <BoutDecisionBanner bout={bout} />

        {bout.rounds.length > 0 ? (
          <BoutStrikeAnalysis
            fighterA={bout.fighter_a}
            fighterB={bout.fighter_b}
            landedA={landedA}
            landedB={landedB}
            absorbedA={absorbedA}
            absorbedB={absorbedB}
            positionA={positionA}
            positionB={positionB}
          />
        ) : null}

        <section className="border-t border-foreground/10 py-10 md:py-12">
          <Container size="xl">
            <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              Round-by-round
            </h2>
            <BoutRoundBreakdown bout={bout} />
          </Container>
        </section>

        {bout.rounds.length > 0 ? (
          <section className="border-t border-foreground/10 py-10 md:py-12">
            <Container size="xl">
              <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
                Totals
              </h2>
              <BoutTotals bout={bout} />
            </Container>
          </section>
        ) : null}

        {bout.scorecards.length > 0 ? (
          <section className="border-t border-foreground/10 py-10 md:py-12">
            <Container size="xl">
              <BoutScorecards
                scorecards={bout.scorecards}
                fighterAName={bout.fighter_a.name_en}
                fighterBName={bout.fighter_b.name_en}
                fighterAId={bout.fighter_a.id}
                winnerId={bout.winner_id}
              />
            </Container>
          </section>
        ) : null}
      </main>
      <Footer />
    </>
  );
}
