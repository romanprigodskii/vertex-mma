import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { BoutDecisionBanner } from "@/components/bout/BoutDecisionBanner";
import { BoutHero } from "@/components/bout/BoutHero";
import { BoutRoundBreakdown } from "@/components/bout/BoutRoundBreakdown";
import { BoutScorecards } from "@/components/bout/BoutScorecards";
import { BoutModelVerdict } from "@/components/bout/BoutModelVerdict";
import { BoutSimulationPanel } from "@/components/bout/BoutSimulationPanel";
import { BoutStrikeAnalysis } from "@/components/bout/BoutStrikeAnalysis";
import { BoutTotals } from "@/components/bout/BoutTotals";
import { BoutVideos } from "@/components/bout/BoutVideos";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { ShareButton } from "@/components/share/share-button";
import { Link } from "@/i18n/navigation";
import {
  computeFighterPositionMap,
  computeFighterStrikeMap,
  getBoutById,
} from "@/lib/bout-detail";
import { getBoutSimulation } from "@/lib/bout-simulation";
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; locale: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id, locale } = await params;
  const bout = await getBoutById(id);
  if (!bout) {
    const tNF = await getTranslations({ locale, namespace: "notFound" });
    return { title: tNF("boutTitle") };
  }
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
  const { id, locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("bout");
  const tWeight = await getTranslations("weight");
  const bout = await getBoutById(id);
  if (!bout) notFound();

  // tWeight.has() guards against custom strings like a hand-typed
  // catchweight that aren't in our enum; fall back to the raw value.
  const weightLabel = tWeight.has(bout.weight_class)
    ? tWeight(bout.weight_class)
    : bout.weight_class;
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

  // Phase 1 ML simulation. Upcoming bouts get the full predicted-winner panel.
  // Completed bouts instead get a compact "how the model called it" verdict
  // (predicted winner + hit/miss) so the prediction loop visibly closes —
  // accountability, not second-guessing.
  const isUpcoming = bout.status !== "completed";
  const simulation = await getBoutSimulation(bout.id);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="flex items-center justify-between py-3">
            <Link
              href={backHref}
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted transition-colors hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              {t("back")}
            </Link>
            <ShareButton
              url={`/bouts/${bout.id}`}
              ogImageUrl={`/api/og/bouts/${bout.id}`}
              title={`${bout.fighter_a.name_en} vs ${bout.fighter_b.name_en} · Vertex MMA`}
              filename={`vertexmma-bout-${bout.id.slice(0, 8)}`}
              label={t("shareLabel")}
              variant="icon"
            />
          </Container>
        </div>

        <Container size="xl">
          <BoutHero bout={bout} weightLabel={weightLabel} />
        </Container>

        {simulation && isUpcoming ? (
          <Container size="xl" className="pt-4">
            <BoutSimulationPanel bout={bout} sim={simulation} />
          </Container>
        ) : null}

        {simulation && !isUpcoming && bout.winner_id ? (
          <Container size="xl" className="pt-4">
            <BoutModelVerdict bout={bout} sim={simulation} />
          </Container>
        ) : null}

        <BoutDecisionBanner bout={bout} />

        <BoutVideos videos={bout.videos} />

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
              {t("roundByRound")}
            </h2>
            <BoutRoundBreakdown bout={bout} />
          </Container>
        </section>

        {bout.rounds.length > 0 ? (
          <section className="border-t border-foreground/10 py-10 md:py-12">
            <Container size="xl">
              <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
                {t("totals")}
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
