import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { CommonOpponents } from "@/components/compare/CommonOpponents";
import { CompareHero } from "@/components/compare/CompareHero";
import { CompareSection } from "@/components/compare/CompareSection";
import {
  AttributesTable,
  FinishingCompare,
  GrapplingCompare,
  StrikingCompare,
} from "@/components/compare/CompareStatGroups";
import { FighterPicker } from "@/components/compare/FighterPicker";
import { OverlapRadar } from "@/components/compare/OverlapRadar";
import { TaleOfTheTape } from "@/components/compare/TaleOfTheTape";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { CHAMPION_BY_SLUG } from "@/lib/champions";
import { getCommonOpponents } from "@/lib/compare-fighters";
import { computeAttributes } from "@/lib/fighter-attributes";
import { getFighterBySlug } from "@/lib/fighter-detail";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Compare fighters",
  description:
    "Side-by-side comparison of two UFC fighters — tale of the tape, striking and grappling stats, common opponents.",
  openGraph: {
    title: "Compare fighters · Vertex MMA",
    description:
      "Side-by-side comparison of two UFC fighters — tale of the tape, striking and grappling stats, common opponents.",
    type: "website",
  },
};

interface PageProps {
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

export default async function ComparePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const slugA = readSlug(params, "a");
  const slugB = readSlug(params, "b");

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
                Back to roster
              </Link>
            </Container>
          </div>

          <section className="border-b border-foreground/10">
            <Container size="xl" className="py-10 md:py-14">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
                Side-by-side
              </p>
              <h1
                className="mt-3 font-display uppercase tracking-tight text-foreground leading-[0.9]"
                style={{ fontSize: "clamp(48px, 7vw, 96px)" }}
              >
                Compare fighters
              </h1>
              <p className="mt-4 max-w-xl font-sans text-sm text-foreground-muted">
                Pick two UFC fighters and compare their tale of the tape,
                striking and grappling output, finishing rates, and any common
                opponents they share.
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
                  {slugA && !fighterA ? `"${slugA}" not in roster. ` : ""}
                  {slugB && !fighterB ? `"${slugB}" not in roster.` : ""}
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
  const common = await getCommonOpponents(fighterA.id, fighterB.id);

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
              Back to roster
            </Link>
          </Container>
        </div>

        <section className="pt-6 md:pt-8">
          <Container size="xl" className="mb-8 md:mb-12">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              Side-by-side
            </p>
            <h1
              className="mt-2 font-display uppercase tracking-tight text-foreground leading-[0.9]"
              style={{ fontSize: "clamp(36px, 5vw, 72px)" }}
            >
              Compare fighters
            </h1>
          </Container>

          {/* Cinematic banner: spans the full viewport width so the photos
              bleed edge-to-edge. The banner has its own top + bottom fade to
              background, so it sits flush against the next section without a
              visible seam. */}
          <CompareHero
            a={fighterA}
            b={fighterB}
            championA={championA}
            championB={championB}
          />
        </section>

        <CompareSection
          label="Tale of the tape"
          explainer="Physical and career roll-up — leader for each measurable shown in green."
        >
          <TaleOfTheTape a={fighterA} b={fighterB} />
        </CompareSection>

        <CompareSection
          label="Attributes"
          explainer="Six-attribute radar derived from striking, grappling, and finishing rates."
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
          label="Striking"
          explainer="Per-minute output, accuracy, and defense from UFCStats."
        >
          <StrikingCompare a={fighterA} b={fighterB} />
        </CompareSection>

        <CompareSection
          label="Grappling"
          explainer="Takedown and submission rates per 15 minutes of fight time."
        >
          <GrapplingCompare a={fighterA} b={fighterB} />
        </CompareSection>

        <CompareSection
          label="Finishing"
          explainer="UFC win breakdown — KO/TKO and submission counts and overall finish rate."
        >
          <FinishingCompare a={fighterA} b={fighterB} />
        </CompareSection>

        <CompareSection
          label="Common opponents"
          explainer="UFC fighters both have faced. Most recent meeting for each."
          meta={
            common.length > 0
              ? `${common.length} shared opponent${common.length === 1 ? "" : "s"}`
              : null
          }
          className="pb-16 sm:pb-20"
        >
          <CommonOpponents
            entries={common}
            fighterAName={fighterA.name_en}
            fighterBName={fighterB.name_en}
          />
        </CompareSection>
      </main>
      <Footer />
    </>
  );
}
