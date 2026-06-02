import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { CardShare } from "@/components/fighter/card/CardShare";
import {
  type CardLabels,
  HolographicCard,
} from "@/components/fighter/card/HolographicCard";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Link } from "@/i18n/navigation";
import { CHAMPION_BY_SLUG } from "@/lib/champions";
import { ATTRIBUTE_KEYS, computeAttributes } from "@/lib/fighter-attributes";
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
  const { slug, locale } = await params;
  const fighter = await getFighterBySlug(slug);
  if (!fighter) notFound();

  const history = await getFightHistory(fighter.id);
  const championEntry = CHAMPION_BY_SLUG.get(slug) ?? null;
  const attributes = computeAttributes(fighter);

  const t = await getTranslations({ locale, namespace: "fighter" });
  const tAttr = await getTranslations({ locale, namespace: "fighter.attribute" });
  const tWeight = await getTranslations({ locale, namespace: "weight" });

  // All card-face strings resolved server-side and threaded into the client
  // component (it can't use hooks for these), reusing the shared attribute and
  // weight-class namespaces.
  const labels: CardLabels = {
    tierChampion: t("cardTierChampion"),
    tierElite: t("cardTierElite"),
    tierRoster: t("cardTierRoster"),
    tierInterim: t("cardTierInterim"),
    attributes: Object.fromEntries(
      ATTRIBUTE_KEYS.map((k) => [k, tAttr(k)]),
    ) as Record<string, string>,
    weightLabel: fighter.weight_class_primary
      ? tWeight(fighter.weight_class_primary)
      : null,
    attributesHeading: t("cardAttributesHeading"),
    ufcCareer: t("cardUfcCareer"),
    record: t("cardRecordLabel"),
    lastLabel: t("cardLast", { n: Math.min(history.length, 5) }),
    ko: t("cardKo"),
    sub: t("cardSub"),
    dec: t("cardDec"),
    ariaFlip: t("cardAriaFlip", { name: fighter.name_en }),
  };

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
              {t("cardBackTo", { name: fighter.name_en })}
            </Link>
          </Container>
        </div>

        <section className="py-10 md:py-16">
          <Container
            size="xl"
            className="flex flex-col items-center gap-6 md:gap-8"
          >
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-foreground-subtle">
              {t("cardCollectible")}
            </p>

            <HolographicCard
              fighter={fighter}
              championEntry={championEntry}
              attributes={attributes}
              recentHistory={history}
              labels={labels}
            />

            <div className="flex flex-col items-center gap-3">
              <p className="font-sans text-xs text-foreground-muted">
                {t("cardFlipHint")}
              </p>
              <CardShare
                fighterSlug={slug}
                shareUrlText={t("cardShareText", { name: fighter.name_en })}
                shareButtonLabel={t("cardShareButton")}
              />
            </div>
          </Container>
        </section>
      </main>
      <Footer />
    </>
  );
}
