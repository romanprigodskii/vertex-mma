import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { CardShare } from "@/components/fighter/card/CardShare";
import { HolographicCard } from "@/components/fighter/card/HolographicCard";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Link } from "@/i18n/navigation";
import { CHAMPION_BY_SLUG } from "@/lib/champions";
import { computeAttributes } from "@/lib/fighter-attributes";
import { getFightHistory, getFighterBySlug } from "@/lib/fighter-detail";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string; locale: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug, locale } = await params;
  const t = await getTranslations({ locale, namespace: "fighter" });
  const fighter = await getFighterBySlug(slug);
  if (!fighter) return { title: t("cardNotFound") };
  return {
    title: t("cardMetaTitle", { name: fighter.name_en }),
    description: t("cardMetaDescription", { name: fighter.name_en }),
    openGraph: {
      title: t("cardOgTitle", { name: fighter.name_en }),
      description: t("cardOgDescription", { name: fighter.name_en }),
      images: fighter.photo_url ? [fighter.photo_url] : [],
    },
  };
}

export default async function FighterCardPage({ params }: PageProps) {
  const { slug } = await params;
  const fighter = await getFighterBySlug(slug);
  if (!fighter) notFound();

  const history = await getFightHistory(fighter.id);
  const championEntry = CHAMPION_BY_SLUG.get(slug) ?? null;
  const attributes = computeAttributes(fighter);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href={`/fighters/${slug}`}
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted transition-colors hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              Back to {fighter.name_en}
            </Link>
          </Container>
        </div>

        <section className="py-10 md:py-16">
          <Container
            size="xl"
            className="flex flex-col items-center gap-6 md:gap-8"
          >
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-foreground-subtle">
              Vertex · Collectible Card
            </p>

            <HolographicCard
              fighter={fighter}
              championEntry={championEntry}
              attributes={attributes}
              recentHistory={history}
            />

            <div className="flex flex-col items-center gap-3">
              <p className="font-sans text-xs text-foreground-muted">
                <span className="text-foreground">Click</span> to flip ·{" "}
                <span className="text-foreground">Move mouse</span> over the card
                to tilt
              </p>
              <CardShare
                fighterName={fighter.name_en}
                fighterSlug={slug}
              />
            </div>
          </Container>
        </section>
      </main>
      <Footer />
    </>
  );
}
